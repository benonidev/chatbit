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

// GetAllSinceTimeStamp returns every object of the room with GetTimestamp() > timestamp, in key
// order. Used for messages, rotations (the timestamp is the epoch), join requests and key updates.
func (aI *MessageAdapterInternal[T]) GetAllSinceTimeStamp(roomID uuid.UUID, timestamp uint64) ([]T, error) {
	prefix := append(prefixOf[T](), roomID[:]...)

	objArr, err := aI.db.GetObjectsByPrefixAndSinceTs(prefix, timestamp)
	if err != nil {
		return nil, fmt.Errorf("not possible to parse roomID: %w", err)
	}

	return objArr, nil
}

// DeleteAll removes every stored object of the room.
func (aI *MessageAdapterInternal[T]) DeleteAll(roomID uuid.UUID) error {
	prefix := append(prefixOf[T](), roomID[:]...)

	err := aI.db.DeleteObjectsByPrefix(prefix)
	if err != nil {
		return fmt.Errorf("not possible to delete messages of room: %w", err)
	}

	return nil
}
