package rootfs

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

// TestDirTreeChanges checks each change a container makes to a volume
// against the directory on the host: a file made, written at an offset,
// cut short, given a mode, renamed over another, linked to and removed,
// and a directory made and removed. The tree is a temporary directory.
func TestDirTreeChanges(t *testing.T) {
	dir := t.TempDir()
	tree, err := OpenDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer tree.Close()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	onHost := func(name string) string {
		t.Helper()
		content, err := os.ReadFile(filepath.Join(dir, name))
		must(err)
		return string(content)
	}

	// A file, written in two pieces, the second past the first.
	must(tree.Create("/notes", 0o640))
	if err := tree.Create("/notes", 0o640); !errors.Is(err, fs.ErrExist) {
		t.Errorf("a second create: %v", err)
	}
	count, err := tree.Write("/notes", 0, []byte("hello"))
	if err != nil || count != 5 {
		t.Fatalf("write: %d, %v", count, err)
	}
	_, err = tree.Write("/notes", 5, []byte(", volume"))
	must(err)
	if got := onHost("notes"); got != "hello, volume" {
		t.Errorf("on the host: %q", got)
	}

	// Its size and mode.
	size, mode := int64(5), uint32(0o600)
	must(tree.SetAttr("/notes", SetAttr{Size: &size, Mode: &mode}))
	attr, err := tree.Attr("/notes")
	must(err)
	if attr.Size != 5 || attr.Mode != 0o600 || onHost("notes") != "hello" {
		t.Errorf("after the change: %+v, %q", attr, onHost("notes"))
	}

	// A directory, a rename into it, and a link.
	must(tree.Mkdir("/sub", 0o755))
	must(tree.Rename("/notes", "/sub/moved"))
	must(tree.Symlink("/sub/link", "moved"))
	if target, err := tree.Link("/sub/link"); err != nil || target != "moved" {
		t.Errorf("the link: %q, %v", target, err)
	}
	if onHost("sub/moved") != "hello" {
		t.Error("the renamed file lost its content")
	}

	// Removal insists on the kind, and a directory on being empty.
	if err := tree.Remove("/sub", false); err == nil {
		t.Error("a directory was removed as a file")
	}
	if err := tree.Remove("/sub", true); err == nil {
		t.Error("a directory that is not empty was removed")
	}
	must(tree.Remove("/sub/link", false))
	must(tree.Remove("/sub/moved", false))
	must(tree.Remove("/sub", true))
	if _, err := os.Stat(filepath.Join(dir, "sub")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("the directory is still on the host: %v", err)
	}
}

// TestHandlerChanges checks changes as the page sends them, and that a
// handler told its tree is read-only refuses each with the errno a
// read-only file system gives. One server stands in for a volume and
// one for an image, over the same directory.
func TestHandlerChanges(t *testing.T) {
	dir := t.TempDir()
	tree, err := OpenDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer tree.Close()

	post := func(handler Handler, op string, params url.Values, body []byte) (int, map[string]any) {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/vol/"+op+"?"+params.Encode(), bytes.NewReader(body))
		handler.Serve(recorder, request, op)
		var answer map[string]any
		json.NewDecoder(recorder.Body).Decode(&answer)
		return recorder.Code, answer
	}
	volume := Handler{Tree: tree, Writable: true}
	image := Handler{Tree: tree}

	// A volume takes a file and a write.
	if status, _ := post(volume, OpCreate, url.Values{"p": {"/f"}, "m": {"644"}}, nil); status != http.StatusOK {
		t.Fatalf("create: %d", status)
	}
	status, answer := post(volume, OpWrite, url.Values{"p": {"/f"}, "o": {"0"}}, []byte("data"))
	if status != http.StatusOK || answer["written"] != float64(4) {
		t.Errorf("write: %d %v", status, answer)
	}
	if content, _ := os.ReadFile(filepath.Join(dir, "f")); string(content) != "data" {
		t.Errorf("on the host: %q", content)
	}

	// An image takes neither, and a volume takes no path that leaves it.
	status, answer = post(image, OpWrite, url.Values{"p": {"/f"}, "o": {"0"}}, []byte("x"))
	if status != http.StatusForbidden || answer["code"] != codeReadOnly {
		t.Errorf("a write to an image: %d %v", status, answer)
	}
	status, answer = post(volume, OpCreate, url.Values{"p": {"/../escaped"}, "m": {"644"}}, nil)
	if status == http.StatusOK {
		t.Errorf("a create outside the volume: %d %v", status, answer)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "escaped")); err == nil {
		t.Error("a file was made outside the volume")
	}
}

