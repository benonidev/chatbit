package domain

import (
	"crypto/sha256"
	"encoding/binary"
	"time"

	"github.com/google/uuid"
)

// Rooms have epochs (docs/room-keys.md). A rotation starts the next epoch: the client sends the
// new join secret in clear (the server checks the join codes with it) and a body the server can
// not read — envelopes with the new keys for every member, the member list and a signature.
// The server only orders: exactly one rotation per epoch, the first one wins.
const (
	// RotationLogTTL is how long rotations are kept, so members that were offline can catch up
	RotationLogTTL = 180 * 24 * time.Hour

	// JoinRequestTTL is how long a join request waits for the approval of the inviter
	JoinRequestTTL = 24 * time.Hour

	// KeyUpdateTTL is the longest time a key update is kept; the next rotation deletes it anyway
	KeyUpdateTTL = 30 * 24 * time.Hour

	MaxRotationBody = 96 * 1024 // the frame limit is 128 KB
	MaxJoinRequest  = 8 * 1024
	MaxKeyUpdate    = 4 * 1024

	// MaxCatchUp is the largest number of rotations sent to a client that was offline
	MaxCatchUp = 500
)

// Rotation as stored in the rotation log
type Rotation struct {
	RoomID     uuid.UUID `json:"roomId"`
	Epoch      uint32    `json:"epoch"`
	JoinSecret []byte    `json:"joinSecret,omitempty"` // server only, never sent to clients
	Body       string    `json:"body"`
}

func (r Rotation) GetID() []byte {
	return binary.BigEndian.AppendUint32(append([]byte{}, r.RoomID[:]...), r.Epoch)
}

func (r Rotation) GetRoomID() []byte {
	return r.RoomID[:]
}

// GetTimestamp is the epoch: the log is read with "all rotations after epoch n"
func (r Rotation) GetTimestamp() uint64 {
	return uint64(r.Epoch)
}

// Public is the rotation as sent to clients — without the join secret
func (r Rotation) Public() RotationOut {
	return RotationOut{RoomID: r.RoomID, Epoch: r.Epoch, Body: r.Body}
}

// Rotate is sent by a client to start the next epoch
type Rotate struct {
	RoomID     uuid.UUID `json:"roomId"`
	Epoch      uint32    `json:"epoch"`
	JoinSecret []byte    `json:"joinSecret"`
	Body       string    `json:"body"`
}

// RotationOut is a rotation sent to clients
type RotationOut struct {
	RoomID uuid.UUID `json:"roomId"`
	Epoch  uint32    `json:"epoch"`
	Body   string    `json:"body"`
}

// RotateRejected tells the sender that another rotation was first (or that it may not rotate)
type RotateRejected struct {
	RoomID  uuid.UUID `json:"roomId"`
	Epoch   uint32    `json:"epoch"`
	Current uint32    `json:"current"`
}

// RejoinRequired is sent after a rotation: the subscription ended, members join again with a
// code from the new join secret
type RejoinRequired struct {
	RoomID uuid.UUID `json:"roomId"`
	Epoch  uint32    `json:"epoch"`
}

// JoinRequest of a new member, encrypted with the base key of the room (the server can not read
// it). The invite code is only sent by the client and never stored. PeerID and Declined are only
// stored on the server (who asked, and whether a member declined) and never sent to clients.
type JoinRequest struct {
	RoomID     uuid.UUID `json:"roomId"`
	InviteCode string    `json:"inviteCode,omitempty"`
	Request    string    `json:"request"`
	TimeStamp  uint64    `json:"timestamp,omitempty"`
	PeerID     string    `json:"peerId,omitempty"`
	Declined   bool      `json:"declined,omitempty"`
}

// AnswerRequest is sent by a member after it approved or declined a join request: the request is
// deleted, a declined requester is removed from the room and told so.
type AnswerRequest struct {
	RoomID   uuid.UUID `json:"roomId"`
	Request  string    `json:"request"`
	Approved bool      `json:"approved"`
}

// GetID is room id + hash of the request, so the same request is stored once
func (j JoinRequest) GetID() []byte {
	h := sha256.Sum256([]byte(j.Request))
	return append(append([]byte{}, j.RoomID[:]...), h[:16]...)
}

func (j JoinRequest) GetRoomID() []byte {
	return j.RoomID[:]
}

func (j JoinRequest) GetTimestamp() uint64 {
	return j.TimeStamp
}

// KeyUpdate is a new exchange key of a member, encrypted with the room key of the epoch
type KeyUpdate struct {
	RoomID    uuid.UUID `json:"roomId"`
	Epoch     uint32    `json:"epoch"`
	Update    string    `json:"update"`
	TimeStamp uint64    `json:"timestamp,omitempty"`
}

func (k KeyUpdate) GetID() []byte {
	h := sha256.Sum256([]byte(k.Update))
	return append(append([]byte{}, k.RoomID[:]...), h[:16]...)
}

func (k KeyUpdate) GetRoomID() []byte {
	return k.RoomID[:]
}

func (k KeyUpdate) GetTimestamp() uint64 {
	return k.TimeStamp
}

// MessageRejected tells the sender that a message was not accepted, e.g. because the room
// rotated while it was on its way — the client sends it again in the new epoch
type MessageRejected struct {
	ID     uuid.UUID `json:"id"`
	RoomID uuid.UUID `json:"roomId"`
	Reason string    `json:"reason"`
}
