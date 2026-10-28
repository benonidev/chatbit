package port

import (
	"bytes"
	"chatbit/internal/adapter/pubsub"
	"chatbit/internal/adapter/vapid"
	"chatbit/internal/core"
	"chatbit/internal/domain"
	"encoding/json"
	"errors"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/SherClockHolmes/webpush-go"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	// Time allowed to write a message to the peer.
	writeWait = 10 * time.Second

	// Time allowed to read the next pong message from the peer.
	pongWait = 60 * time.Second

	// Send pings to peer with this period. Must be less than pongWait.
	pingPeriod = (pongWait * 9) / 10

	// Maximum message size allowed from peer.
	// Must be larger than the binary chunk size (64 KB + 20 byte header).
	maxMessageSize = 128 * 1024
)

var (
	newline = []byte{'\n'}
	space   = []byte{' '}
)

type WsOutbound struct {
	MsgType int // websocket.TextMessage or websocket.BinaryMessage
	Data    []byte
}

func NewWsOutboundMessage(msgType domain.WsMessageType, msg any) WsOutbound {
	msgB, err := json.Marshal(msg)
	if err != nil {
		slog.Error("not possible to unmarshal ws message ", slog.String("error", err.Error()))
	}

	wsMsg := domain.WsMessage{
		Type: string(msgType),
		Data: msgB,
	}

	wsData, err := json.Marshal(wsMsg)
	if err != nil {
		slog.Error("not possible to unmarshal ws message ", slog.String("error", err.Error()))
	}

	return WsOutbound{MsgType: websocket.TextMessage, Data: wsData}
}

type WsClient struct {
	// The websocket connection.
	conn   *websocket.Conn
	ticker *time.Ticker

	// Buffered channel of outbound messages.
	send           chan WsOutbound
	UID            uuid.UUID
	ip             string
	psWsMsgAdapter *pubsub.AdapterTopic[uuid.UUID, WsOutbound]
	app            *core.Application
	hub            *wsHandler
	limits         *Limits
	connLimits     connLimits

	// File Transfer
	fileTransfer   map[uuid.UUID]*domain.Transfer
	fileTransferMu sync.Mutex
}

func init() {
	dir := os.Getenv("IMAGE_TMP_DIR")
	if dir != "" {
		domain.FileDir = dir
	}

	// Create the directory up front, otherwise the hourly file cleanup fails until the first upload
	err := os.MkdirAll(domain.FileDir, 0o755)
	if err != nil {
		slog.Error("not possible to create file directory", slog.String("dir", domain.FileDir), slog.String("error", err.Error()))
	}
	slog.Info("FileDir", slog.String("Dir", domain.FileDir))
}

