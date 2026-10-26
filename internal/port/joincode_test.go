package port

import (
	"chatbit/internal/adapter/database"
	"chatbit/internal/controller/store"
	"chatbit/internal/core"
	"chatbit/internal/domain"
	"testing"
	"time"

	badger "github.com/dgraph-io/badger/v4"
	"github.com/google/uuid"
)

func TestAllowJoin(t *testing.T) {
	bdb, err := badger.Open(badger.DefaultOptions("").WithInMemory(true).WithLogger(nil))
	if err != nil {
		t.Fatal(err)
	}
	defer bdb.Close()

	db := &database.Database{DB: bdb}
	app := &core.Application{DB: core.DB{
		UsedCode: store.NewAdapterInternal[domain.UsedJoinCode](database.NewAdapter[domain.UsedJoinCode](db)),
	}}
	client := &WsClient{UID: uuid.New(), app: app}

	now := time.Now()
	w := domain.JoinWindow(now)

	room := &domain.Room{ID: uuid.New()}
	room.AddPeer(client.UID, false)
	if client.allowJoin(room, domain.JoinRoom{}) {
		t.Fatal("room without join secret must not be joinable, not even by a member")
	}

	secret := room.EnsureJoinSecret()

	if client.allowJoin(room, domain.JoinRoom{}) {
		t.Fatal("member without code accepted")
	}

	member := domain.MemberCode(secret, w, client.UID, "m1")
	if !client.allowJoin(room, domain.JoinRoom{MemberCode: member}) {
		t.Fatal("valid member code rejected")
	}
	if client.allowJoin(room, domain.JoinRoom{MemberCode: member}) {
		t.Fatal("member code accepted twice")
	}
	if !client.allowJoin(room, domain.JoinRoom{MemberCode: domain.MemberCode(secret, w, client.UID, "m2")}) {
		t.Fatal("new member code of the next join rejected")
	}
	if client.allowJoin(room, domain.JoinRoom{MemberCode: domain.MemberCode(secret, w, uuid.New(), "m3")}) {
		t.Fatal("member code of another client accepted")
	}

	invite := domain.InviteCode(secret, w, "i1")
	if !client.allowJoin(room, domain.JoinRoom{InviteCode: invite}) {
		t.Fatal("valid invite code rejected")
	}
	if client.allowJoin(room, domain.JoinRoom{InviteCode: invite}) {
		t.Fatal("invite code accepted twice")
	}
	if client.allowJoin(room, domain.JoinRoom{InviteCode: domain.InviteCode(secret, w-2, "i2")}) {
		t.Fatal("expired invite code accepted")
	}
}
