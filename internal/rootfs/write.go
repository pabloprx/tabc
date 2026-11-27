package rootfs

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"syscall"
	"time"
)

// Changes. An image is only read, but a volume is a directory of the
// host that a container writes to, so a tree over a directory can be
// changed, and a Handler that is told it may passes the guest's changes
// on. Each change is one request, by path, as each lookup is.

// The operations that change a tree, as the last element of the
// request's path. All are POSTs.
const (
	OpCreate   = "create"
	OpWrite    = "write"
	OpMkdir    = "mkdir"
	OpRemove   = "remove"
	OpRename   = "rename"
	OpSetattr  = "setattr"
	OpSymlink  = "symlink"
	OpHardlink = "hardlink"
)

// The parameters of a change: a mode, whether a removal is of a
// directory, and the other path of a rename or the target of a link.
const (
	paramMode   = "m"
	paramIsDir  = "d"
	paramTarget = "t"
)

// maxWrite bounds one write. The guest's 9p client sends at most 128 KiB
// at a time.
const maxWrite = 4 << 20

// modeBase is the base a mode is written in, and modeBits its width.
const (
	modeBase = 8
	modeBits = 32
)

// SetAttr is what a change of attributes may change. A field left out
// is left alone.
type SetAttr struct {
	Mode    *uint32 `json:"mode,omitempty"`
	UID     *uint32 `json:"uid,omitempty"`
	GID     *uint32 `json:"gid,omitempty"`
	Size    *int64  `json:"size,omitempty"`
	MtimeMs *int64  `json:"mtimeMs,omitempty"`
	AtimeMs *int64  `json:"atimeMs,omitempty"`
}

// Create makes an empty regular file, and fails if the name is taken.
func (t *DirTree) Create(path string, mode uint32) error {
	file, err := t.root.OpenFile(relative(path), os.O_CREATE|os.O_EXCL|os.O_WRONLY, os.FileMode(mode&permissionBits))
	if err != nil {
		return err
	}
	return file.Close()
}

// Write writes data into a regular file at offset and returns how much
// was written.
func (t *DirTree) Write(path string, offset int64, data []byte) (int, error) {
	file, err := t.root.OpenFile(relative(path), os.O_WRONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	return file.WriteAt(data, offset)
}

// Mkdir makes a directory.
func (t *DirTree) Mkdir(path string, mode uint32) error {
	return t.root.Mkdir(relative(path), os.FileMode(mode&permissionBits))
}

// Remove removes a file or a link, or with isDir an empty directory.
// What is at the path has to be of the kind asked for, as unlink and
// rmdir each insist.
func (t *DirTree) Remove(path string, isDir bool) error {
	info, err := t.root.Lstat(relative(path))
	if err != nil {
		return err
	}
	if info.IsDir() != isDir {
		if isDir {
			return syscall.ENOTDIR
		}
		return syscall.EISDIR
	}
	return t.root.Remove(relative(path))
}

// Rename moves a file or directory, replacing what is at the new path.
func (t *DirTree) Rename(from, to string) error {
	return t.root.Rename(relative(from), relative(to))
}

// Hardlink makes path a new name for the regular file at target: a hard
// link, which a package manager makes to put a file in place without
// replacing what is already there. Both names are inside the tree, as
// os.Root insists.
func (t *DirTree) Hardlink(target, path string) error {
	// Only a regular file gets a second name, as link(2) refuses a
	// directory. A symbolic link is refused too: a hard link to a
	// symbolic link is a name no program asks for, and a host whose link
	// followed the symbolic link would name a file outside the tree.
	info, err := t.root.Lstat(relative(target))
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return syscall.EPERM
	}

	return t.root.Link(relative(target), relative(path))
}

// Symlink makes a symbolic link at path that points to target.
func (t *DirTree) Symlink(path, target string) error {
	return t.root.Symlink(target, relative(path))
}