// readPump pumps messages from the websocket connection to the hub.
//
// The application runs readPump in a per-connection goroutine. The application
// ensures that there is at most one reader on a connection by executing all
// reads from this goroutine.
func (c *WsClient) readPump() {
	defer func() {
		slog.Debug("client disconnected readPump", slog.String("UID", c.UID.String()))
		c.ticker.Stop()
		c.conn.Close()
		c.limits.ReleaseConn(c.ip)

		// A newer connection with the same client id took over — it owns the subscription now
		if !c.hub.unregister(c) {
			return
		}

		// LastSeen is the time the peer was last online, so it has to be set on disconnect too —
		// otherwise a peer that stayed connected for more than a week counts as offline immediately.
		err := c.app.DB.Peer.Add(domain.Peer{
			ID:       c.UID,
			LastSeen: time.Now(),
		})
		if err != nil {
			slog.Error("not possible update peer last seen time", slog.String("error", err.Error()))
		}
	}()

	slog.Debug("peer connected", slog.String("peerID:", c.UID.String()))

	err := c.app.DB.Peer.Add(domain.Peer{
		ID:       c.UID,
		LastSeen: time.Now(),
	})
	if err != nil {
		slog.Error("not possible update peer last connection time", slog.String("error", err.Error()))
	}

	c.conn.SetReadLimit(maxMessageSize)

	// Replaces the short deadline for the hello frame; every pong extends it
	err = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	if err != nil {
		slog.Error("error during SetReadDeadline", slog.String("error", err.Error()))
	}

	c.conn.SetPongHandler(func(string) error {
		slog.Debug("receive pong", slog.String("UID:", c.UID.String()))

		err = c.conn.SetReadDeadline(time.Now().Add(pongWait))
		if err != nil {
			slog.Error("error during SetReadDeadline", slog.String("error", err.Error()))
		}

		return nil
	})

	for {
		msgType, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("error: %v", err)
			}

			slog.Debug("client disconnected", slog.String("UID", c.UID.String()), slog.String("error", err.Error()))

			break
		}

		if msgType == websocket.BinaryMessage {
			c.handleChunk(message)
			continue
		}

		message = bytes.TrimSpace(bytes.ReplaceAll(message, newline, space))

		wsMsg := domain.WsMessage{}

		err = json.Unmarshal(message, &wsMsg)
		if err != nil {
			slog.Error("not possible to unmarshal ws message ", slog.String("error", err.Error()))
			continue
		}

		if !c.allowFrame(domain.WsMessageType(wsMsg.Type)) {
			if c.connLimits.violations > maxViolations {
				slog.Warn("too many frames over the limit, connection closed")
				closeWith(c.conn, websocket.ClosePolicyViolation, "rate limit")
				break
			}
			continue
		}

		switch domain.WsMessageType(wsMsg.Type) {
		case domain.WsTypeMessage:
			msg, ok := unmarshalWs[domain.Message](wsMsg.Data)
			if !ok {
				continue
			}

			room, err := c.app.DB.Room.Get(msg.RoomID[:])
			if err != nil {
				slog.Error("not possible to get room", slog.String("error", err.Error()))
				continue
			}

			// Only members of the current epoch, with the key of the current epoch. A message that
			// was on its way during a rotation is rejected — the client sends it again.
			if !room.IsMember(c.UID) || msg.Epoch != room.Epoch {
				slog.Debug("message rejected, not a member of the current epoch")
				c.send <- NewWsOutboundMessage(domain.WsTypeMessageRejected, domain.MessageRejected{ID: msg.ID, RoomID: msg.RoomID, Reason: "epoch"})
				continue
			}

			// The room TTL is the upper limit, a message may only be shorter. The server time is
			// used as timestamp, so every client calculates the same expiry (the client clock may be wrong).
			msg.TTL = room.MessageTTL(msg.TTL)
			msg.Store = room.StoreMessages(msg.Store)
			msg.TimeStamp = uint64(time.Now().UnixMilli())
			// Newer than the last clean, also in the same millisecond: the clients delete
			// everything up to the clean (e.g. the "cleared the chat" message that follows it)
			if msg.TimeStamp <= room.CleanedAt {
				msg.TimeStamp = room.CleanedAt + 1
			}

			message, err = marshalWs(domain.WsTypeMessage, msg)
			if err != nil {
				slog.Error("not possible to marshal message", slog.String("error", err.Error()))
				continue
			}

			// Stored before it is forwarded: a message id that exists already is rejected and not
			// forwarded, so nobody can replace a message of someone else.
			if msg.Store {
				err = c.app.DB.Message.InsertWithTTL(msg, domain.ClampTTL(msg.TTL))
				if errors.Is(err, domain.ErrObjExists) {
					slog.Warn("message id exists already, rejected")
					continue
				}
				if err != nil {
					slog.Error("not possible to store message in database", slog.String("error", err.Error()))
				}
			}

			// Activity keeps the room alive; rooms without activity expire (RoomStoreTTL)
			err = c.app.DB.Room.UpdateWithTTL(room.ID[:], func(*domain.Room) error { return nil }, c.limits.RoomStoreTTL)
			if err != nil {
				slog.Error("not possible to refresh room", slog.String("error", err.Error()))
			}

			for _, peer := range room.Peers {
				err = c.psWsMsgAdapter.PublishTo(msg.RoomID, peer.ID, WsOutbound{MsgType: websocket.TextMessage, Data: message})
				if err != nil {
					slog.Debug("not possible send message over ws, peer is offline", slog.String("peer", peer.ID.String()), slog.String("error", err.Error()))
					p, err := c.app.DB.Peer.Get(peer.ID[:])
					if err != nil {
						// Without the peer we don't know LastSeen — don't remove it from the room
						slog.Error("not possible to get peer", slog.String("error", err.Error()))
						continue
					}

					if p.LastSeen.Before(time.Now().Add(-24 * 7 * time.Hour)) {
						slog.Debug("peer offline, will be removed from room", slog.String("room", msg.RoomID.String()), slog.String("peerID", peer.ID.String()), slog.String("peerOfflineSince", p.LastSeen.Format(time.RFC3339)))

						err = c.app.DB.Room.UpdateWithTTL(msg.RoomID[:], func(r *domain.Room) error {
							r.RemovePeer(peer.ID)

							slog.Debug("remove peer from room", slog.String("room", r.ID.String()), slog.String("peer", peer.ID.String()))

							return nil
						}, c.limits.RoomStoreTTL)
						if err != nil {
							slog.Error("not possible to remove offline peer from room", slog.String("error", err.Error()))
						}

						continue
					}

					if peer.Notification && c.limits.AllowPush(peer.ID) {
						slog.Debug("send push notification", slog.String("peer", peer.ID.String()), slog.String("peerOfflineSince", p.LastSeen.Format(time.RFC3339)))
						c.sendPushNotification(peer.ID)
					}

					continue
				}
			}
		case domain.WsTypeLeaveRoom:
			leave, ok := unmarshalWs[domain.LeaveRooms](wsMsg.Data)
			if !ok {
				continue
			}

			for _, room := range leave.Rooms {
				slog.Debug("peer will leave room", slog.String("room", room.String()), slog.String("peer", c.UID.String()))
				// Not subscribed is normal (after a rotation, or a removed member) — the peer is
				// removed from the room anyway, otherwise it would keep getting push notifications
				err = c.psWsMsgAdapter.UnsubscribeFromTopic(room, c.UID)
				if err != nil {
					slog.Debug("not subscribed to the room while leaving", slog.String("error", err.Error()))
				}

				roomEmpty := false

				err = c.app.DB.Room.UpdateWithTTL(room[:], func(r *domain.Room) error {
					r.RemovePeer(c.UID)
					r.RemovePending(c.UID, time.Now())
					roomEmpty = len(r.Peers) == 0 && len(r.Pending) == 0

					return nil
				}, c.limits.RoomStoreTTL)
				if err != nil {
					slog.Error("not possible to update room", slog.String("error", err.Error()))
					continue
				}

				if roomEmpty {
					c.deleteRoomIfUnused(room)
				}
			}
		case domain.WsTypeCleanRoom:
			clean, ok := unmarshalWs[domain.CleanRoom](wsMsg.Data)
			if !ok {
				continue
			}

			c.cleanRoom(clean.ID)
		case domain.WsTypeJoinRoom:
			join, ok := unmarshalWs[domain.JoinRooms](wsMsg.Data)
			if !ok {
				continue
			}

			// One frame with thousands of rooms would keep the server busy
			if len(join.Rooms) > c.limits.cfg.MaxRoomsPerJoin {
				slog.Warn("too many rooms in one join, cut", slog.Int("rooms", len(join.Rooms)))
				join.Rooms = join.Rooms[:c.limits.cfg.MaxRoomsPerJoin]
			}

			for _, room := range join.Rooms {
				c.joinRoom(room, join.LastConnectionTime)
			}
		case domain.WsTypeCreateRoom:
			room, ok := unmarshalWs[domain.Room](wsMsg.Data)
			if !ok {
				continue
			}

			// Only create — an existing room (peers, TTL) must never be overwritten
			_, err = c.app.DB.Room.Get(room.ID[:])
			if !errors.Is(err, domain.ErrObjNotFound) {
				slog.Warn("room already exists, not created again")
				continue
			}

			if !c.limits.AllowRoomCreate(c.ip) {
				slog.Warn("room creation limit reached")
				continue
			}

			room.TTL = domain.ClampTTL(room.TTL)
			room.Peers = []domain.RoomPeer{{ID: c.UID}}
			room.CleanedAt = 0
			room.Epoch = 0        // the creator sends the first rotation
			room.JoinSecret = nil // only from rotations
			room.Pending = nil

			err = c.app.DB.Room.AddWithTTL(&room, c.limits.RoomStoreTTL(&room))
			if err != nil {
				slog.Error("not possible to create new room", slog.String("error", err.Error()))
				continue
			}

		case domain.WsTypeRotate:
			rot, ok := unmarshalWs[domain.Rotate](wsMsg.Data)
			if !ok {
				continue
			}

			c.rotate(rot)
		case domain.WsTypeJoinRequest:
			req, ok := unmarshalWs[domain.JoinRequest](wsMsg.Data)
			if !ok {
				continue
			}

			c.joinRequest(req)
		case domain.WsTypeAnswerRequest:
			answer, ok := unmarshalWs[domain.AnswerRequest](wsMsg.Data)
			if !ok {
				continue
			}

			c.answerRequest(answer)
		case domain.WsTypeKeyUpdate:
			update, ok := unmarshalWs[domain.KeyUpdate](wsMsg.Data)
			if !ok {
				continue
			}

			c.keyUpdate(update)
		case domain.WsTypeSubscribePush:
			push, ok := unmarshalWs[domain.Push](wsMsg.Data)
			if !ok {
				continue
			}

			push.ID = c.UID

			// Only the push services of the browsers — any other address would let a client
			// make the server send requests into the internal network
			if !vapid.ValidEndpoint(push.Endpoint) {
				slog.Warn("push endpoint rejected, not a known push service")
				continue
			}

			slog.Debug("subscribe push notifications", slog.String("UID", c.UID.String()))

			err = c.app.DB.Push.Add(push)
			if err != nil {
				slog.Error("not possible to add pushID", slog.String("error", err.Error()))
				continue
			}
		case domain.WsTypeFileTransferStart:
			file, ok := unmarshalWs[domain.File](wsMsg.Data)
			if !ok {
				continue
			}

			if !c.handleTransferStart(&file) {
				continue // rejected — not announced to the room
			}

			err = c.psWsMsgAdapter.PublishExclude(file.RoomID, c.UID, WsOutbound{MsgType: websocket.TextMessage, Data: message})
			if err != nil {
				slog.Error("not possible to handle transfer start", slog.String("error", err.Error()))
				continue
			}
		case domain.WsTypeFileTransferDone:
			file, ok := unmarshalWs[domain.File](wsMsg.Data)
			if !ok {
				continue
			}

			if !c.handleTransferDone(&file) {
				continue // incomplete or rejected — not announced to the room
			}

			err = c.psWsMsgAdapter.Publish(file.RoomID, WsOutbound{MsgType: websocket.TextMessage, Data: message})
			if err != nil {
				slog.Error("not possible to handle transfer done", slog.String("error", err.Error()))
				continue
			}

		case domain.WsTypeFileTransferRequest:
			file, ok := unmarshalWs[domain.File](wsMsg.Data)
			if !ok {
				continue
			}

			err = c.sendFileTransferStart(&file)
			if err != nil {
				slog.Error("not possible to start transfer", slog.String("error", err.Error()))
				continue
			}
		}
	}
}

