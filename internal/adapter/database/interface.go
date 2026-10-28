package database

type DB interface {
}

type ObjectFilterTs interface {
	GetTimestamp() uint64
}
