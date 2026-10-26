package store

import (
	"chatbit/internal/adapter/database"
	"chatbit/internal/domain"
	"testing"

	badger "github.com/dgraph-io/badger/v4"
	"github.com/google/uuid"
)

func TestDeleteAllOnlyDeletesMessagesOfTheRoom(t *testing.T) {
	bdb, err := badger.Open(badger.DefaultOptions("").WithInMemory(true).WithLogger(nil))
	if err != nil {
		t.Fatal(err)
	}
	defer bdb.Close()

	db := &database.Database{DB: bdb}
	messages := NewMessageAdapterInternal[domain.Message](database.NewAdapterTs[domain.Message](db))
	rooms := NewAdapterInternal[*domain.Room](database.NewAdapter[*domain.Room](db))

	cleaned := uuid.New()
	other := uuid.New()

	for _, roomID := range []uuid.UUID{cleaned, cleaned, other} {
		err = messages.Add(domain.Message{ID: uuid.New(), RoomID: roomID, TimeStamp: 1})
		if err != nil {
			t.Fatal(err)
		}
	}

	// The room record shares the database, it must survive
	err = rooms.Add(&domain.Room{ID: cleaned})
	if err != nil {
		t.Fatal(err)
	}

	err = messages.DeleteAll(cleaned)
	if err != nil {
		t.Fatal(err)
	}

	got, err := messages.GetAllSinceTimeStamp(cleaned, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("cleaned room has %d messages, want 0", len(got))
	}

	got, err = messages.GetAllSinceTimeStamp(other, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("other room has %d messages, want 1", len(got))
	}

	_, err = rooms.Get(cleaned[:])
	if err != nil {
		t.Fatalf("room record deleted: %v", err)
	}
}