func (c *WsClient) writePump() {
	c.ticker = time.NewTicker(pingPeriod)
	defer func() {
		slog.Debug("client disconnected writePump", slog.String("UID", c.UID.String()))
		c.ticker.Stop()
		c.conn.Close()
	}()

	var err error

	for {
		select {
		case message, ok := <-c.send:
			if !ok {
				// The channel is closed
				slog.Error("channel closed from unsubscribe event")
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{}) // best effort, the connection is closed anyway
				return
			}

			err = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err != nil {
				// There is no deadline set, so the connection is dead
				slog.Error("not possible to write deadliner", slog.String("error", err.Error()))
				return
			}

			err = c.conn.WriteMessage(message.MsgType, message.Data)
			if err != nil {
				slog.Error("not possible to write message", slog.String("error", err.Error()))

				return
			}

		case <-c.ticker.C:
			err = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err != nil {
				// There is no deadline set, so the connection is dead
				slog.Error("not possible to write deadliner", slog.String("error", err.Error()))
				return
			}

			slog.Debug("send ping", slog.String("UID:", c.UID.String()))

			err = c.conn.WriteMessage(websocket.PingMessage, nil)
			if err != nil {
				slog.Error("not possible to write Ping message", slog.String("error", err.Error()))

				return
			}
		}
	}
}

