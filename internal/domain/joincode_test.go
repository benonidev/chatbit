package domain_test

import (
	"bytes"
	"chatbit/internal/domain"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
)

var (
	testSecret = bytes.Repeat([]byte{1}, domain.JoinSecretSize)
	testClient = uuid.MustParse("11111111-2222-3333-4444-555555555555")
)

// Same values are checked in the client (join_code.js) — both must derive the same codes
func TestJoinCodeVectors(t *testing.T) {
	assert.Equal(t, "abcdefgh.A3JRBDCwqbkl", domain.InviteCode(testSecret, 1000, "abcdefgh"))
	assert.Equal(t, "abcdefgh.UlQ6UlNaRcRG", domain.MemberCode(testSecret, 1000, testClient, "abcdefgh"))
}

func TestValidMemberCode(t *testing.T) {
	r := &domain.Room{JoinSecret: testSecret}
	now := time.Unix(1000*domain.JoinCodePeriod+10, 0)
	w := domain.JoinWindow(now)

	assert.True(t, r.ValidMemberCode(domain.MemberCode(testSecret, w, testClient, "n1"), testClient, now))
	assert.True(t, r.ValidMemberCode(domain.MemberCode(testSecret, w-1, testClient, "n1"), testClient, now), "previous window")
	assert.True(t, r.ValidMemberCode(domain.MemberCode(testSecret, w+1, testClient, "n1"), testClient, now), "clock ahead")
	assert.False(t, r.ValidMemberCode(domain.MemberCode(testSecret, w-2, testClient, "n1"), testClient, now), "too old")
	assert.False(t, r.ValidMemberCode(domain.MemberCode(testSecret, w, uuid.New(), "n1"), testClient, now), "code of another client")
	assert.False(t, r.ValidMemberCode(domain.InviteCode(testSecret, w, "n1"), testClient, now), "invite code is no member code")
	assert.NotEqual(t, domain.MemberCode(testSecret, w, testClient, "n1"), domain.MemberCode(testSecret, w, testClient, "n2"), "every member code differs")

	other := &domain.Room{JoinSecret: bytes.Repeat([]byte{2}, domain.JoinSecretSize)}
	assert.False(t, other.ValidMemberCode(domain.MemberCode(testSecret, w, testClient, "n1"), testClient, now), "other secret")
}

func TestValidInviteCode(t *testing.T) {
	r := &domain.Room{JoinSecret: testSecret}
	now := time.Unix(1000*domain.JoinCodePeriod+10, 0)
	w := domain.JoinWindow(now)

	assert.True(t, r.ValidInviteCode(domain.InviteCode(testSecret, w, "n1"), now))
	assert.True(t, r.ValidInviteCode(domain.InviteCode(testSecret, w-1, "n1"), now))
	assert.False(t, r.ValidInviteCode(domain.InviteCode(testSecret, w-2, "n1"), now), "expired")
	assert.False(t, r.ValidInviteCode("", now))
	assert.False(t, r.ValidInviteCode("n2."+strings.SplitN(domain.InviteCode(testSecret, w, "n1"), ".", 2)[1], now), "other nonce")
	assert.NotEqual(t, domain.InviteCode(testSecret, w, "n1"), domain.InviteCode(testSecret, w, "n2"), "every invite code differs")
}

func TestRoomWithoutJoinSecretRejectsEveryCode(t *testing.T) {
	r := &domain.Room{}
	now := time.Now()
	w := domain.JoinWindow(now)

	// Codes derived from an empty secret must not open a room that has none
	assert.False(t, r.ValidInviteCode(domain.InviteCode(nil, w, "n1"), now))
	assert.False(t, r.ValidMemberCode(domain.MemberCode(nil, w, testClient, "n1"), testClient, now))
}

func TestValidMemberCodeOfAnOlderEpoch(t *testing.T) {
	now := time.Unix(1000*domain.JoinCodePeriod+10, 0)
	w := domain.JoinWindow(now)
	old := domain.NewJoinSecret()

	// The room rotated: the current secret does not accept a code of the old one, the old one does
	r := &domain.Room{JoinSecret: domain.NewJoinSecret()}
	code := domain.MemberCode(old, w, testClient, "n1")
	assert.False(t, r.ValidMemberCode(code, testClient, now))
	assert.True(t, domain.ValidMemberCode(old, code, testClient, now))
	assert.False(t, domain.ValidMemberCode(nil, domain.MemberCode(nil, w, testClient, "n1"), testClient, now))
}

func TestUsedJoinCodeID(t *testing.T) {
	room := uuid.New()
	assert.Equal(t, domain.NewUsedJoinCode(room, "a.b").GetID(), domain.NewUsedJoinCode(room, "a.b").GetID())
	assert.NotEqual(t, domain.NewUsedJoinCode(room, "a.b").GetID(), domain.NewUsedJoinCode(uuid.New(), "a.b").GetID(), "per room")
}
