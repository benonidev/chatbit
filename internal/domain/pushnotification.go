package domain

import "github.com/google/uuid"

type Push struct {
	ID       uuid.UUID `json:"id,omitempty"`
	Endpoint string    `json:"endpoint"`
	P256DH   string    `json:"p256dh"`
	Auth     string    `json:"auth"`
}

func (p Push) GetID() []byte {
	return p.ID[:]
}