// marshalWs builds a WebSocket frame {type, data}.
func marshalWs(msgType domain.WsMessageType, data any) ([]byte, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}

	return json.Marshal(domain.WsMessage{Type: string(msgType), Data: raw})
}

// useJoinCode marks the code as used. Returns false if it was used before.
func (c *WsClient) useJoinCode(roomID uuid.UUID, code string) bool {
	err := c.app.DB.UsedCode.InsertWithTTL(domain.NewUsedJoinCode(roomID, code), int64(domain.JoinCodeLifetime.Seconds()))
	if errors.Is(err, domain.ErrObjExists) {
		slog.Warn("join code used again, rejected", slog.String("room", roomID.String()))
		return false
	}
	if err != nil {
		slog.Error("not possible to store used join code", slog.String("error", err.Error()))
		return false
	}

	return true
}

// cleanRoom deletes all stored messages and uploaded files of the room and tells the other
// members to delete their local messages as well. Only a member of the room may do this.
func (c *WsClient) cleanRoom(roomID uuid.UUID) {
	cleanedAt := uint64(time.Now().UnixMilli())

	err := c.app.DB.Room.UpdateWithTTL(roomID[:], func(r *domain.Room) error {
		if !r.IsMember(c.UID) {
			return domain.ErrNotMember
		}

		r.CleanedAt = cleanedAt

		return nil
	}, c.limits.RoomStoreTTL)
	if err != nil {
		slog.Warn("clean room rejected", slog.String("room", roomID.String()), slog.String("error", err.Error()))
		return
	}

	slog.Debug("peer will clean room", slog.String("room", roomID.String()), slog.String("peer", c.UID.String()))

	c.deleteRoomContent(roomID)

	// Members that are offline get the clean on their next join (Room.CleanedAt)
	err = c.psWsMsgAdapter.PublishExclude(roomID, c.UID,
		NewWsOutboundMessage(domain.WsTypeCleanRoom, domain.CleanRoom{ID: roomID, Timestamp: cleanedAt}))
	if err != nil {
		slog.Debug("not possible to forward clean room", slog.String("error", err.Error()))
	}
}

