package domain

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Join codes prove that a client may join a room. Both are derived from the join secret of the
// current epoch (HMAC-SHA256, first JoinCodeBytes bytes, base64url), a time window and a random
// nonce, which makes every code different. Every code is valid once (see UsedJoinCode). The join
// secret is set by every rotation (rotation.go), so a removed member can not join anymore:
//
//   - invite code: "<nonce>.<HMAC(secret, "invite:<window>:<nonce>")>" — in the invite QR code
//   - member code: "<nonce>.<HMAC(secret, "member:<window>:<clientUid>:<nonce>")>" — a new one
//     with every join of a member, only valid for this client
//
// The window before and after the current one is accepted as well, for clocks that are off.
const (
	JoinCodePeriod = 300 // seconds per window
	JoinCodeBytes  = 9
	JoinSecretSize = 32
	maxNonceLength = 16

	// JoinCodeLifetime is the longest time a code is accepted (three windows) — used codes are
	// remembered this long
	JoinCodeLifetime = 3 * JoinCodePeriod * time.Second
)

// JoinWindow returns the time window of t.
func JoinWindow(t time.Time) int64 {
	return t.Unix() / JoinCodePeriod
}

// NewJoinSecret returns a random join secret.
func NewJoinSecret() []byte {
	secret := make([]byte, JoinSecretSize)
	_, _ = rand.Read(secret) // never fails (crypto/rand)

	return secret
}

func InviteCode(secret []byte, window int64, nonce string) string {
	return nonce + "." + joinCode(secret, fmt.Sprintf("invite:%d:%s", window, nonce))
}

func MemberCode(secret []byte, window int64, clientUID uuid.UUID, nonce string) string {
	return nonce + "." + joinCode(secret, fmt.Sprintf("member:%d:%s:%s", window, clientUID.String(), nonce))
}

func joinCode(secret []byte, msg string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(msg))

	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:JoinCodeBytes])
}

// ValidMemberCode reports whether code is a member code of clientUID for the join secret of the
// current epoch, in a window around now. Whether it was used before is checked by the caller.
func (r *Room) ValidMemberCode(code string, clientUID uuid.UUID, now time.Time) bool {
	return ValidMemberCode(r.JoinSecret, code, clientUID, now)
}

// ValidInviteCode reports whether code is an invite code of the current epoch in a window
// around now. Whether it was used before is checked by the caller.
func (r *Room) ValidInviteCode(code string, now time.Time) bool {
	return validCode(r.JoinSecret, code, now, func(window int64, nonce string) string {
		return InviteCode(r.JoinSecret, window, nonce)
	})
}

// ValidMemberCode checks a member code against any join secret (e.g. of an older epoch)
func ValidMemberCode(secret []byte, code string, clientUID uuid.UUID, now time.Time) bool {
	return validCode(secret, code, now, func(window int64, nonce string) string {
		return MemberCode(secret, window, clientUID, nonce)
	})
}

func validCode(secret []byte, code string, now time.Time, derive func(window int64, nonce string) string) bool {
	// Without a secret every code could be derived — such a room can not be joined
	if len(secret) == 0 {
		return false
	}

	nonce, _, ok := strings.Cut(code, ".")
	if !ok || nonce == "" || len(nonce) > maxNonceLength {
		return false
	}

	w := JoinWindow(now)
	for _, window := range []int64{w - 1, w, w + 1} {
		if hmac.Equal([]byte(code), []byte(derive(window, nonce))) {
			return true
		}
	}

	return false
}

// UsedJoinCode marks a join code as used. It is stored with JoinCodeLifetime as TTL; the id is
// a hash of room and code, so the database holds no codes.
type UsedJoinCode struct {
	ID [sha256.Size]byte `json:"id"`
}

func NewUsedJoinCode(roomID uuid.UUID, code string) UsedJoinCode {
	return UsedJoinCode{ID: sha256.Sum256(append(roomID[:], code...))}
}

func (u UsedJoinCode) GetID() []byte {
	return u.ID[:]
}
