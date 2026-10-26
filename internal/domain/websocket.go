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
	WsTypeJoinRejected        WsMessageType = "join_rejected" // the join code was missing, wrong, expired or used
	WsTypeCreateRoom          WsMessageType = "create_room"
	WsTypeSubscribePush       WsMessageType = "sub_push"
	WsTypeFileTransferStart   WsMessageType = "transfer_start"
	WsTypeFileTransferDone    WsMessageType = "transfer_done"
	WsTypeFileTransferACK     WsMessageType = "transfer_ack"
	WsTypeFileTransferNACK    WsMessageType = "transfer_nack"
	WsTypeFileTransferRequest WsMessageType = "transfer_request"
)

// Hello is the first frame of a WebSocket connection. The client id is sent here instead of in
// the URL, so it does not end up in the access logs of proxies.
type Hello struct {
	ClientUID string `json:"clientUid"`
}