// TestHardlink checks the hard link a package manager makes to put a
// file in place without replacing one that is there (uv's lock, cargo's
// and npm's caches): a second name for the same file, refused over a
// name that is taken, for a directory, out of the volume, and on a
// read-only tree.
func TestHardlink(t *testing.T) {
	dir := t.TempDir()
	tree, err := OpenDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer tree.Close()
	if err := os.WriteFile(filepath.Join(dir, "tmp-123"), []byte("lock"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := tree.Hardlink("/tmp-123", "/lock"); err != nil {
		t.Fatalf("hardlink: %v", err)
	}
	first, _ := os.Stat(filepath.Join(dir, "tmp-123"))
	second, _ := os.Stat(filepath.Join(dir, "lock"))
	if !os.SameFile(first, second) {
		t.Error("the two names are not one file")
	}
	if attr, _ := tree.Attr("/lock"); attr.Nlink != 2 {
		t.Errorf("link count: %d", attr.Nlink)
	}
	if err := tree.Hardlink("/tmp-123", "/lock"); !errors.Is(err, fs.ErrExist) {
		t.Errorf("a link over a taken name: %v", err)
	}
	if err := os.Mkdir(filepath.Join(dir, "d"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := tree.Hardlink("/d", "/d2"); err == nil {
		t.Error("a hard link to a directory was made")
	}

	post := func(handler Handler, params url.Values) int {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/vol/"+OpHardlink+"?"+params.Encode(), nil)
		handler.Serve(recorder, request, OpHardlink)
		return recorder.Code
	}
	volume := Handler{Tree: tree, Writable: true}
	if status := post(volume, url.Values{"p": {"/again"}, "t": {"/tmp-123"}}); status != http.StatusOK {
		t.Errorf("hardlink through the handler: %d", status)
	}
	outside := filepath.Join(filepath.Dir(dir), "secret")
	if err := os.WriteFile(outside, []byte("host"), 0o644); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(outside)
	if status := post(volume, url.Values{"p": {"/stolen"}, "t": {"/../secret"}}); status == http.StatusOK {
		t.Error("a link to a file outside the volume was made")
	}
	if status := post(Handler{Tree: tree}, url.Values{"p": {"/ro"}, "t": {"/tmp-123"}}); status != http.StatusForbidden {
		t.Errorf("a link on a read-only tree: %d", status)
	}
}

// TestHardlinkOnlyToRegularFile checks that a hard link is made to a
// regular file and to nothing else. The volume holds a symbolic link
// that points at a file outside the volume; a hard link to that
// symbolic link has to be refused, leave no new name behind, and leave
// the outside file with the one name it had.
func TestHardlinkOnlyToRegularFile(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "volume")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(base, "secret")
	if err := os.WriteFile(outside, []byte("host"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../secret", filepath.Join(dir, "pointer")); err != nil {
		t.Fatal(err)
	}
	tree, err := OpenDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer tree.Close()

	if err := tree.Hardlink("/pointer", "/copy"); !errors.Is(err, fs.ErrPermission) {
		t.Errorf("a hard link to a symbolic link: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "copy")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("the refused link left a name behind: %v", err)
	}
	outsideInfo, err := os.Stat(outside)
	if err != nil {
		t.Fatal(err)
	}
	if attr, known := attrOf(outsideInfo); !known || attr.Nlink != 1 {
		t.Errorf("the file outside the volume has %d names", attr.Nlink)
	}
}
