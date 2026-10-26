package domain

import (
	"log/slog"
	"slices"

	"github.com/google/uuid"
)

// MaxMessageTTL is the longest time in seconds the server keeps a message (30 days).
const MaxMessageTTL = int64(60 * 60 * 24 * 30)

// MessageTTLSteps are the only shorter TTLs a message can have (5 min, 1 h, 1 d, 7 d).
// A freely chosen TTL would be visible to the server on every message of the same sender
// and so mark them as coming from one person; with a few fixed steps many people share one.
var MessageTTLSteps = []int64{5 * 60, 60 * 60, 24 * 60 * 60, 7 * 24 * 60 * 60}

type Room struct {
	ID    uuid.UUID  `json:"id,omitempty"`
	Name  string     `json:"name,omitempty"`
	Peers []RoomPeer `json:"peers,omitempty"`

	// Maximum TTL of all messages in seconds. It is set once when the room is created on the
	// server and can not be changed afterwards. A message may only ask for a shorter TTL.
	TTL int64 `json:"ttl,omitempty"`

	// Whether the server keeps the messages and files of the room ("Keep on Server"). Like the
	// TTL it is set once when the room is created; nil for rooms created before it was stored.
	Store *bool `json:"store,omitempty"`

	// Secret the join codes are derived from (see joincode.go), created with the room. Members
	// get it with room_info.
	JoinSecret []byte `json:"joinSecret,omitempty"`

	// Server time (ms) of the last clean. Members that were offline get the clean on their
	// next join, if they were last connected before it.
	CleanedAt uint64 `json:"cleanedAt,omitempty"`
}

type JoinRooms struct {
	Rooms              []JoinRoom `json:"rooms,omitempty"`
	LastConnectionTime uint64     `json:"lastConnectionTime,omitempty"`
}

type JoinRoom struct {
	ID           uuid.UUID `json:"id,omitempty"`
	Notification bool      `json:"notification,omitempty"`

	// Only used if the room does not exist on the server yet (or has no TTL / store setting yet)
	TTL   int64 `json:"ttl,omitempty"`
	Store *bool `json:"store,omitempty"`

	// Proof that the client may join (see joincode.go): members send their member code,
	// new members the invite code of the QR code
	MemberCode string `json:"memberCode,omitempty"`
	InviteCode string `json:"inviteCode,omitempty"`
}

// RoomInfo is sent to the client after joining, so it knows the TTL that is in force.
type RoomInfo struct {
	ID    uuid.UUID `json:"id"`
	TTL   int64     `json:"ttl"`
	Store *bool     `json:"store,omitempty"` // nil: not set yet, the client keeps its own setting

	JoinSecret []byte `json:"joinSecret,omitempty"` // base64; the client derives its join codes from it
}

// JoinRejected tells the client that it may not join the room (no or no valid join code).
type JoinRejected struct {
	ID     uuid.UUID `json:"id"`
	Reason string    `json:"reason"`
}

type RoomPeer struct {
	ID           uuid.UUID `json:"id,omitempty"`
	Notification bool      `json:"notification,omitempty"`
}

type LeaveRooms struct {
	Rooms []uuid.UUID `json:"rooms,omitempty"`
}

// CleanRoom asks the server to delete all messages and files of a room. The server forwards it
// to the members with the time of the clean: they delete every message up to this time.
type CleanRoom struct {
	ID        uuid.UUID `json:"id"`
	Timestamp uint64    `json:"timestamp,omitempty"`
}

// ClampTTL limits a TTL to (0, MaxMessageTTL]; 0 or negative means the maximum.
func ClampTTL(ttl int64) int64 {
	if ttl <= 0 || ttl > MaxMessageTTL {
		return MaxMessageTTL
	}

	return ttl
}

// SetTTLOnce sets the TTL if the room has none yet and returns the TTL in force.
func (r *Room) SetTTLOnce(ttl int64) int64 {
	if r.TTL == 0 {
		r.TTL = ClampTTL(ttl)
	}

	return r.TTL
}

// SetStoreOnce sets the store setting if the room has none yet and returns the setting in force
// (nil if neither the room nor the request has one).
func (r *Room) SetStoreOnce(store *bool) *bool {
	if r.Store == nil && store != nil {
		v := *store
		r.Store = &v
	}

	return r.Store
}

// StoreMessages returns whether a message or file is kept on the server: the setting of the
// room, or the requested one if the room has none (rooms created before it was stored).
func (r *Room) StoreMessages(requested bool) bool {
	if r.Store == nil {
		return requested
	}

	return *r.Store
}

// MessageTTL returns the TTL a message gets in this room: the room TTL, or — if a shorter TTL
// is requested — the largest of the MessageTTLSteps that is not longer than the request
// (at least the smallest step). It is never longer than the room TTL. 0 = no own TTL requested.
func (r *Room) MessageTTL(requested int64) int64 {
	roomTTL := ClampTTL(r.TTL)
	if requested <= 0 || requested >= roomTTL {
		return roomTTL
	}

	ttl := MessageTTLSteps[0]
	for _, step := range MessageTTLSteps {
		if step <= requested {
			ttl = step
		}
	}

	return min(ttl, roomTTL)
}

func (r *Room) GetID() []byte {
	return r.ID[:]
}

func (r *Room) RemovePeer(peerID uuid.UUID) {
	r.Peers = slices.DeleteFunc(r.Peers, func(v RoomPeer) bool {
		if v.ID == peerID {
			slog.Debug("remove peer from room", slog.String("peer", peerID.String()), slog.String("room", r.ID.String()))
			return true
		}

		return false
	})
}

func (r *Room) HasPeer(peerID uuid.UUID) bool {
	return slices.ContainsFunc(r.Peers, func(peer RoomPeer) bool {
		return peer.ID == peerID
	})
}

func (r *Room) AddPeer(peerID uuid.UUID, notification bool) {
	if !r.HasPeer(peerID) {
		slog.Debug("add peer to room", slog.String("peer", peerID.String()), slog.String("room", r.ID.String()))
		r.Peers = append(r.Peers, RoomPeer{ID: peerID, Notification: notification})
	}
}
