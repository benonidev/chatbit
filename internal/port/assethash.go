package port

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// AssetHash is the fingerprint of the web app the server delivers: SHA-256 over every file of
// dir (sorted by path, one line "<path> <sha256 of the file>" each). index.html and
// service-worker.js count as they are on disk, before the build info is put in, hidden files do
// not count — so the same commit always gives the same hash and anyone can compare it with a
// release (chatbit -asset-hash).
func AssetHash(dir string) (string, error) {
	var paths []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// Hidden files (.DS_Store of the Finder, editor files) are not part of the app
		if path != dir && strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type().IsRegular() {
			paths = append(paths, path)
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("walk %s: %w", dir, err)
	}
	sort.Strings(paths)

	all := sha256.New()
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("read %s: %w", path, err)
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return "", err
		}
		sum := sha256.Sum256(data)
		fmt.Fprintf(all, "%s %s\n", strings.ReplaceAll(rel, string(filepath.Separator), "/"), hex.EncodeToString(sum[:]))
	}

	return hex.EncodeToString(all.Sum(nil)), nil
}
