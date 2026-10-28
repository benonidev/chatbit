package port

import (
	"chatbit/internal/adapter/database"
	"chatbit/internal/adapter/pubsub"
	"chatbit/internal/controller/store"
	"chatbit/internal/core"
	"chatbit/internal/domain"
	"encoding/json"
	"strings"
	"testing"
	"time"

	badger "github.com/dgraph-io/badger/v4"
	"github.com/google/uuid"
)

// roomServer is the part of the server the room key protocol needs: database, pub/sub, limits
type roomServer struct {
	t      *testing.T
	app    *core.Application
	ps     *pubsub.AdapterTopic[uuid.UUID, WsOutbound]
	limits *Limits
}

func newRoomServer(t *testing.T) *roomServer {
	bdb, err := badger.Open(badger.DefaultOptions("").WithInMemory(true).WithLogger(nil))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { bdb.Close() })

	db := &database.Database{DB: bdb}
	app := &core.Application{DB: core.DB{
		Room:        store.NewAdapterInternal[*domain.Room](database.NewAdapter[*domain.Room](db)),
		Message:     store.NewMessageAdapterInternal[domain.Message](database.NewAdapterTs[domain.Message](db)),
		UsedCode:    store.NewAdapterInternal[domain.UsedJoinCode](database.NewAdapter[domain.UsedJoinCode](db)),
		Rotation:    store.NewMessageAdapterInternal[domain.Rotation](database.NewAdapterTs[domain.Rotation](db)),
		JoinRequest: store.NewMessageAdapterInternal[domain.JoinRequest](database.NewAdapterTs[domain.JoinRequest](db)),
		KeyUpdate:   store.NewMessageAdapterInternal[domain.KeyUpdate](database.NewAdapterTs[domain.KeyUpdate](db)),
	}}

	cfg := testConfig()
	cfg.RoomsPerHourPerIP = 100

	return &roomServer{t: t, app: app, ps: pubsub.NewAdapterTopic[uuid.UUID, WsOutbound](), limits: NewLimits(cfg)}
}

// connect is a client connection: its frames arrive in client.send
func (s *roomServer) connect() *WsClient {
	c := &WsClient{UID: uuid.New(), ip: "192.0.2.1", send: make(chan WsOutbound, 100), psWsMsgAdapter: s.ps, app: s.app, limits: s.limits}
	_, err := s.ps.SubscribeWithID(c.UID, c.UID, func(obj WsOutbound) { c.send <- obj })
	if err != nil {
		s.t.Fatal(err)
	}

	return c
}

// expect reads frames of c until one of type typ arrives and returns its data
func expect[T any](t *testing.T, c *WsClient, typ domain.WsMessageType) T {
	t.Helper()

	timeout := time.After(time.Second)
	for {
		select {
		case out := <-c.send:
			var msg domain.WsMessage
			if json.Unmarshal(out.Data, &msg) != nil || domain.WsMessageType(msg.Type) != typ {
				continue
			}

			var data T
			err := json.Unmarshal(msg.Data, &data)
			if err != nil {
				t.Fatal(err)
			}

			return data
		case <-timeout:
			t.Fatalf("no %s frame", typ)
		}
	}
}

func memberCode(secret []byte, uid uuid.UUID) string {
	return domain.MemberCode(secret, domain.JoinWindow(time.Now()), uid, uuid.NewString()[:8])
}

func inviteCode(secret []byte) string {
	return domain.InviteCode(secret, domain.JoinWindow(time.Now()), uuid.NewString()[:8])
}

func secret(b byte) []byte {
	return []byte(strings.Repeat(string([]byte{b}), domain.JoinSecretSize))
}

// rotateAndRejoin: c rotates to epoch with join secret j, then joins again with a code of it
func rotateAndRejoin(t *testing.T, c *WsClient, room uuid.UUID, epoch uint32, j []byte) {
	t.Helper()

	c.rotate(domain.Rotate{RoomID: room, Epoch: epoch, JoinSecret: j, Body: "body"})
	rot := expect[domain.RotationOut](t, c, domain.WsTypeRotation)
	if rot.Epoch != epoch {
		t.Fatalf("rotation for epoch %d, want %d", rot.Epoch, epoch)
	}
	expect[domain.RejoinRequired](t, c, domain.WsTypeRejoinRequired)

	c.joinRoom(domain.JoinRoom{ID: room, Epoch: epoch, MemberCode: memberCode(j, c.UID)}, 0)
	info := expect[domain.RoomInfo](t, c, domain.WsTypeRoomInfo)
	if info.Epoch != epoch || info.Pending {
		t.Fatalf("rejoin after rotation: %+v", info)
	}
}

