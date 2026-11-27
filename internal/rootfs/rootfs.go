// Package rootfs serves a container's root file system to the page over
// HTTP. A page cannot read the host's disk, and the guest's file system
// is a JavaScript object on the page answering the guest's lookups, so
// each lookup becomes a request here: a path's attributes, a
// directory's entries, a link's target, or a range of a file's bytes.
//
// The files come from a Tree, of which there are two: a directory on
// the host, which is what an engine unpacks an image into (dir.go), and
// an image's layers read in place as tar files (layers.go).
//
// The guest resolves symbolic links itself, one path component at a
// time, so every path that arrives names its target directly, and no
// Tree follows a link.
package rootfs

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
	"syscall"
)

// The operations, as the last element of the request's path.
const (
	OpAttr = "attr"
	OpDir  = "dir"
	OpLink = "link"
	OpRead = "read"
)

// The request's parameters: the path in the container, and for a read
// the offset and the length.
const (
	paramPath   = "p"
	paramOffset = "o"
	paramLength = "n"
)

// The kinds of file the guest's file system interface knows. Devices,
// sockets and pipes have no kind there and are left out: a container
// image carries none that matter, and the guest makes its own /dev.
const (
	TypeFile    = "file"
	TypeDir     = "dir"
	TypeSymlink = "symlink"
)

// The error names the page hands on to the guest as errno values.
const (
	codeNotFound = "ENOENT"
	codeAccess   = "EACCES"
	codeNotDir   = "ENOTDIR"
	codeIsDir    = "EISDIR"
	codeInvalid  = "EINVAL"
	codeIO       = "EIO"
	codeReadOnly = "EROFS"
	codeExists   = "EEXIST"
	codeNotEmpty = "ENOTEMPTY"
	// A hard link across file systems, or to a file with too many: a
	// tool that copies when it cannot link needs to be told which.
	codeCrossDevice  = "EXDEV"
	codeTooManyLinks = "EMLINK"
)

// maxRead is the most bytes one read returns. The guest's 9p client
// asks for at most 128 KiB at a time, so this only bounds a caller that
// asks for more.
const maxRead = 1 << 20

// permissionBits are the mode bits the guest is shown: the permissions
// with set-user-id, set-group-id and sticky.
const permissionBits = 0o7777

// Attr is a path's attributes as the page's file system returns them.
type Attr struct {
	Type    string `json:"type"`
	Mode    uint32 `json:"mode"`
	Size    int64  `json:"size"`
	UID     uint32 `json:"uid"`
	GID     uint32 `json:"gid"`
	Nlink   uint64 `json:"nlink"`
	MtimeMs int64  `json:"mtimeMs"`
	Ino     uint64 `json:"ino"`
}

// Entry is one name in a directory, with everything a lookup of that
// name would ask next: its attributes, and a symbolic link's target.
// An image does not change under a running container, so the page
// keeps each listing and answers the guest's later lookups in that
// directory, the ones for names that are not there included, without
// asking again.
type Entry struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	Ino    uint64 `json:"ino"`
	Attr   Attr   `json:"attr"`
	Target string `json:"target,omitempty"`
}

// Tree is a root file system. Every path is the container's own:
// absolute, "/" for the root. A path that is not there is
// fs.ErrNotExist.
type Tree interface {
	// Attr returns a path's attributes, without following a link.
	Attr(path string) (Attr, error)
	// Dir returns a directory's entries.
	Dir(path string) ([]Entry, error)
	// Link returns a symbolic link's target.
	Link(path string) (string, error)
	// Read returns up to length bytes of a regular file from offset:
	// fewer at the file's end, none past it.
	Read(path string, offset, length int64) ([]byte, error)
	// Close releases the tree.
	Close() error
}

// failure is the body of an error response.
type failure struct {
	Code string `json:"code"`
}

// Handler answers the page's requests from a Tree.
type Handler struct {
	Tree Tree
	// Writable lets the page change the tree (write.go). An image's tree
	// is never writable; a volume's is unless it was mounted read-only.
	Writable bool
}

// Serve answers one operation, named by op.
func (h Handler) Serve(w http.ResponseWriter, r *http.Request, op string) {
	if h.change(w, r, op) {
		return
	}

	query := r.URL.Query()
	path := query.Get(paramPath)

	switch op {
	case OpAttr:
		attr, err := h.Tree.Attr(path)
		if err != nil {
			failWith(w, err)
			return
		}
		reply(w, attr)

	case OpDir:
		entries, err := h.Tree.Dir(path)
		if err != nil {
			failWith(w, err)
			return
		}
		reply(w, entries)

	case OpLink:
		target, err := h.Tree.Link(path)
		if err != nil {
			failWith(w, err)
			return
		}
		reply(w, map[string]string{"target": target})

	case OpRead:
		h.read(w, path, query.Get(paramOffset), query.Get(paramLength))

	default:
		fail(w, http.StatusNotFound, codeInvalid)
	}
}

// read answers a range of a regular file's bytes.
func (h Handler) read(w http.ResponseWriter, path, offsetText, lengthText string) {
	offset, err := strconv.ParseInt(offsetText, 10, 64)
	if err != nil || offset < 0 {
		fail(w, http.StatusBadRequest, codeInvalid)
		return
	}
	length, err := strconv.ParseInt(lengthText, 10, 64)
	if err != nil || length < 0 {
		fail(w, http.StatusBadRequest, codeInvalid)
		return
	}

	data, err := h.Tree.Read(path, offset, min(length, maxRead))
	if err != nil {
		failWith(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write(data)
}

// reply writes a JSON answer.
func reply(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(value)
}

// fail writes an error answer with the errno name the guest is given.
func fail(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(failure{Code: code})
}

// failWith writes the error answer for a file system error. A path that
// would leave the root reads as not found: to the guest nothing is
// there.
func failWith(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, syscall.ELOOP):
		fail(w, http.StatusNotFound, codeNotFound)
	case errors.Is(err, fs.ErrPermission):
		fail(w, http.StatusForbidden, codeAccess)
	case errors.Is(err, fs.ErrExist):
		fail(w, http.StatusConflict, codeExists)
	case errors.Is(err, syscall.ENOTEMPTY):
		fail(w, http.StatusConflict, codeNotEmpty)
	case errors.Is(err, syscall.ENOTDIR):
		fail(w, http.StatusBadRequest, codeNotDir)
	case errors.Is(err, syscall.EISDIR):
		fail(w, http.StatusBadRequest, codeIsDir)
	case errors.Is(err, fs.ErrInvalid), errors.Is(err, syscall.EINVAL):
		fail(w, http.StatusBadRequest, codeInvalid)
	case errors.Is(err, syscall.EXDEV):
		fail(w, http.StatusConflict, codeCrossDevice)
	case errors.Is(err, syscall.EMLINK):
		fail(w, http.StatusConflict, codeTooManyLinks)
	default:
		// os.Root reports an escape with an error of its own that names
		// no errno.
		if strings.Contains(err.Error(), "escapes") {
			fail(w, http.StatusNotFound, codeNotFound)
			return
		}
		fail(w, http.StatusInternalServerError, codeIO)
	}
}
