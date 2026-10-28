package domain

import "testing"

func TestFileValidateUpload(t *testing.T) {
	tests := []struct {
		name  string
		file  File
		valid bool
	}{
		{"one chunk", File{TotalSize: 100, ChunkSize: FileChunkSize, ChunkTotal: 1}, true},
		{"exact chunks", File{TotalSize: 2 * FileChunkSize, ChunkSize: FileChunkSize, ChunkTotal: 2}, true},
		{"old client: one chunk more", File{TotalSize: 2 * FileChunkSize, ChunkSize: FileChunkSize, ChunkTotal: 3}, true},
		{"max size", File{TotalSize: MaxFileSize, ChunkSize: FileChunkSize, ChunkTotal: MaxFileSize / FileChunkSize}, true},
		{"empty", File{TotalSize: 0, ChunkSize: FileChunkSize, ChunkTotal: 0}, false},
		{"negative size", File{TotalSize: -1, ChunkSize: FileChunkSize, ChunkTotal: 1}, false},
		{"too large", File{TotalSize: MaxFileSize + 1, ChunkSize: FileChunkSize, ChunkTotal: MaxFileSize/FileChunkSize + 1}, false},
		{"negative chunk size", File{TotalSize: 100, ChunkSize: -1, ChunkTotal: 1}, false},
		{"huge chunk size", File{TotalSize: 100, ChunkSize: 1 << 40, ChunkTotal: 1}, false},
		{"too few chunks", File{TotalSize: 2 * FileChunkSize, ChunkSize: FileChunkSize, ChunkTotal: 1}, false},
		{"too many chunks", File{TotalSize: 100, ChunkSize: FileChunkSize, ChunkTotal: 1000}, false},
	}

	for _, tt := range tests {
		err := tt.file.ValidateUpload()
		if (err == nil) != tt.valid {
			t.Errorf("%s: ValidateUpload() = %v, want valid=%v", tt.name, err, tt.valid)
		}
	}
}

func TestFileChunkFits(t *testing.T) {
	f := File{TotalSize: 3 * FileChunkSize, ChunkSize: FileChunkSize, ChunkTotal: 3}

	tests := []struct {
		name   string
		index  int64
		length int
		fits   bool
	}{
		{"first", 0, int(FileChunkSize), true},
		{"last, short", 2, 10, true},
		{"negative index", -1, 10, false},
		{"index past end", 3, 10, false},
		{"huge index", 1 << 31, 10, false},
		{"chunk too long", 1, int(FileChunkSize) + 1, false},
	}

	for _, tt := range tests {
		got := f.ChunkFits(tt.index, tt.length)
		if got != tt.fits {
			t.Errorf("%s: ChunkFits(%d, %d) = %v, want %v", tt.name, tt.index, tt.length, got, tt.fits)
		}
	}
}
