package database

type AdapterTs[T ObjectFilterTs] struct {
	*Adapter[T]
	db *Database
}

func NewAdapterTs[T ObjectFilterTs](db *Database) *AdapterTs[T] {
	return &AdapterTs[T]{
		Adapter: NewAdapter[T](db),
		db:      db,
	}
}