// deleteRoomIfUnused deletes a room that has no members and no messages left. A room with
// messages is kept, so a member can join again with the invite code; it expires by itself
// (RoomStoreTTL) after the last message.
func (c *WsClient) deleteRoomIfUnused(roomID uuid.UUID) {
	msgs, err := c.app.DB.Message.GetAllSinceTimeStamp(roomID, 0)
	if err != nil {
		slog.Error("not possible to get messages of room", slog.String("error", err.Error()))
		return
	}

	if len(msgs) > 0 {
		slog.Debug("room has no peers but messages, kept", slog.String("room", roomID.String()))
		return
	}

	slog.Debug("room has no peers and no messages, will be deleted", slog.String("room", roomID.String()))

	err = c.app.DB.Room.Delete(roomID[:])
	if err != nil {
		slog.Error("not possible to delete room", slog.String("error", err.Error()))
	}

	c.deleteRoomContent(roomID)
	c.deleteRoomKeys(roomID)
}

// deleteRoomContent deletes all stored messages and uploaded files of the room.
func (c *WsClient) deleteRoomContent(roomID uuid.UUID) {
	err := c.app.DB.Message.DeleteAll(roomID)
	if err != nil {
		slog.Error("not possible to delete messages of room", slog.String("error", err.Error()))
	}

	err = os.RemoveAll(filepath.Join(domain.FileDir, roomID.String()))
	if err != nil {
		slog.Error("not possible to delete files of room", slog.String("error", err.Error()))
	}
}

