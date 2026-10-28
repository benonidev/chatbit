package port

import (
	"chatbit/internal/adapter/pubsub"
	"chatbit/internal/domain"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// Room keys with epochs (docs/room-keys.md). The server never sees keys or member lists — it
// checks join codes with the join secret of the current epoch, keeps the rotation log in order
// and passes on what the clients encrypted.

type joinOutcome int

const (
	joinRejected joinOutcome = iota
	joinMember               // member of the current epoch: messages, files, rotations
	joinPending              // waits for the approval of its join request: rotations only
	joinCatchUp              // valid code of an older epoch: gets the rotations since then
)

// joinRoom handles one room of a join_rooms frame.
func (c *WsClient) joinRoom(join domain.JoinRoom, lastConnectionTime uint64) {
	now := time.Now()
	outcome := joinRejected
	var info domain.RoomInfo
	var cleanedAt uint64

	err := c.app.DB.Room.UpdateWithTTL(join.ID[:], func(r *domain.Room) error {
		outcome = c.joinOutcome(r, join, now)
		if outcome == joinRejected {
			return domain.ErrJoinRejected
		}

		if outcome == joinMember {
			r.AddPeer(c.UID, join.Notification)
			r.RemovePending(c.UID, now)
			// Rooms created before the TTL / store setting was stored get it once from the first join
			r.SetTTLOnce(join.TTL)
			r.SetStoreOnce(join.Store)
		}

		info = domain.RoomInfo{ID: r.ID, TTL: r.TTL, Store: r.Store, Epoch: r.Epoch, Pending: outcome == joinPending}
		cleanedAt = r.CleanedAt

		return nil
	}, c.limits.RoomStoreTTL)
	if errors.Is(err, domain.ErrObjNotFound) {
		// A join of an unknown id creates the room — limited per IP, so nobody can fill the
		// database with made up rooms. It has no join secret until the creator's first rotation.
		if !c.limits.AllowRoomCreate(c.ip) {
			slog.Warn("room creation limit reached")
			return
		}

		slog.Debug("peer will create new room", slog.String("room", join.ID.String()), slog.String("peer", c.UID.String()))
		r := &domain.Room{ID: join.ID}
		r.AddPeer(c.UID, join.Notification)
		r.SetTTLOnce(join.TTL)
		r.SetStoreOnce(join.Store)

		err = c.app.DB.Room.AddWithTTL(r, c.limits.RoomStoreTTL(r))
		outcome = joinMember
		info = domain.RoomInfo{ID: r.ID, TTL: r.TTL, Store: r.Store}
	}
	if errors.Is(err, domain.ErrJoinRejected) {
		slog.Debug("join rejected, no valid join code", slog.String("room", join.ID.String()), slog.String("peer", c.UID.String()))
		reason := "code"
		if c.wasDeclined(join.ID) {
			reason = "declined" // it waited for approval while offline and was declined
		}
		c.send <- NewWsOutboundMessage(domain.WsTypeJoinRejected, domain.JoinRejected{ID: join.ID, Reason: reason})
		return
	}
	if err != nil {
		slog.Error("not possible to update room", slog.String("error", err.Error()))
		return
	}

	if outcome == joinCatchUp {
		c.sendCatchUp(join.ID, join.Epoch)
		return
	}

	err = c.psWsMsgAdapter.AddSubscriberToTopic(join.ID, c.UID)
	if err != nil && !errors.Is(err, pubsub.ErrAlreadyExist) {
		slog.Error("not possible subscribe to room", slog.String("error", err.Error()))
		return
	}

	// Tell the client which TTL, store setting and epoch are in force
	c.send <- NewWsOutboundMessage(domain.WsTypeRoomInfo, info)

	if outcome == joinPending {
		return
	}

	// Per room since the newest message the client has (server time) — older clients send one
	// time for all rooms
	since := lastConnectionTime
	if join.Since != nil {
		since = *join.Since
	}

	// The room was cleaned while the client was offline — sent before the newer messages
	if cleanedAt > since {
		c.send <- NewWsOutboundMessage(domain.WsTypeCleanRoom, domain.CleanRoom{ID: join.ID, Timestamp: cleanedAt})
	}

	until := c.sendMissedMessages(join.ID, since)
	c.send <- NewWsOutboundMessage(domain.WsTypeRoomSynced, domain.RoomSynced{ID: join.ID, Until: until})
	c.sendRoomBacklog(join.ID, info.Epoch)
}

// joinOutcome decides what a join_rooms entry gets. Every code is valid once.
func (c *WsClient) joinOutcome(r *domain.Room, join domain.JoinRoom, now time.Time) joinOutcome {
	switch {
	case join.MemberCode != "":
		if r.Epoch > 0 && join.Epoch == r.Epoch && r.ValidMemberCode(join.MemberCode, c.UID, now) {
			if c.useJoinCode(r.ID, join.MemberCode) {
				return joinMember
			}
			return joinRejected
		}
		// A member that was offline: its code is checked with the join secret of its epoch
		if join.Epoch > 0 && join.Epoch < r.Epoch && c.validOldMemberCode(r.ID, join.Epoch, join.MemberCode, now) {
			if c.useJoinCode(r.ID, join.MemberCode) {
				return joinCatchUp
			}
		}
		return joinRejected

	case r.IsPending(c.UID, now):
		if join.Epoch < r.Epoch {
			return joinCatchUp
		}
		return joinPending

	case r.Epoch == 0 && r.HasPeer(c.UID):
		// The creator before its first rotation (there is no join secret yet)
		return joinMember
	}

	return joinRejected
}

func (c *WsClient) validOldMemberCode(roomID uuid.UUID, epoch uint32, code string, now time.Time) bool {
	rot, err := c.app.DB.Rotation.Get(domain.Rotation{RoomID: roomID, Epoch: epoch}.GetID())
	if err != nil {
		return false // expired from the log — the client has to be invited again
	}

	return domain.ValidMemberCode(rot.JoinSecret, code, c.UID, now)
}

// sendCatchUp sends all rotations after `epoch` as join_rejected {reason: "rotated"}. The client
// applies them and joins again with a code of the newest join secret it got.
func (c *WsClient) sendCatchUp(roomID uuid.UUID, epoch uint32) {
	rotations, err := c.app.DB.Rotation.GetAllSinceTimeStamp(roomID, uint64(epoch))
	if err != nil {
		slog.Error("not possible to read rotation log", slog.String("error", err.Error()))
		return
	}
	if len(rotations) > domain.MaxCatchUp {
		rotations = rotations[:domain.MaxCatchUp] // the client joins again and gets the rest
	}

	out := make([]domain.RotationOut, 0, len(rotations))
	for _, rot := range rotations {
		out = append(out, rot.Public())
	}

	c.send <- NewWsOutboundMessage(domain.WsTypeJoinRejected, domain.JoinRejected{ID: roomID, Reason: "rotated", Rotations: out})
}

// sendMissedMessages sends the stored messages of the room newer than lastConnectionTime
// sendMissedMessages sends every stored message of the room with a timestamp >= since —
// including that millisecond, the client drops the ones it has. Returns the newest timestamp
// sent (since if there was none).
func (c *WsClient) sendMissedMessages(roomID uuid.UUID, since uint64) uint64 {
	after := since
	if after > 0 {
		after-- // GetAllSinceTimeStamp is exclusive
	}

	until := since
	msgs, err := c.app.DB.Message.GetAllSinceTimeStamp(roomID, after)
	if err != nil {
		slog.Error("not possible to get all messages since", slog.String("error", err.Error()))
		return until
	}

	for _, m := range msgs {
		until = max(until, m.TimeStamp)

		frame, err := marshalWs(domain.WsTypeMessage, m)
		if err != nil {
			slog.Error("not possible to marshal message", slog.String("error", err.Error()))
			continue
		}

		c.send <- WsOutbound{MsgType: websocket.TextMessage, Data: frame}
	}

	return until
}

// sendRoomBacklog sends what a member needs besides the messages: join requests that wait for
// approval and key updates of the current epoch.
func (c *WsClient) sendRoomBacklog(roomID uuid.UUID, epoch uint32) {
	requests, err := c.app.DB.JoinRequest.GetAllSinceTimeStamp(roomID, 0)
	if err != nil {
		slog.Error("not possible to read join requests", slog.String("error", err.Error()))
	}
	for _, req := range requests {
		if !req.Declined {
			c.send <- NewWsOutboundMessage(domain.WsTypeJoinRequest, domain.JoinRequest{RoomID: roomID, Request: req.Request})
		}
	}

	updates, err := c.app.DB.KeyUpdate.GetAllSinceTimeStamp(roomID, 0)
	if err != nil {
		slog.Error("not possible to read key updates", slog.String("error", err.Error()))
	}
	for _, u := range updates {
		if u.Epoch == epoch {
			c.send <- NewWsOutboundMessage(domain.WsTypeKeyUpdate, domain.KeyUpdate{RoomID: roomID, Epoch: u.Epoch, Update: u.Update})
		}
	}
}

// rotate starts the next epoch. Only a member of the current epoch (or the creator for epoch 1)
// may rotate, and only the first rotation for an epoch is accepted.
func (c *WsClient) rotate(rot domain.Rotate) {
	if rot.Epoch == 0 || len(rot.JoinSecret) != domain.JoinSecretSize || rot.Body == "" || len(rot.Body) > domain.MaxRotationBody {
		slog.Warn("invalid rotation, rejected")
		return
	}

	var current uint32
	var room domain.Room
	stored := domain.Rotation{RoomID: rot.RoomID, Epoch: rot.Epoch, JoinSecret: rot.JoinSecret, Body: rot.Body}

	err := c.app.DB.Room.UpdateWithTTL(rot.RoomID[:], func(r *domain.Room) error {
		current = r.Epoch

		creator := r.Epoch == 0 && r.HasPeer(c.UID)
		if !creator && !r.IsMember(c.UID) {
			return domain.ErrNotMember
		}
		if rot.Epoch != r.Epoch+1 {
			return domain.ErrRotationConflict
		}

		// Into the log first: if that fails the room stays in its epoch
		err := c.app.DB.Rotation.InsertWithTTL(stored, int64(domain.RotationLogTTL.Seconds()))
		if err != nil {
			return err
		}

		r.Epoch = rot.Epoch
		r.JoinSecret = rot.JoinSecret
		room = *r

		return nil
	}, c.limits.RoomStoreTTL)
	if err != nil {
		if !errors.Is(err, domain.ErrRotationConflict) && !errors.Is(err, domain.ErrObjExists) && !errors.Is(err, domain.ErrNotMember) {
			slog.Error("not possible to rotate room", slog.String("error", err.Error()))
		}
		c.send <- NewWsOutboundMessage(domain.WsTypeRotateRejected, domain.RotateRejected{RoomID: rot.RoomID, Epoch: rot.Epoch, Current: current})
		return
	}

	slog.Debug("room rotated", slog.String("room", room.ID.String()), slog.Uint64("epoch", uint64(room.Epoch)))

	// Key updates and join requests of the old epoch: updates are part of the new roster now;
	// requests are kept (they may still wait for approval) — they expire by themselves
	err = c.app.DB.KeyUpdate.DeleteAll(room.ID)
	if err != nil {
		slog.Error("not possible to delete key updates", slog.String("error", err.Error()))
	}

	// Everybody subscribed (members and waiting new members) gets the rotation — without the
	// join secret. Then the members have to join again with a code of the new join secret: a
	// removed member can not, even if it is connected right now.
	err = c.psWsMsgAdapter.Publish(room.ID, NewWsOutboundMessage(domain.WsTypeRotation, stored.Public()))
	if err != nil {
		slog.Error("not possible to publish rotation", slog.String("error", err.Error()))
	}

	rejoin := NewWsOutboundMessage(domain.WsTypeRejoinRequired, domain.RejoinRequired{RoomID: room.ID, Epoch: room.Epoch})
	for _, peer := range room.Peers {
		if c.psWsMsgAdapter.PublishTo(room.ID, peer.ID, rejoin) != nil {
			continue // not connected
		}

		err = c.psWsMsgAdapter.UnsubscribeFromTopic(room.ID, peer.ID)
		if err != nil {
			slog.Debug("not possible to unsubscribe from room", slog.String("error", err.Error()))
		}
	}
}

// joinRequest stores the request of a new member and passes it on to the members. The invite
// code makes the sender a pending subscriber: it gets the rotations, so it learns when it was
// approved, but no messages.
func (c *WsClient) joinRequest(req domain.JoinRequest) {
	if req.Request == "" || len(req.Request) > domain.MaxJoinRequest {
		slog.Warn("invalid join request, rejected")
		return
	}

	now := time.Now()
	var room domain.Room

	err := c.app.DB.Room.UpdateWithTTL(req.RoomID[:], func(r *domain.Room) error {
		if r.Epoch == 0 || !r.ValidInviteCode(req.InviteCode, now) || !c.useJoinCode(r.ID, req.InviteCode) {
			return domain.ErrJoinRejected
		}

		r.AddPending(c.UID, now, now.Add(domain.JoinRequestTTL))
		room = *r

		return nil
	}, c.limits.RoomStoreTTL)
	if err != nil {
		if !errors.Is(err, domain.ErrJoinRejected) && !errors.Is(err, domain.ErrObjNotFound) {
			slog.Error("not possible to handle join request", slog.String("error", err.Error()))
		}
		c.send <- NewWsOutboundMessage(domain.WsTypeJoinRejected, domain.JoinRejected{ID: req.RoomID, Reason: "code"})
		return
	}

	stored := domain.JoinRequest{RoomID: room.ID, Request: req.Request, TimeStamp: uint64(now.UnixMilli()), PeerID: c.UID.String()}
	err = c.app.DB.JoinRequest.InsertWithTTL(stored, int64(domain.JoinRequestTTL.Seconds()))
	if err != nil && !errors.Is(err, domain.ErrObjExists) {
		slog.Error("not possible to store join request", slog.String("error", err.Error()))
	}

	err = c.psWsMsgAdapter.AddSubscriberToTopic(room.ID, c.UID)
	if err != nil && !errors.Is(err, pubsub.ErrAlreadyExist) {
		slog.Error("not possible subscribe to room", slog.String("error", err.Error()))
	}

	c.send <- NewWsOutboundMessage(domain.WsTypeRoomInfo, domain.RoomInfo{ID: room.ID, TTL: room.TTL, Store: room.Store, Epoch: room.Epoch, Pending: true})

	// To the members that are online; the others get it when they join (sendRoomBacklog)
	out := NewWsOutboundMessage(domain.WsTypeJoinRequest, domain.JoinRequest{RoomID: room.ID, Request: req.Request})
	for _, peer := range room.Peers {
		if peer.Epoch == room.Epoch {
			_ = c.psWsMsgAdapter.PublishTo(room.ID, peer.ID, out) // offline: gets it on its next join
		}
	}
}

// answerRequest: a member approved or declined a join request. The request is deleted (approved)
// or kept as declined until it expires, so a requester that is offline learns it on its next
// join. A declined requester is no pending peer anymore and is told so right away if connected.
func (c *WsClient) answerRequest(a domain.AnswerRequest) {
	room, err := c.app.DB.Room.Get(a.RoomID[:])
	if err != nil || !room.IsMember(c.UID) {
		slog.Debug("answer to join request rejected, not a member")
		return
	}

	id := domain.JoinRequest{RoomID: a.RoomID, Request: a.Request}.GetID()
	req, err := c.app.DB.JoinRequest.Get(id)
	if err != nil || req.Declined {
		return // expired or answered already
	}

	if a.Approved {
		err = c.app.DB.JoinRequest.Delete(id)
		if err != nil {
			slog.Error("not possible to delete join request", slog.String("error", err.Error()))
		}
		return
	}

	req.Declined = true
	remaining := domain.JoinRequestTTL - time.Since(time.UnixMilli(int64(req.TimeStamp)))
	err = c.app.DB.JoinRequest.AddWithTTL(req, int64(max(remaining, time.Second).Seconds()))
	if err != nil {
		slog.Error("not possible to store declined join request", slog.String("error", err.Error()))
	}

	peer, err := uuid.Parse(req.PeerID)
	if err != nil {
		return
	}

	err = c.app.DB.Room.UpdateWithTTL(a.RoomID[:], func(r *domain.Room) error {
		r.RemovePending(peer, time.Now())
		return nil
	}, c.limits.RoomStoreTTL)
	if err != nil {
		slog.Error("not possible to remove pending peer", slog.String("error", err.Error()))
	}

	declined := NewWsOutboundMessage(domain.WsTypeJoinRejected, domain.JoinRejected{ID: a.RoomID, Reason: "declined"})
	if c.psWsMsgAdapter.PublishTo(a.RoomID, peer, declined) == nil {
		_ = c.psWsMsgAdapter.UnsubscribeFromTopic(a.RoomID, peer)
	}
}

// wasDeclined reports whether a member declined a join request of this client for the room
func (c *WsClient) wasDeclined(roomID uuid.UUID) bool {
	requests, err := c.app.DB.JoinRequest.GetAllSinceTimeStamp(roomID, 0)
	if err != nil {
		return false
	}

	for _, req := range requests {
		if req.Declined && req.PeerID == c.UID.String() {
			return true
		}
	}

	return false
}

// keyUpdate passes the new exchange key of a member on to the others (and keeps it for those that
// are offline until the next rotation).
func (c *WsClient) keyUpdate(u domain.KeyUpdate) {
	if u.Update == "" || len(u.Update) > domain.MaxKeyUpdate {
		slog.Warn("invalid key update, rejected")
		return
	}

	room, err := c.app.DB.Room.Get(u.RoomID[:])
	if err != nil || !room.IsMember(c.UID) || u.Epoch != room.Epoch {
		slog.Debug("key update rejected, not a member of the epoch")
		return
	}

	u.TimeStamp = uint64(time.Now().UnixMilli())
	err = c.app.DB.KeyUpdate.InsertWithTTL(u, int64(domain.KeyUpdateTTL.Seconds()))
	if err != nil && !errors.Is(err, domain.ErrObjExists) {
		slog.Error("not possible to store key update", slog.String("error", err.Error()))
		return
	}

	err = c.psWsMsgAdapter.PublishExclude(room.ID, c.UID,
		NewWsOutboundMessage(domain.WsTypeKeyUpdate, domain.KeyUpdate{RoomID: room.ID, Epoch: u.Epoch, Update: u.Update}))
	if err != nil {
		slog.Debug("not possible to forward key update", slog.String("error", err.Error()))
	}
}
