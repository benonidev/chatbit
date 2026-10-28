package port

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAssetHash(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) {
		t.Helper()
		path := filepath.Join(dir, name)
		err := os.MkdirAll(filepath.Dir(path), 0o755)
		if err != nil {
			t.Fatal(err)
		}
		err = os.WriteFile(path, []byte(content), 0o644)
		if err != nil {
			t.Fatal(err)
		}
	}
	hash := func() string {
		t.Helper()
		h, err := AssetHash(dir)
		if err != nil {
			t.Fatal(err)
		}
		return h
	}

	write("index.html", "<title>x</title>")
	write("assets/js/app.js", "let a = 1")
	first := hash()
	if len(first) != 64 || first != hash() {
		t.Fatalf("hash %q is not stable", first)
	}

	// Every byte and every path counts
	write("assets/js/app.js", "let a = 2")
	if hash() == first {
		t.Fatal("changed content, same hash")
	}
	write("assets/js/app.js", "let a = 1")
	if hash() != first {
		t.Fatal("same content, other hash")
	}
	write(".DS_Store", "finder")
	write("assets/.hidden/x", "y")
	if hash() != first {
		t.Fatal("hidden files changed the hash")
	}
	write("assets/js/extra.js", "")
	if hash() == first {
		t.Fatal("new file, same hash")
	}
}
