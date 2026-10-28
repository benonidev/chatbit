//go:build !unix

package port

import "math"

// diskFree is not implemented on this platform — the free space check is skipped.
func diskFree(string) (uint64, error) {
	return math.MaxUint64, nil
}