func TestRoomEpochs(t *testing.T) {
	s := newRoomServer(t)
	room := uuid.New()
	alice, bob, dave := s.connect(), s.connect(), s.connect()

	// Alice creates the room: epoch 0, no join secret — nobody else can join yet
	alice.joinRoom(domain.JoinRoom{ID: room}, 0)
	if info := expect[domain.RoomInfo](t, alice, domain.WsTypeRoomInfo); info.Epoch != 0 {
		t.Fatalf("new room in epoch %d", info.Epoch)
	}
	bob.joinRoom(domain.JoinRoom{ID: room, Epoch: 0}, 0)
	expect[domain.JoinRejected](t, bob, domain.WsTypeJoinRejected)

	// Only the creator sends epoch 1
	bob.rotate(domain.Rotate{RoomID: room, Epoch: 1, JoinSecret: secret(9), Body: "x"})
	expect[domain.RotateRejected](t, bob, domain.WsTypeRotateRejected)
	rotateAndRejoin(t, alice, room, 1, secret(1))

	// Bob joins as member of epoch 1 (his code from J1)
	bob.joinRoom(domain.JoinRoom{ID: room, Epoch: 1, MemberCode: memberCode(secret(1), bob.UID)}, 0)
	expect[domain.RoomInfo](t, bob, domain.WsTypeRoomInfo)

	// Dave sends a join request with an invite code: he is pending, Alice and Bob get the request
	invite := inviteCode(secret(1))
	dave.joinRequest(domain.JoinRequest{RoomID: room, InviteCode: invite, Request: "request"})
	if info := expect[domain.RoomInfo](t, dave, domain.WsTypeRoomInfo); !info.Pending || info.Epoch != 1 {
		t.Fatalf("join request: %+v", info)
	}
	if req := expect[domain.JoinRequest](t, alice, domain.WsTypeJoinRequest); req.Request != "request" || req.InviteCode != "" {
		t.Fatalf("request to members: %+v", req)
	}
	expect[domain.JoinRequest](t, bob, domain.WsTypeJoinRequest)

	// The invite code works once
	other := s.connect()
	other.joinRequest(domain.JoinRequest{RoomID: room, InviteCode: invite, Request: "again"})
	expect[domain.JoinRejected](t, other, domain.WsTypeJoinRejected)

	// Dave reconnects while waiting
	dave.joinRoom(domain.JoinRoom{ID: room, Epoch: 1}, 0)
	if info := expect[domain.RoomInfo](t, dave, domain.WsTypeRoomInfo); !info.Pending {
		t.Fatal("pending peer not pending after reconnect")
	}

	// Bob goes offline; Alice approves Dave: epoch 2. Dave (pending) gets the rotation, but no
	// join secret in it
	_ = s.ps.UnsubscribeFromTopic(room, bob.UID)
	alice.rotate(domain.Rotate{RoomID: room, Epoch: 2, JoinSecret: secret(2), Body: "body-2"})
	rot := expect[domain.RotationOut](t, dave, domain.WsTypeRotation)
	if rot.Epoch != 2 || rot.Body != "body-2" {
		t.Fatalf("rotation to pending peer: %+v", rot)
	}
	expect[domain.RejoinRequired](t, alice, domain.WsTypeRejoinRequired)

	dave.joinRoom(domain.JoinRoom{ID: room, Epoch: 2, MemberCode: memberCode(secret(2), dave.UID)}, 0)
	if info := expect[domain.RoomInfo](t, dave, domain.WsTypeRoomInfo); info.Pending || info.Epoch != 2 {
		t.Fatalf("approved member: %+v", info)
	}
	alice.joinRoom(domain.JoinRoom{ID: room, Epoch: 2, MemberCode: memberCode(secret(2), alice.UID)}, 0)
	expect[domain.RoomInfo](t, alice, domain.WsTypeRoomInfo)

	// Bob comes back with a code of epoch 1: he gets the rotations since then, not a subscription
	bob.joinRoom(domain.JoinRoom{ID: room, Epoch: 1, MemberCode: memberCode(secret(1), bob.UID)}, 0)
	rej := expect[domain.JoinRejected](t, bob, domain.WsTypeJoinRejected)
	if rej.Reason != "rotated" || len(rej.Rotations) != 1 || rej.Rotations[0].Epoch != 2 {
		t.Fatalf("catch-up: %+v", rej)
	}

	// A code of epoch 1 is not good for epoch 2 (a removed member has no J2)
	bob.joinRoom(domain.JoinRoom{ID: room, Epoch: 2, MemberCode: memberCode(secret(1), bob.UID)}, 0)
	if rej := expect[domain.JoinRejected](t, bob, domain.WsTypeJoinRejected); rej.Reason != "code" {
		t.Fatalf("old code for the new epoch: %+v", rej)
	}

	// Two rotations for epoch 3: the first wins
	alice.rotate(domain.Rotate{RoomID: room, Epoch: 3, JoinSecret: secret(3), Body: "a"})
	expect[domain.RotationOut](t, alice, domain.WsTypeRotation)
	dave.rotate(domain.Rotate{RoomID: room, Epoch: 3, JoinSecret: secret(4), Body: "d"})
	if r := expect[domain.RotateRejected](t, dave, domain.WsTypeRotateRejected); r.Current != 3 {
		t.Fatalf("rejected rotation: %+v", r)
	}

	// After the rotation Dave is no member until he joins again — he can not rotate either
	dave.rotate(domain.Rotate{RoomID: room, Epoch: 4, JoinSecret: secret(4), Body: "d"})
	expect[domain.RotateRejected](t, dave, domain.WsTypeRotateRejected)

	r, err := s.app.DB.Room.Get(room[:])
	if err != nil {
		t.Fatal(err)
	}
	if r.Epoch != 3 || string(r.JoinSecret) != string(secret(3)) || r.IsMember(dave.UID) {
		t.Fatalf("room after rotations: epoch %d, member dave %v", r.Epoch, r.IsMember(dave.UID))
	}
}

