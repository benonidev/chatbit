package domain

import (
	"log/slog"
	"slices"
	"time"

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

	// Current epoch (see rotation.go); 0 until the creator sent the first rotation
	Epoch uint32 `json:"epoch,omitempty"`

	// Join secret of the current epoch: the join codes are derived from it (see joincode.go). It
	// is set by every rotation; members get it in their envelope, never from the server.
	JoinSecret []byte `json:"joinSecret,omitempty"`

	// New members that sent a join request with a valid invite code and wait for the approval.
	// They get rotations, but no messages.
	Pending []PendingPeer `json:"pending,omitempty"`

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

	// Last epoch the client knows and its member code from the join secret of that epoch (see
	// joincode.go). An older epoch only gives the rotations since then (catch-up).
	Epoch      uint32 `json:"epoch,omitempty"`
	MemberCode string `json:"memberCode,omitempty"`

	// Server timestamp of the newest message the client got for this room: messages from then on
	// are sent again (also the ones of that same millisecond). nil: JoinRooms.LastConnectionTime.
	Since *uint64 `json:"since,omitempty"`
}

// RoomSynced follows the missed messages of a join: the client has every stored message up to
// Until (server time) and can move its cursor of the room there.
type RoomSynced struct {
	ID    uuid.UUID `json:"id"`
	Until uint64    `json:"until"`
}

// RoomInfo is sent to the client after joining, so it knows the TTL and epoch that are in force.
type RoomInfo struct {
	ID    uuid.UUID `json:"id"`
	TTL   int64     `json:"ttl"`
	Store *bool     `json:"store,omitempty"` // nil: not set yet, the client keeps its own setting
	Epoch uint32    `json:"epoch"`

	// The client waits for the approval of its join request (no messages until then)
	Pending bool `json:"pending,omitempty"`
}

// JoinRejected tells the client that it may not join the room. Reason "code": no valid join
// code. Reason "declined": a member declined its join request. Reason "rotated": the code was
// valid for an older epoch — Rotations are all rotations since then; the client applies them and
// joins again with a code of the current epoch.
type JoinRejected struct {
	ID        uuid.UUID     `json:"id"`
	Reason    string        `json:"reason"`
	Rotations []RotationOut `json:"rotations,omitempty"`
}

type RoomPeer struct {
	ID           uuid.UUID `json:"id,omitempty"`
	Notification bool      `json:"notification,omitempty"`

	// Epoch of the last join: only peers of the current epoch are members (IsMember). After a
	// rotation everybody has to join again with a code of the new join secret.
	Epoch uint32 `json:"epoch,omitempty"`
}

type PendingPeer struct {
	ID    uuid.UUID `json:"id"`
	Until int64     `json:"until"` // unix seconds
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

// IsMember reports whether the peer joined in the current epoch
func (r *Room) IsMember(peerID uuid.UUID) bool {
	return slices.ContainsFunc(r.Peers, func(peer RoomPeer) bool {
		return peer.ID == peerID && peer.Epoch == r.Epoch
	})
}

// AddPeer adds the peer as member of the current epoch (or updates it)
func (r *Room) AddPeer(peerID uuid.UUID, notification bool) {
	i := slices.IndexFunc(r.Peers, func(peer RoomPeer) bool { return peer.ID == peerID })
	if i >= 0 {
		r.Peers[i].Notification = notification
		r.Peers[i].Epoch = r.Epoch
		return
	}

	slog.Debug("add peer to room", slog.String("peer", peerID.String()), slog.String("room", r.ID.String()))
	r.Peers = append(r.Peers, RoomPeer{ID: peerID, Notification: notification, Epoch: r.Epoch})
}

// IsPending reports whether the peer waits for the approval of its join request
func (r *Room) IsPending(peerID uuid.UUID, now time.Time) bool {
	return slices.ContainsFunc(r.Pending, func(p PendingPeer) bool {
		return p.ID == peerID && p.Until > now.Unix()
	})
}

// AddPending lets the peer wait for the approval until `until`; expired entries are removed
func (r *Room) AddPending(peerID uuid.UUID, now, until time.Time) {
	r.RemovePending(peerID, now)
	r.Pending = append(r.Pending, PendingPeer{ID: peerID, Until: until.Unix()})
}

// RemovePending removes the peer and all expired entries
func (r *Room) RemovePending(peerID uuid.UUID, now time.Time) {
	r.Pending = slices.DeleteFunc(r.Pending, func(p PendingPeer) bool {
		return p.ID == peerID || p.Until <= now.Unix()
	})
}
