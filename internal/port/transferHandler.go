package port

import (
	"chatbit/internal/domain"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// handleTransferStart returns false if the upload is rejected
func (c *WsClient) handleTransferStart(hdr *domain.File) bool {
	slog.Debug("transfer_start", slog.String("file", hdr.ID.String()), slog.Int64("size", hdr.TotalSize))

	err := hdr.ValidateUpload()
	if err != nil {
		slog.Warn("transfer rejected", slog.Int64("size", hdr.TotalSize),
			slog.Int64("chunkSize", hdr.ChunkSize), slog.Int64("chunks", hdr.ChunkTotal))
		c.sendNACK(hdr.ID, 0, "invalid file size")
		return false
	}

	c.fileTransferMu.Lock()
	running := len(c.fileTransfer)
	c.fileTransferMu.Unlock()
	if running >= c.limits.cfg.MaxUploadsPerConn {
		c.sendNACK(hdr.ID, 0, "busy")
		return false
	}

	if !c.limits.AllowUpload(c.ip, hdr.TotalSize) {
		slog.Warn("upload quota of IP reached")
		c.sendNACK(hdr.ID, 0, "quota")
		return false
	}

	room, err := c.app.DB.Room.Get(hdr.RoomID[:])
	if err != nil {
		slog.Error("transfer for unknown room", slog.String("error", err.Error()))
		return false
	}

	// Only members of the current epoch upload (the file is encrypted with its key)
	if !room.IsMember(c.UID) {
		c.sendNACK(hdr.ID, 0, "member")
		return false
	}

	// The room decides whether the file is kept on the server
	hdr.Store = room.StoreMessages(hdr.Store)

	// Keep MIN_FREE_DISK_MB free — the server must not fill its disk
	if hdr.Store {
		free, err := diskFree(domain.FileDir)
		minFree := uint64(c.limits.cfg.MinFreeDiskMB) * 1024 * 1024
		if err == nil && free < minFree+uint64(hdr.TotalSize) {
			slog.Error("not enough free disk space for upload", slog.Uint64("free", free))
			c.sendNACK(hdr.ID, 0, "disk full")
			return false
		}
	}

	fileHdr := &domain.Transfer{
		File:     *hdr,
		Received: 0,
		Got:      make([]bool, hdr.ChunkTotal),
	}

	if hdr.Store {
		// An existing file is never replaced (the header is only stored for complete uploads)
		_, err = c.app.DB.File.Get(hdr.ID[:])
		if err == nil {
			slog.Warn("file id exists already, rejected")
			c.sendNACK(hdr.ID, 0, "file exists")
			return false
		}

		err = os.MkdirAll(hdr.GetFileDir(), 0o755)
		if err != nil {
			slog.Error("cannot create dir", slog.String("error", err.Error()))
			return false
		}

		// Uploaded to <id>.part — a failed upload never leaves a broken file under the real name
		fileHdr.OsFile, err = os.Create(hdr.GetPartPath())
		if err != nil {
			slog.Error("cannot create file", slog.String("error", err.Error()))
			return false
		}

		err = fileHdr.OsFile.Truncate(hdr.TotalSize)
		if err != nil {
			slog.Error("cannot truncate file", slog.String("error", err.Error()))
			fileHdr.OsFile.Close()
			os.Remove(fileHdr.OsFile.Name())
			return false
		}
	}

	// Files live exactly as long as their message: room TTL or the shorter TTL of the message
	hdr.TTL = room.MessageTTL(hdr.TTL)
	fileHdr.TTL = hdr.TTL

	c.fileTransferMu.Lock()
	c.fileTransfer[hdr.ID] = fileHdr
	c.fileTransferMu.Unlock()

	c.sendACK(hdr.ID, 0)

	slog.Debug("transfer started", slog.String("file", hdr.ID.String()), slog.Int64("size", hdr.TotalSize))

	return true
}

// handleTransferDone returns true if the upload is complete (and stored if the room stores files)
func (c *WsClient) handleTransferDone(done *domain.File) bool {
	c.fileTransferMu.Lock()
	t, ok := c.fileTransfer[done.ID]
	delete(c.fileTransfer, done.ID)
	c.fileTransferMu.Unlock()

	if !ok {
		return false
	}

	if t.OsFile != nil {
		t.OsFile.Close()
	}

	if t.Received != t.ChunkTotal {
		slog.Warn("transfer incomplete",
			slog.Int64("received", t.Received),
			slog.Int64("expected", t.ChunkTotal),
		)

		if t.Store {
			err := os.Remove(t.GetPartPath())
			if err != nil {
				slog.Error("not possible to remove file", slog.String("error", err.Error()))
			}
		}

		return false
	}

	if t.Store {
		ok = c.storeCompleteFile(t)
		if !ok {
			return false
		}
	}

	// The image message itself was already stored via the normal "message" path. The message
	// embedded in the file header must not be stored: it has the same key but no timestamp,
	// type or sender, so it would overwrite the real message and offline peers would never get it.
	msgB, err := json.Marshal(t.Message)
	if err != nil {
		slog.Error("not possible to unmarshal ws message ", slog.String("error", err.Error()))
	}

	wsMsg := domain.WsMessage{
		Type: string(domain.WsTypeFileTransferDone),
		Data: msgB,
	}

	wsMsgB, err := json.Marshal(wsMsg)
	if err != nil {
		slog.Error("not possible to unmarshal ws message ", slog.String("error", err.Error()))
	}

	err = c.psWsMsgAdapter.PublishExclude(t.RoomID, c.UID, WsOutbound{MsgType: websocket.TextMessage, Data: wsMsgB})
	if err != nil {
		slog.Error("not possible to update file in database", slog.String("error", err.Error()))
		return false
	}

	return true
}

func (c *WsClient) storeCompleteFile(t *domain.Transfer) bool {
	err := c.app.DB.File.InsertWithTTL(&t.File, t.TTL)
	if errors.Is(err, domain.ErrObjExists) {
		slog.Warn("file id exists already, upload dropped")
		_ = os.Remove(t.GetPartPath())
		return false
	}
	if err != nil {
		slog.Error("not possible to add file header to database", slog.String("error", err.Error()))
		_ = os.Remove(t.GetPartPath())
		return false
	}

	err = os.Rename(t.GetPartPath(), t.GetFilePath())
	if err != nil {
		slog.Error("not possible to move uploaded file", slog.String("error", err.Error()))
		return false
	}

	return true
}

func (c *WsClient) handleChunk(data []byte) {
	uid, chunkId, payload, err := c.readFileHeader(data)
	if err != nil {
		slog.Error("not possible convert uuid from chunk", slog.String("error", err.Error()))
		return
	}

	c.fileTransferMu.Lock()
	t, ok := c.fileTransfer[uid]
	c.fileTransferMu.Unlock()

	if !ok {
		slog.Warn("chunk for unknown transfer")
		return
	}

	// The offset is calculated from the index — a chunk outside the file is never written
	if !t.ChunkFits(chunkId, len(payload)) {
		slog.Warn("chunk outside of file", slog.Int64("chunk", chunkId))
		c.sendNACK(uid, chunkId, "invalid chunk")
		return
	}

	// A chunk sent twice is neither counted nor forwarded again
	c.fileTransferMu.Lock()
	dup := t.Got[chunkId]
	t.Got[chunkId] = true
	c.fileTransferMu.Unlock()
	if dup {
		return
	}

	// send chunk to all peers in rooms exclude own subID
	err = c.psWsMsgAdapter.PublishExclude(t.RoomID, c.UID, WsOutbound{MsgType: websocket.BinaryMessage, Data: data})
	if err != nil {
		slog.Error("not possible to publish chunk", slog.String("error", err.Error()))
	}

	if t.Store {
		// Write directly at the right offset – no reassembly needed
		offset := chunkId * t.ChunkSize // chunkSize = 64*1024
		_, err = t.OsFile.WriteAt(payload, offset)
		if err != nil {
			slog.Error("chunk write error", slog.String("error", err.Error()))

			c.sendNACK(uid, chunkId, "write error")

			return
		}
	}

	c.fileTransferMu.Lock()
	t.Received++
	c.fileTransferMu.Unlock()

	if t.Received == t.ChunkTotal {
		slog.Debug("transfer done", slog.String("file", uid.String()))
		return
	}

	c.sendACK(uid, chunkId+1)
}

func (c *WsClient) sendFileTransferStart(file *domain.File) error {
	hdr, err := c.app.DB.File.Get(file.ID[:])
	if err != nil {
		slog.Error("not possible to get file header from database", slog.String("error", err.Error()))
		return err
	}

	// Only members of the current epoch of the file's room may download it
	room, err := c.app.DB.Room.Get(hdr.RoomID[:])
	if err != nil || !room.IsMember(c.UID) {
		return fmt.Errorf("file %s requested by a peer that is not a member", hdr.ID)
	}

	// Headers stored before the upload validation existed
	if hdr.ChunkSize <= 0 || hdr.ChunkSize > domain.FileChunkSize {
		return fmt.Errorf("invalid chunk size %d of file %s", hdr.ChunkSize, hdr.ID)
	}

	f, err := os.Open(hdr.GetFilePath())
	if err != nil {
		slog.Error("cannot create temp file", slog.String("error", err.Error()))
		return err
	}
	defer f.Close()

	slog.Debug("transfer request started", slog.String("file", hdr.ID.String()), slog.Int64("size", hdr.TotalSize))

	err = c.psWsMsgAdapter.PublishTo(c.UID, c.UID, NewWsOutboundMessage(domain.WsTypeFileTransferStart, hdr))
	if err != nil {
		slog.Error("not possible to publish transfer start", slog.String("error", err.Error()))
	}

	buf := make([]byte, hdr.ChunkSize)
	var index int64

	for {
		n, err := f.Read(buf)
		if n > 0 {
			packet := c.addFileHeader(hdr.ID, index, buf[:n])

			err = c.psWsMsgAdapter.PublishTo(c.UID, c.UID, WsOutbound{MsgType: websocket.BinaryMessage, Data: packet})
			if err != nil {
				slog.Error("not possible to publish transfer start", slog.String("error", err.Error()))
			}

			index++
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
	}

	err = c.psWsMsgAdapter.PublishTo(c.UID, c.UID, NewWsOutboundMessage(domain.WsTypeFileTransferDone, hdr.Message))
	if err != nil {
		slog.Error("not possible to publish transfer start", slog.String("error", err.Error()))
	}

	return nil
}

func (c *WsClient) addFileHeader(id uuid.UUID, index int64, chunk []byte) []byte {
	packet := make([]byte, 16+4+len(chunk))
	copy(packet[0:16], id[:])
	binary.BigEndian.PutUint32(packet[16:20], uint32(index))
	copy(packet[20:], chunk)
	return packet
}

func (c *WsClient) readFileHeader(data []byte) (uid uuid.UUID, index int64, chunk []byte, err error) {
	if len(data) < 20 {
		err = fmt.Errorf("invalid chunk size")
		return
	}

	ub := data[:16]
	id := fmt.Sprintf("%x-%x-%x-%x-%x", ub[0:4], ub[4:6], ub[6:8], ub[8:10], ub[10:16])

	uid, err = uuid.Parse(id)
	if err != nil {
		slog.Error("not possible convert uuid from chunk", slog.String("error", err.Error()))
		err = fmt.Errorf("invalid UUID")
		return
	}

	index = int64(binary.BigEndian.Uint32(data[16:20]))

	chunk = data[20:]

	return
}

func (c *WsClient) sendACK(id uuid.UUID, chunk int64) {
	err := c.psWsMsgAdapter.PublishTo(c.UID, c.UID, NewWsOutboundMessage(domain.WsTypeFileTransferACK, domain.TransferACK{ID: id, Chunk: chunk}))
	if err != nil {
		slog.Error("not possible to publish ACK", slog.String("error", err.Error()))
	}
}

func (c *WsClient) sendNACK(id uuid.UUID, chunk int64, reason string) {
	err := c.psWsMsgAdapter.PublishTo(c.UID, c.UID, NewWsOutboundMessage(domain.WsTypeFileTransferNACK, domain.TransferNACK{ID: id, Chunk: chunk, Reason: reason}))
	if err != nil {
		slog.Error("not possible to publish ACK", slog.String("error", err.Error()))
	}
}
