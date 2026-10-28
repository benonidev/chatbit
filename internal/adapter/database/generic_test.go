package database

import (
	"chatbit/internal/domain"
	"errors"
	"testing"
	"time"

	badger "github.com/dgraph-io/badger/v4"
)

func TestInsertObjectWithTTLNeverOverwrites(t *testing.T) {
	bdb, err := badger.Open(badger.DefaultOptions("").WithInMemory(true).WithLogger(nil))
	if err != nil {
		t.Fatal(err)
	}
	defer bdb.Close()

	a := NewAdapter[domain.Message](&Database{DB: bdb})
	id := []byte("room+message")

	err = a.InsertObjectWithTTL(id, domain.Message{Content: "original"}, time.Hour)
	if err != nil {
		t.Fatalf("first insert: %v", err)
	}

	err = a.InsertObjectWithTTL(id, domain.Message{Content: "replaced"}, time.Hour)
	if !errors.Is(err, domain.ErrObjExists) {
		t.Fatalf("second insert: got %v, want ErrObjExists", err)
	}

	got, err := a.GetObjectByID(id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Content != "original" {
		t.Fatalf("content = %q, want original", got.Content)
	}
}
