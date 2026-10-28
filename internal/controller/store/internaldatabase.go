package store

import (
	"chatbit/internal/domain"
	"encoding/binary"
	"fmt"
	"sync"
	"time"
)

type AdapterInternal[T ObjectInternal] struct {
	db     Database[T]
	prefix []byte
	mutex  sync.RWMutex
}

func NewAdapterInternal[T ObjectInternal](db Database[T]) *AdapterInternal[T] {
	return &AdapterInternal[T]{
		db:     db,
		prefix: prefixOf[T](),
		mutex:  sync.RWMutex{},
	}
}

// prefixOf returns the key prefix of a type. Every type needs its own prefix, otherwise its keys
// mix with the keys of other types.
func prefixOf[T any]() []byte {
	var obj T

	switch any(obj).(type) {
	case domain.Message:
		return convertUint16ToByte(PrefixMessage)
	case *domain.Room:
		return convertUint16ToByte(PrefixRoom)
	case *domain.File:
		return convertUint16ToByte(PrefixFile)
	case domain.Push:
		return convertUint16ToByte(PrefixPush)
	case domain.Peer:
		return convertUint16ToByte(PrefixPeer)
	case domain.UsedJoinCode:
		return convertUint16ToByte(PrefixUsedCode)
	case domain.Rotation:
		return convertUint16ToByte(PrefixRotation)
	case domain.JoinRequest:
		return convertUint16ToByte(PrefixJoinRequest)
	case domain.KeyUpdate:
		return convertUint16ToByte(PrefixKeyUpdate)
	default:
		panic(fmt.Sprintf("store: no key prefix for %T", obj))
	}
}

func (aI *AdapterInternal[T]) Delete(ID []byte) error {
	aI.mutex.Lock()
	defer aI.mutex.Unlock()

	return aI.delete(ID)
}

func (aI *AdapterInternal[T]) Add(obj T) error {
	aI.mutex.Lock()
	defer aI.mutex.Unlock()

	return aI.add(obj)
}

func (aI *AdapterInternal[T]) Get(ID []byte) (T, error) {
	aI.mutex.RLock()
	defer aI.mutex.RUnlock()

	return aI.get(ID)
}

func (aI *AdapterInternal[T]) Update(ID []byte, fn func(obj T) error) error {
	aI.mutex.Lock()
	defer aI.mutex.Unlock()

	obj, err := aI.get(ID)
	if err != nil {
		return err
	}

	err = fn(obj)
	if err != nil {
		return err
	}

	// To remove an object use Delete — fn can not delete it.
	return aI.add(obj)
}

// UpdateWithTTL is Update, but the object is stored again with the TTL returned by ttl
// (called after fn, so it can depend on the changed object).
func (aI *AdapterInternal[T]) UpdateWithTTL(ID []byte, fn func(obj T) error, ttl func(obj T) int64) error {
	aI.mutex.Lock()
	defer aI.mutex.Unlock()

	obj, err := aI.get(ID)
	if err != nil {
		return err
	}

	err = fn(obj)
	if err != nil {
		return err
	}

	return aI.AddWithTTL(obj, ttl(obj))
}

func (aI *AdapterInternal[T]) get(ID []byte) (T, error) {
	obj, err := aI.db.GetObjectByID(append(aI.prefix, ID[:]...))
	if err != nil {
		return obj, fmt.Errorf("not possible get object from database: %w", err)
	}

	return obj, nil
}

func (aI *AdapterInternal[T]) add(obj T) error {
	err := aI.db.AddObject(append(aI.prefix, obj.GetID()...), obj)
	if err != nil {
		return fmt.Errorf("not possible store object to database: %w", err)
	}

	return nil
}

func (aI *AdapterInternal[T]) AddWithTTL(obj T, ttl int64) error {
	err := aI.db.AddObjectWithTTL(append(aI.prefix, obj.GetID()...), obj, time.Duration(ttl)*time.Second)
	if err != nil {
		return fmt.Errorf("not possible store object to database: %w", err)
	}

	return nil
}

// InsertWithTTL stores obj only if it does not exist yet, otherwise domain.ErrObjExists
func (aI *AdapterInternal[T]) InsertWithTTL(obj T, ttl int64) error {
	err := aI.db.InsertObjectWithTTL(append(aI.prefix, obj.GetID()...), obj, time.Duration(ttl)*time.Second)
	if err != nil {
		return fmt.Errorf("not possible to insert object to database: %w", err)
	}

	return nil
}

func (aI *AdapterInternal[T]) delete(ID []byte) error {
	err := aI.db.DeleteObjectByID(append(aI.prefix, ID[:]...))
	if err != nil {
		return fmt.Errorf("not possible to delete object from database: %w", err)
	}

	return nil
}

func convertUint16ToByte(input uint16) []byte {
	var outByte = make([]byte, 2)

	binary.LittleEndian.PutUint16(outByte, input)

	return outByte
}
