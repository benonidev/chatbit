package domain

import "errors"

var ErrObjNotFound = errors.New("obj not found in database")

// ErrObjExists is returned by the insert functions: an existing object is never overwritten
var ErrObjExists = errors.New("obj already exists in database")

// ErrJoinRejected is returned when a client has no valid join code for a room
var ErrJoinRejected = errors.New("no valid join code")

// ErrNotMember is returned when a client acts on a room it is not a member of
var ErrNotMember = errors.New("peer is not a member of the room")

// ErrRotationConflict is returned when a rotation is not for the next epoch (another one was first)
var ErrRotationConflict = errors.New("rotation is not for the next epoch")