func TestJoinRequestBacklog(t *testing.T) {
	s := newRoomServer(t)
	room := uuid.New()
	alice, dave := s.connect(), s.connect()

	alice.joinRoom(domain.JoinRoom{ID: room}, 0)
	expect[domain.RoomInfo](t, alice, domain.WsTypeRoomInfo)
	rotateAndRejoin(t, alice, room, 1, secret(1))

	// Alice is offline when Dave asks — she gets the request on her next join
	_ = s.ps.UnsubscribeFromTopic(room, alice.UID)
	dave.joinRequest(domain.JoinRequest{RoomID: room, InviteCode: inviteCode(secret(1)), Request: "dave"})
	expect[domain.RoomInfo](t, dave, domain.WsTypeRoomInfo)

	alice.joinRoom(domain.JoinRoom{ID: room, Epoch: 1, MemberCode: memberCode(secret(1), alice.UID)}, 0)
	if req := expect[domain.JoinRequest](t, alice, domain.WsTypeJoinRequest); req.Request != "dave" {
		t.Fatalf("backlog: %+v", req)
	}

	// Key updates are only accepted from members of the epoch and go to the others
	alice.keyUpdate(domain.KeyUpdate{RoomID: room, Epoch: 1, Update: "u"})
	stored, err := s.app.DB.KeyUpdate.GetAllSinceTimeStamp(room, 0)
	if err != nil || len(stored) != 1 {
		t.Fatalf("key update stored: %v %d", err, len(stored))
	}
	dave.keyUpdate(domain.KeyUpdate{RoomID: room, Epoch: 1, Update: "forged"})
	stored, _ = s.app.DB.KeyUpdate.GetAllSinceTimeStamp(room, 0)
	if len(stored) != 1 {
		t.Fatal("key update of a pending peer accepted")
	}

	// A rotation deletes the key updates of the old epoch
	rotateAndRejoin(t, alice, room, 2, secret(2))
	stored, _ = s.app.DB.KeyUpdate.GetAllSinceTimeStamp(room, 0)
	if len(stored) != 0 {
		t.Fatal("key updates kept after the rotation")
	}
}

