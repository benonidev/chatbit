package database

import (
	"chatbit/internal/domain"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/dgraph-io/badger/v4"
)

func (a *Adapter[T]) DeleteObjectByID(ID []byte) error {
	err := a.db.Update(func(txn *badger.Txn) error {
		return txn.Delete(ID)
	})
	if err != nil {
		return fmt.Errorf("not possible to delete object from database: %w", err)
	}

	return nil
}

func (a *Adapter[T]) DeleteObjectsByPrefix(prefix []byte) error {
	err := a.db.Update(func(txn *badger.Txn) error {
		itr := txn.NewIterator(badger.IteratorOptions{
			Prefix: prefix,
		})
		defer itr.Close()

		for itr.Rewind(); itr.Valid(); itr.Next() {
			item := itr.Item()
			key := item.KeyCopy(nil)
			err := txn.Delete(key)
			if err != nil {
				return err
			}
		}

		return nil
	})
	if err != nil {
		return fmt.Errorf("not possible to delete objects by prefix from database: %w", err)
	}

	return nil
}

func (a *Adapter[T]) AddObject(ID []byte, obj T) error {
	objB, err := json.Marshal(obj)
	if err != nil {
		return fmt.Errorf("not possible to convert go object to byte")
	}

	err = a.db.Update(func(txn *badger.Txn) error {
		return txn.Set(ID, objB)
	})
	if err != nil {
		return fmt.Errorf("not possible to store object to database")
	}

	return nil
}

func (a *Adapter[T]) AddObjectWithTTL(ID []byte, obj T, ttl time.Duration) error {
	objB, err := json.Marshal(obj)
	if err != nil {
		return fmt.Errorf("not possible to convert go object to byte")
	}

	err = a.db.Update(func(txn *badger.Txn) error {
		return txn.SetEntry(badger.NewEntry(ID, objB).WithTTL(ttl))
	})
	if err != nil {
		return fmt.Errorf("not possible to store object to database")
	}

	return nil
}

// InsertObjectWithTTL stores the object only if the key does not exist yet (domain.ErrObjExists).
// Check and write run in one transaction, so two concurrent inserts can not both succeed.
func (a *Adapter[T]) InsertObjectWithTTL(ID []byte, obj T, ttl time.Duration) error {
	objB, err := json.Marshal(obj)
	if err != nil {
		return fmt.Errorf("not possible to convert go object to byte")
	}

	err = a.db.Update(func(txn *badger.Txn) error {
		_, err := txn.Get(ID)
		if err == nil {
			return domain.ErrObjExists
		}
		if !errors.Is(err, badger.ErrKeyNotFound) {
			return err
		}
		return txn.SetEntry(badger.NewEntry(ID, objB).WithTTL(ttl))
	})
	if errors.Is(err, domain.ErrObjExists) {
		return err
	}
	if err != nil {
		return fmt.Errorf("not possible to store object to database: %w", err)
	}

	return nil
}

func (a *Adapter[T]) GetObjectByID(ID []byte) (T, error) {
	var err error

	var objCopy []byte

	var objItem *badger.Item

	var obj T

	err = a.db.View(func(txn *badger.Txn) error {
		objItem, err = txn.Get(ID)
		if err != nil {
			return err
		}

		//Important to copy
		objCopy, err = objItem.ValueCopy(nil)
		if err != nil {
			return err
		}
		return nil
	})
	if errors.Is(err, badger.ErrKeyNotFound) {
		return obj, domain.ErrObjNotFound
	}
	if err != nil {
		return obj, fmt.Errorf("not possible to get object by ID from the database")
	}

	err = json.Unmarshal(objCopy, &obj)
	if err != nil {
		return obj, fmt.Errorf("not possible to convert byte  to go object")
	}

	return obj, nil
}
