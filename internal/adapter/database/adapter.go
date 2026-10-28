package database

import (
	"log/slog"

	badger "github.com/dgraph-io/badger/v4"
)

const (
	Path       = "chatbit_db.kv"
	PrefixRoom = uint16(0)
	PrefixChat = uint16(1)
)

//nolint:unused // key prefixes reserved for the database layout
var (
	prefixRoom = ConvertUint16ToByte(PrefixRoom)
	prefixChat = ConvertUint16ToByte(PrefixChat)
)

type Database struct {
	*badger.DB
}

func NewDatabase() *Database {
	return &Database{}
}

type Adapter[T any] struct {
	db *Database
}

func NewAdapter[T any](db *Database) *Adapter[T] {
	return &Adapter[T]{
		db: db,
	}
}

func (a *Database) Open() {
	var err error

	a.DB, err = badger.Open(badger.DefaultOptions(Path))
	if err != nil {
		slog.Error("not possible to open badger db",
			"error", err)
	}
}

func (a *Database) Close() {
	err := a.DB.Close()
	if err != nil {
		slog.Error("not possible to close badger db",
			"error", err)
	}
}

func ConvertUint16ToByte(v uint16) []byte {
	return []byte{
		byte(v >> 8), // High Byte
		byte(v),      // Low Byte
	}
}
