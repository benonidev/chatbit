package store

import (
	"bytes"
	"chatbit/internal/adapter/database"
	"chatbit/internal/domain"
	"testing"
)

// The types of core.DB: every one needs its own key prefix
func TestEveryTypeHasItsOwnPrefix(t *testing.T) {
	db := &database.Database{}
	prefixes := map[string][]byte{
		"Message":      NewAdapterInternal[domain.Message](database.NewAdapter[domain.Message](db)).prefix,
		"Room":         NewAdapterInternal[*domain.Room](database.NewAdapter[*domain.Room](db)).prefix,
		"File":         NewAdapterInternal[*domain.File](database.NewAdapter[*domain.File](db)).prefix,
		"Push":         NewAdapterInternal[domain.Push](database.NewAdapter[domain.Push](db)).prefix,
		"Peer":         NewAdapterInternal[domain.Peer](database.NewAdapter[domain.Peer](db)).prefix,
		"UsedJoinCode": NewAdapterInternal[domain.UsedJoinCode](database.NewAdapter[domain.UsedJoinCode](db)).prefix,
	}

	seen := map[string]string{}
	for name, prefix := range prefixes {
		if len(prefix) == 0 {
			t.Errorf("%s has no prefix", name)
		}
		if other, ok := seen[string(prefix)]; ok {
			t.Errorf("%s and %s share the prefix %v", name, other, prefix)
		}
		seen[string(prefix)] = name
	}

	// The messages of a room are read and deleted by prefix + room id
	if !bytes.Equal(prefixes["Message"], convertUint16ToByte(PrefixMessage)) {
		t.Error("message prefix differs from the one GetAllSinceTimeStamp / DeleteAll use")
	}
}
