//go:build unix

package port

import "syscall"

// diskFree returns the free bytes for unprivileged users on the file system of dir.
func diskFree(dir string) (uint64, error) {
	var st syscall.Statfs_t
	err := syscall.Statfs(dir, &st)
	if err != nil {
		return 0, err
	}

	return st.Bavail * uint64(st.Bsize), nil //nolint:unconvert // Bsize is int32 on darwin, int64 on linux
}
