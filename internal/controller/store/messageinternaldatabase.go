package store

import (
	"fmt"

	"github.com/google/uuid"
)

type MessageAdapterInternal[T ObjectMessageInternal] struct {
	DBInternal[T]
	db DatabaseTs[T]
}

func NewMessageAdapterInternal[T ObjectMessageInternal](db DatabaseTs[T]) *MessageAdapterInternal[T] {
	return &MessageAdapterInternal[T]{
		DBInternal: NewAdapterInternal[T](db),
		db:         db,
	}
}

func (aI *MessageAdapterInternal[T]) GetAllSinceTimeStamp(roomID uuid.UUID, timestamp uint64) ([]T, error) {
	prefix := append(convertUint16ToByte(PrefixMessage), roomID[:]...)

	objArr, err := aI.db.GetObjectsByPrefixAndSinceTs(prefix, timestamp)
	if err != nil {
		return nil, fmt.Errorf("not possible to parse roomID: %w", err)
	}

	return objArr, nil
}

// DeleteAll removes every stored message of the room.
func (aI *MessageAdapterInternal[T]) DeleteAll(roomID uuid.UUID) error {
	prefix := append(convertUint16ToByte(PrefixMessage), roomID[:]...)

	err := aI.db.DeleteObjectsByPrefix(prefix)
	if err != nil {
		return fmt.Errorf("not possible to delete messages of room: %w", err)
	}

	return nil
}
