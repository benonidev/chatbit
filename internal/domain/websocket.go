package domain

import "encoding/json"

type WsMessage struct {
	Type string          `json:"type,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`
}

type WsMessageType string

const (
	WsTypeMessage             WsMessageType = "message"
	WsTypeLeaveRoom           WsMessageType = "leave_rooms"
	WsTypeCleanRoom           WsMessageType = "clean_room" // deletes all messages and files of a room on the server and on all members
	WsTypeJoinRoom            WsMessageType = "join_rooms"
	WsTypeHello               WsMessageType = "hello" // first frame of a connection: {clientUid}
	WsTypeRoomInfo            WsMessageType = "room_info"
	WsTypeRoomSynced          WsMessageType = "room_synced"   // all missed messages of a join are sent
	WsTypeJoinRejected        WsMessageType = "join_rejected" // the join code was missing, wrong, expired or used
	WsTypeCreateRoom          WsMessageType = "create_room"
	WsTypeSubscribePush       WsMessageType = "sub_push"
	WsTypeFileTransferStart   WsMessageType = "transfer_start"
	WsTypeFileTransferDone    WsMessageType = "transfer_done"
	WsTypeFileTransferACK     WsMessageType = "transfer_ack"
	WsTypeFileTransferNACK    WsMessageType = "transfer_nack"
	WsTypeFileTransferRequest WsMessageType = "transfer_request"

	// Room keys with epochs (rotation.go)
	WsTypeRotate          WsMessageType = "rotate"           // client → server: next epoch
	WsTypeRotation        WsMessageType = "rotation"         // server → clients: accepted rotation
	WsTypeRotateRejected  WsMessageType = "rotate_rejected"  // another rotation was first
	WsTypeRejoinRequired  WsMessageType = "rejoin_required"  // after a rotation: join with the new join secret
	WsTypeJoinRequest     WsMessageType = "join_request"     // new member asks to join (encrypted)
	WsTypeAnswerRequest   WsMessageType = "answer_request"   // a member approved / declined a join request
	WsTypeKeyUpdate       WsMessageType = "key_update"       // new exchange key of a member (encrypted)
	WsTypeMessageRejected WsMessageType = "message_rejected" // message not accepted (e.g. room rotated meanwhile)
)

// Hello is the first frame of a WebSocket connection. The client id is sent here instead of in
// the URL, so it does not end up in the access logs of proxies.
type Hello struct {
	ClientUID string `json:"clientUid"`
}
