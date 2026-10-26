package core

import (
	"chatbit/internal/adapter/database"
	"chatbit/internal/adapter/pubsub"
	"chatbit/internal/controller/store"
	"chatbit/internal/domain"

	"github.com/google/uuid"
)

type Application struct {
	DB DB
	PS PS
}

type DB struct {
	Room    store.DBInternal[*domain.Room]
	Message store.DBMessageInternal[domain.Message]
	File    store.DBInternal[*domain.File]
	Push    store.DBInternal[domain.Push]
	Peer    store.DBInternal[domain.Peer]

	// Join codes that were used already (kept until they expire)
	UsedCode store.DBInternal[domain.UsedJoinCode]
}

type PS struct {
	Message *pubsub.Adapter[uuid.UUID, domain.Message]
}

func NewApplication() *Application {
	db := database.NewDatabase()
	db.Open()

	return &Application{
		DB: DB{
			Room:    store.NewAdapterInternal[*domain.Room](database.NewAdapter[*domain.Room](db)),
			Message: store.NewMessageAdapterInternal[domain.Message](database.NewAdapterTs[domain.Message](db)),
			File:    store.NewAdapterInternal[*domain.File](database.NewAdapter[*domain.File](db)),
			Push:    store.NewAdapterInternal[domain.Push](database.NewAdapter[domain.Push](db)),
			Peer:    store.NewAdapterInternal[domain.Peer](database.NewAdapter[domain.Peer](db)),

			UsedCode: store.NewAdapterInternal[domain.UsedJoinCode](database.NewAdapter[domain.UsedJoinCode](db)),
		},
		PS: PS{
			Message: pubsub.NewAdapter[uuid.UUID, domain.Message](),
		},
	}
}
