package domain

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/google/uuid"
)

// FileDir is the directory for uploaded (encrypted) files, one subdirectory per room.
// Relative to the working directory; overridden by the IMAGE_TMP_DIR environment variable.
var FileDir = "files"

type File struct {
	Message

	TotalSize  int64  `json:"totalSize"`
	ChunkTotal int64  `json:"chunksTotal"`
	ChunkSize  int64  `json:"chunkSize"`
	Chunks     int64  `json:"chunks"`
	MimeType   string `json:"mimeType"`
	SHA256     string `json:"sha256"`
}

// FileChunkSize is the chunk size of the client (CHUNK_SIZE in view_room.js)
const FileChunkSize = int64(64 * 1024)

// MaxFileSize limits an upload (encrypted size), set with MAX_FILE_SIZE_MB. Images are scaled
// down to 2560 px by the client, so this only matters for originals it could not scale (e.g. HEIC).
var MaxFileSize = int64(25 * 1024 * 1024)

var ErrInvalidFileHeader = errors.New("invalid file header")

// ValidateUpload checks the sizes a client sends with transfer_start. They are used for
// Truncate, WriteAt offsets and read buffers, so they must never be trusted unchecked.
func (m File) ValidateUpload() error {
	if m.TotalSize <= 0 || m.TotalSize > MaxFileSize {
		return ErrInvalidFileHeader
	}
	if m.ChunkSize != FileChunkSize {
		return ErrInvalidFileHeader
	}
	// Older clients sent the plain size, the encrypted data is up to one chunk longer
	minChunks := (m.TotalSize + m.ChunkSize - 1) / m.ChunkSize
	if m.ChunkTotal < minChunks || m.ChunkTotal > minChunks+1 {
		return ErrInvalidFileHeader
	}
	return nil
}

// ChunkFits reports whether a chunk with this index and length lies inside the announced file.
func (m File) ChunkFits(index int64, length int) bool {
	return index >= 0 && index < m.ChunkTotal && int64(length) <= m.ChunkSize
}

type Transfer struct {
	File
	OsFile   *os.File
	Received int64  // number of different chunks received
	Got      []bool // received chunk indices — a chunk sent twice is not counted or forwarded again
}

type TransferACK struct {
	ID    uuid.UUID `json:"id"`
	Chunk int64     `json:"chunk"`
}

type TransferNACK struct {
	ID     uuid.UUID `json:"id"`
	Chunk  int64     `json:"chunk"`
	Reason string    `json:"reason"`
}

func (m File) GetID() []byte {
	return m.ID[:]
}

func (m File) GetFileDir() string {
	return filepath.Join(FileDir, m.RoomID.String())
}

// GetPartPath is the file while it is uploaded; renamed to GetFilePath when complete
func (m File) GetPartPath() string {
	return m.GetFilePath() + ".part"
}

func (m File) GetFilePath() string {
	return filepath.Join(FileDir, m.RoomID.String(), m.ID.String())
}
