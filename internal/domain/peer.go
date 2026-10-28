package domain

import (
	"time"

	"github.com/google/uuid"
)

type Peer struct {
	ID       uuid.UUID
	LastSeen time.Time
}

func (p Peer) GetID() []byte {
	return p.ID[:]
}