// deleteRoomKeys deletes the rotation log, join requests and key updates of a deleted room
func (c *WsClient) deleteRoomKeys(roomID uuid.UUID) {
	for _, del := range []func(uuid.UUID) error{c.app.DB.Rotation.DeleteAll, c.app.DB.JoinRequest.DeleteAll, c.app.DB.KeyUpdate.DeleteAll} {
		err := del(roomID)
		if err != nil {
			slog.Error("not possible to delete room keys", slog.String("error", err.Error()))
		}
	}
}

func unmarshalWs[T any](data json.RawMessage) (T, bool) {
	var v T
	err := json.Unmarshal(data, &v)
	if err != nil {
		slog.Error("not possible to Unmarshal message", slog.String("error", err.Error()))
		return v, false
	}

	return v, true
}

func (c *WsClient) sendPushNotification(peerID uuid.UUID) {
	pushID, err := c.app.DB.Push.Get(peerID[:])
	if err != nil {
		slog.Error("not possible to get pushID", slog.String("error", err.Error()))
		return
	}

	sub := &webpush.Subscription{
		Endpoint: pushID.Endpoint,
		Keys: webpush.Keys{
			P256dh: pushID.P256DH,
			Auth:   pushID.Auth,
		},
	}

	slog.Debug("Message published", slog.String("peer:", peerID.String()), slog.String("AliasID:", pushID.ID.String()))

	body, _ := json.Marshal(map[string]string{
		"title": "- ChatBit -",
		"body":  "🔒 New message",
		"url":   "/",
	})

	option := webpush.Options{
		Subscriber:      "info@benoni.dev",
		VAPIDPublicKey:  vapid.Keys().PublicKey,
		VAPIDPrivateKey: vapid.Keys().PrivateKey,
		TTL:             30,
		HTTPClient:      vapid.HTTPClient(), // refuses internal addresses
	}

	resp, err := webpush.SendNotification(body, sub, &option)
	if err != nil {
		// resp is nil here — returning avoids a nil pointer panic that would crash the server
		slog.Error("not possible to send push notification", slog.String("error", err.Error()))
		return
	}

	defer resp.Body.Close()
}

// allowFrame applies the rate limits of the connection and of its IP. Dropped frames count as
// violations; too many of them close the connection.
func (c *WsClient) allowFrame(msgType domain.WsMessageType) bool {
	now := time.Now()
	cfg := c.limits.cfg

	ok := true
	switch msgType {
	case domain.WsTypeMessage:
		ok = c.connLimits.messages.allow(now, cfg.MessagesPerSecond, float64(cfg.MessageBurst), 1) &&
			c.limits.AllowMessageIP(c.ip)
	case domain.WsTypeJoinRoom, domain.WsTypeCreateRoom, domain.WsTypeLeaveRoom, domain.WsTypeCleanRoom, domain.WsTypeSubscribePush,
		domain.WsTypeRotate, domain.WsTypeJoinRequest, domain.WsTypeKeyUpdate, domain.WsTypeAnswerRequest:
		ok = c.connLimits.joins.allow(now, cfg.JoinsPerSecond, cfg.JoinsPerSecond*5, 1)
	}

	if !ok {
		c.connLimits.violations++
		slog.Debug("frame dropped, rate limit", slog.String("type", string(msgType)))
	}

	return ok
}
