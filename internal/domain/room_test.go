package domain_test

import (
	"chatbit/internal/domain"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
)

func TestClampTTL(t *testing.T) {
	assert.Equal(t, domain.MaxMessageTTL, domain.ClampTTL(0))
	assert.Equal(t, domain.MaxMessageTTL, domain.ClampTTL(-5))
	assert.Equal(t, domain.MaxMessageTTL, domain.ClampTTL(domain.MaxMessageTTL+1))
	assert.Equal(t, int64(3600), domain.ClampTTL(3600))
}

func TestRoomMessageTTL(t *testing.T) {
	r := &domain.Room{TTL: 3600}

	assert.Equal(t, int64(3600), r.MessageTTL(0), "no own TTL → room TTL")
	assert.Equal(t, int64(300), r.MessageTTL(300), "shorter step is allowed")
	assert.Equal(t, int64(3600), r.MessageTTL(86400), "longer TTL is capped to the room TTL")
	assert.Equal(t, int64(300), r.MessageTTL(1000), "free value is rounded down to a step")
	assert.Equal(t, int64(300), r.MessageTTL(10), "below the smallest step → smallest step")

	week := &domain.Room{TTL: 30 * 24 * 3600}
	assert.Equal(t, int64(24*3600), week.MessageTTL(2*24*3600), "2 days → 1 day")
	assert.Equal(t, int64(7*24*3600), week.MessageTTL(20*24*3600), "20 days → 7 days")

	short := &domain.Room{TTL: 120}
	assert.Equal(t, int64(120), short.MessageTTL(60), "never longer than the room TTL")

	legacy := &domain.Room{}
	assert.Equal(t, domain.MaxMessageTTL, legacy.MessageTTL(0))
}

func TestRoomSetTTLOnce(t *testing.T) {
	r := &domain.Room{}

	assert.Equal(t, int64(3600), r.SetTTLOnce(3600))
	// A second value is ignored — the TTL can only be set once
	assert.Equal(t, int64(3600), r.SetTTLOnce(60))
	assert.Equal(t, int64(3600), r.SetTTLOnce(0))

	// No TTL from the creator means the maximum, which is then fixed as well
	r2 := &domain.Room{}
	assert.Equal(t, domain.MaxMessageTTL, r2.SetTTLOnce(0))
	assert.Equal(t, domain.MaxMessageTTL, r2.SetTTLOnce(60))
}

func TestRoomSetStoreOnce(t *testing.T) {
	on, off := true, false

	r := &domain.Room{}
	assert.Nil(t, r.SetStoreOnce(nil), "no setting from the client → still unset")
	assert.True(t, *r.SetStoreOnce(&on))
	// A second value is ignored — the setting can only be set once
	assert.True(t, *r.SetStoreOnce(&off))

	r2 := &domain.Room{}
	assert.False(t, *r2.SetStoreOnce(&off))
	assert.False(t, *r2.SetStoreOnce(&on))
}

func TestRoomStoreMessages(t *testing.T) {
	on, off := true, false

	assert.True(t, (&domain.Room{Store: &on}).StoreMessages(false), "room setting wins")
	assert.False(t, (&domain.Room{Store: &off}).StoreMessages(true), "room setting wins")

	legacy := &domain.Room{}
	assert.True(t, legacy.StoreMessages(true), "room without setting → message decides")
	assert.False(t, legacy.StoreMessages(false))
}

func TestRoomMembershipPerEpoch(t *testing.T) {
	r := &domain.Room{Epoch: 3}
	peer := uuid.New()

	r.AddPeer(peer, true)
	assert.True(t, r.IsMember(peer))

	// After a rotation the peer has to join again
	r.Epoch = 4
	assert.False(t, r.IsMember(peer))
	assert.True(t, r.HasPeer(peer))

	r.AddPeer(peer, false)
	assert.True(t, r.IsMember(peer))
	assert.Len(t, r.Peers, 1, "joining again updates the entry")
	assert.False(t, r.Peers[0].Notification)
}

func TestRoomPending(t *testing.T) {
	r := &domain.Room{}
	now := time.Unix(1_000_000, 0)
	a, b := uuid.New(), uuid.New()

	r.AddPending(a, now, now.Add(time.Hour))
	r.AddPending(b, now, now.Add(time.Minute))
	assert.True(t, r.IsPending(a, now))
	assert.False(t, r.IsPending(b, now.Add(2*time.Minute)), "expired")

	// Removing one also drops the expired ones
	r.RemovePending(a, now.Add(2*time.Minute))
	assert.Empty(t, r.Pending)
}