func TestAnswerJoinRequest(t *testing.T) {
	s := newRoomServer(t)
	room := uuid.New()
	alice, dave, eve := s.connect(), s.connect(), s.connect()

	alice.joinRoom(domain.JoinRoom{ID: room}, 0)
	expect[domain.RoomInfo](t, alice, domain.WsTypeRoomInfo)
	rotateAndRejoin(t, alice, room, 1, secret(1))

	// Dave asks while connected; Alice declines — Dave is told right away
	dave.joinRequest(domain.JoinRequest{RoomID: room, InviteCode: inviteCode(secret(1)), Request: "dave"})
	expect[domain.RoomInfo](t, dave, domain.WsTypeRoomInfo)
	expect[domain.JoinRequest](t, alice, domain.WsTypeJoinRequest)

	// Only members may answer
	eve.answerRequest(domain.AnswerRequest{RoomID: room, Request: "dave"})
	alice.answerRequest(domain.AnswerRequest{RoomID: room, Request: "dave"})
	if rej := expect[domain.JoinRejected](t, dave, domain.WsTypeJoinRejected); rej.Reason != "declined" {
		t.Fatalf("declined requester got %+v", rej)
	}

	// The request is not sent to members anymore (after every login it came again before)
	alice.joinRoom(domain.JoinRoom{ID: room, Epoch: 1, MemberCode: memberCode(secret(1), alice.UID)}, 0)
	expect[domain.RoomInfo](t, alice, domain.WsTypeRoomInfo)
	select {
	case out := <-alice.send:
		var msg domain.WsMessage
		_ = json.Unmarshal(out.Data, &msg)
		if domain.WsMessageType(msg.Type) == domain.WsTypeJoinRequest {
			t.Fatal("declined request sent again")
		}
	case <-time.After(100 * time.Millisecond):
	}

	// Dave was offline: on his next join he learns that he was declined
	dave.joinRoom(domain.JoinRoom{ID: room, Epoch: 1}, 0)
	if rej := expect[domain.JoinRejected](t, dave, domain.WsTypeJoinRejected); rej.Reason != "declined" {
		t.Fatalf("declined requester after reconnect: %+v", rej)
	}

	// An approved request is deleted
	eve.joinRequest(domain.JoinRequest{RoomID: room, InviteCode: inviteCode(secret(1)), Request: "eve"})
	expect[domain.RoomInfo](t, eve, domain.WsTypeRoomInfo)
	alice.answerRequest(domain.AnswerRequest{RoomID: room, Request: "eve", Approved: true})
	stored, _ := s.app.DB.JoinRequest.GetAllSinceTimeStamp(room, 0)
	for _, req := range stored {
		if req.Request == "eve" {
			t.Fatal("approved request kept")
		}
	}
}

// A join gets every stored message from `since` on, per room and including that millisecond,
// then room_synced with the newest timestamp sent
func TestMissedMessagesSince(t *testing.T) {
	s := newRoomServer(t)
	room := uuid.New()
	alice := s.connect()

	alice.joinRoom(domain.JoinRoom{ID: room}, 0)
	expect[domain.RoomInfo](t, alice, domain.WsTypeRoomInfo)
	rotateAndRejoin(t, alice, room, 1, secret(1))
	expect[domain.RoomSynced](t, alice, domain.WsTypeRoomSynced) // of the rejoin

	for _, ts := range []uint64{100, 200, 200, 300} {
		err := s.app.DB.Message.InsertWithTTL(domain.Message{ID: uuid.New(), RoomID: room, TimeStamp: ts, Epoch: 1}, 60)
		if err != nil {
			t.Fatal(err)
		}
	}

	// joins and returns the timestamps of the missed messages and the until of room_synced
	join := func(since *uint64, lastConnectionTime uint64) ([]uint64, uint64) {
		t.Helper()
		alice.joinRoom(domain.JoinRoom{ID: room, Epoch: 1, MemberCode: memberCode(secret(1), alice.UID), Since: since}, lastConnectionTime)

		var got []uint64
		timeout := time.After(time.Second)
		for {
			select {
			case out := <-alice.send:
				var msg domain.WsMessage
				if json.Unmarshal(out.Data, &msg) != nil {
					continue
				}
				switch domain.WsMessageType(msg.Type) {
				case domain.WsTypeMessage:
					var m domain.Message
					_ = json.Unmarshal(msg.Data, &m)
					got = append(got, m.TimeStamp)
				case domain.WsTypeRoomSynced:
					var synced domain.RoomSynced
					_ = json.Unmarshal(msg.Data, &synced)
					return got, synced.Until
				}
			case <-timeout:
				t.Fatal("no room_synced frame")
			}
		}
	}
	ptr := func(v uint64) *uint64 { return &v }

	// Both messages of the same millisecond, also the one the client may not have yet
	got, until := join(ptr(200), 0)
	if len(got) != 3 || until != 300 {
		t.Fatalf("since 200: messages %v, until %d", got, until)
	}

	// The per room cursor wins over the old global time
	got, _ = join(ptr(0), 250)
	if len(got) != 4 {
		t.Fatalf("since 0: messages %v", got)
	}

	// Without since: the old global time (older clients)
	got, until = join(nil, 250)
	if len(got) != 1 || until != 300 {
		t.Fatalf("lastConnectionTime 250: messages %v, until %d", got, until)
	}

	// Nothing new: until stays at since
	got, until = join(ptr(301), 0)
	if len(got) != 0 || until != 301 {
		t.Fatalf("since 301: messages %v, until %d", got, until)
	}
}
