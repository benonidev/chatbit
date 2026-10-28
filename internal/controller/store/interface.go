package store

import (
	"time"

	"github.com/google/uuid"
)

type Database[T any] interface {
	DeleteObjectByID(ID []byte) error
	AddObject(ID []byte, obj T) error
	AddObjectWithTTL(ID []byte, obj T, ttl time.Duration) error
	InsertObjectWithTTL(ID []byte, obj T, ttl time.Duration) error
	GetObjectByID(ID []byte) (T, error)
	DeleteObjectsByPrefix(prefix []byte) error
}

type DatabaseTs[T any] interface {
	DeleteObjectByID(ID []byte) error
	AddObject(ID []byte, obj T) error
	AddObjectWithTTL(ID []byte, obj T, ttl time.Duration) error
	InsertObjectWithTTL(ID []byte, obj T, ttl time.Duration) error
	GetObjectByID(ID []byte) (T, error)
	DeleteObjectsByPrefix(prefix []byte) error
	GetObjectsByPrefixAndSinceTs(prefix []byte, timestamp uint64) ([]T, error)
}

type DBInternal[T ObjectInternal] interface {
	Delete(ID []byte) error
	Add(obj T) error
	AddWithTTL(obj T, ttl int64) error
	InsertWithTTL(obj T, ttl int64) error
	Get(ID []byte) (T, error)
	Update(ID []byte, fn func(obj T) error) error
	UpdateWithTTL(ID []byte, fn func(obj T) error, ttl func(obj T) int64) error
}

type DBMessageInternal[T ObjectMessageInternal] interface {
	DBInternal[T]
	GetAllSinceTimeStamp(roomID uuid.UUID, timestamp uint64) ([]T, error)
	DeleteAll(roomID uuid.UUID) error
}

type ObjectInternal interface {
	GetID() []byte
}

type ObjectMessageInternal interface {
	GetID() []byte
	GetRoomID() []byte
	GetTimestamp() uint64
}
