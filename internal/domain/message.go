package domain

import (
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
)

type Message struct {
	ID        uuid.UUID `json:"id,omitempty"`
	Type      int64     `json:"type,omitempty"` // 0: text, 1: image, 2: file
	RoomID    uuid.UUID `json:"roomId,omitempty"`
	AliasID   string    `json:"aliasId,omitempty"`
	Content   string    `json:"content,omitempty"`
	TimeStamp uint64    `json:"timestamp,omitempty"`
	Store     bool      `json:"store,omitempty"`
	TTL       int64     `json:"ttl,omitempty"`

	// Epoch whose room key encrypted the message (docs/room-keys.md); aliasId (the member id),
	// content and signature are encrypted, the server can not read them. The name of the sender
	// is not in the message: the clients take it from the signed member list of the epoch.
	Epoch uint32 `json:"epoch,omitempty"`
	Sig   string `json:"sig,omitempty"`
	// Id of the message this one answers, encrypted and signed like the content
	Reply string `json:"reply,omitempty"`
}

func (m Message) GetID() []byte {
	return append(m.RoomID[:], m.ID[:]...)
}

func (m Message) GetRoomID() []byte {
	return m.RoomID[:]
}

func (m Message) GetTimestamp() uint64 {
	return m.TimeStamp
}

type GetLastMessage struct {
	RoomID         string `json:"roomId,omitempty"`
	SinceTimeStamp uint64 `json:"sinceTimestamp,omitempty"`
}

type UUID string

func (u *UUID) UnmarshalJSON(b []byte) error {
	var s string
	err := json.Unmarshal(b, &s)
	if err != nil {
		return err
	}
	_, err = uuid.Parse(s)
	if err != nil {
		return fmt.Errorf("invalid uuid: %w", err)
	}
	*u = UUID(s)
	return nil
}