// SetAttr changes a path's attributes. A change of owner that the
// supervisor's user may not make is let go: a container's root is not
// the host's, and a volume's files stay whoever's they are.
func (t *DirTree) SetAttr(path string, change SetAttr) error {
	name := relative(path)

	if change.Size != nil {
		file, err := t.root.OpenFile(name, os.O_WRONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		err = file.Truncate(*change.Size)
		file.Close()
		if err != nil {
			return err
		}
	}
	if change.Mode != nil {
		if err := t.root.Chmod(name, os.FileMode(*change.Mode&permissionBits)); err != nil {
			return err
		}
	}
	if change.UID != nil || change.GID != nil {
		uid, gid := -1, -1
		if change.UID != nil {
			uid = int(*change.UID)
		}
		if change.GID != nil {
			gid = int(*change.GID)
		}
		if err := t.root.Lchown(name, uid, gid); err != nil && !errors.Is(err, os.ErrPermission) {
			return err
		}
	}
	if change.MtimeMs != nil || change.AtimeMs != nil {
		var accessed, modified time.Time
		if change.AtimeMs != nil {
			accessed = time.UnixMilli(*change.AtimeMs)
		}
		if change.MtimeMs != nil {
			modified = time.UnixMilli(*change.MtimeMs)
		}
		if err := t.root.Chtimes(name, accessed, modified); err != nil {
			return err
		}
	}
	return nil
}

// Writer is a tree that can be changed.
type Writer interface {
	Create(path string, mode uint32) error
	Write(path string, offset int64, data []byte) (int, error)
	Mkdir(path string, mode uint32) error
	Remove(path string, isDir bool) error
	Rename(from, to string) error
	Symlink(path, target string) error
	Hardlink(target, path string) error
	SetAttr(path string, change SetAttr) error
}

// change answers one operation that changes the tree. It reports false
// for an operation that is not a change, which the caller answers as a
// read.
func (h Handler) change(w http.ResponseWriter, r *http.Request, op string) bool {
	switch op {
	case OpCreate, OpWrite, OpMkdir, OpRemove, OpRename, OpSetattr, OpSymlink, OpHardlink:
	default:
		return false
	}

	// A tree nobody may change answers every change the way a read-only
	// file system does.
	writer, canWrite := h.Tree.(Writer)
	if !h.Writable || !canWrite {
		fail(w, http.StatusForbidden, codeReadOnly)
		return true
	}
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, codeInvalid)
		return true
	}

	query := r.URL.Query()
	path := query.Get(paramPath)
	var err error
	switch op {
	case OpCreate:
		err = writer.Create(path, parseMode(query.Get(paramMode)))
	case OpMkdir:
		err = writer.Mkdir(path, parseMode(query.Get(paramMode)))
	case OpRemove:
		err = writer.Remove(path, query.Get(paramIsDir) == "1")
	case OpRename:
		err = writer.Rename(path, query.Get(paramTarget))
	case OpSymlink:
		err = writer.Symlink(path, query.Get(paramTarget))
	case OpHardlink:
		err = writer.Hardlink(query.Get(paramTarget), path)
	case OpSetattr:
		var change SetAttr
		if err = json.NewDecoder(r.Body).Decode(&change); err == nil {
			err = writer.SetAttr(path, change)
		}
	case OpWrite:
		var offset int64
		offset, err = strconv.ParseInt(query.Get(paramOffset), 10, 64)
		if err != nil || offset < 0 {
			fail(w, http.StatusBadRequest, codeInvalid)
			return true
		}
		var data []byte
		data, err = io.ReadAll(io.LimitReader(r.Body, maxWrite))
		if err == nil {
			var count int
			count, err = writer.Write(path, offset, data)
			if err == nil {
				reply(w, map[string]int{"written": count})
				return true
			}
		}
	}

	if err != nil {
		failWith(w, err)
		return true
	}
	reply(w, map[string]bool{"ok": true})
	return true
}

// parseMode reads a mode written in octal, and gives none for text that
// is not one.
func parseMode(text string) uint32 {
	mode, err := strconv.ParseUint(text, modeBase, modeBits)
	if err != nil {
		return 0
	}
	return uint32(mode)
}
