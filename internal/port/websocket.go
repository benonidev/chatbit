package port

import (
	"chatbit/internal/adapter/pubsub"
	"chatbit/internal/core"
	"chatbit/internal/domain"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
}

// helloWait is the time a new connection has to send its hello frame
const helloWait = 10 * time.Second

type wsHandler struct {
	psWsMsgAdapter *pubsub.AdapterTopic[uuid.UUID, WsOutbound]
	app            *core.Application
	limits         *Limits

	// The connection of every client id. A second connection with the same id replaces the
	// first one; mu also serializes subscribing and unsubscribing of the same id.
	mu      sync.Mutex
	clients map[uuid.UUID]*WsClient
}

func (s *Server) StartWebSocketServer(cfg LimitConfig) {
	ps := pubsub.NewAdapterTopic[uuid.UUID, WsOutbound]()
	ps.MaxSubscribers = cfg.MaxRoomSubscribers

	servWS := &wsHandler{
		psWsMsgAdapter: ps,
		app:            s.app,
		limits:         NewLimits(cfg),
		clients:        make(map[uuid.UUID]*WsClient),
	}

	s.servMux.Handle("/ws", servWS)
}

// serveWs handles websocket requests from the peer.
func (h *wsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r, h.limits.cfg.TrustedProxies)

	err := h.limits.AcquireConn(ip)
	if err != nil {
		slog.Warn("connection refused", slog.String("reason", err.Error()))
		http.Error(w, err.Error(), http.StatusTooManyRequests)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.limits.ReleaseConn(ip)
		slog.Error("upgrade error", slog.String("error", err.Error()))
		return
	}

	uid, err := readClientUID(r, conn)
	if err != nil {
		h.limits.ReleaseConn(ip)
		closeWith(conn, websocket.ClosePolicyViolation, "hello expected")
		slog.Debug("connection without valid hello", slog.String("error", err.Error()))
		return
	}

	client := &WsClient{
		UID:            uid,
		ip:             ip,
		conn:           conn,
		send:           make(chan WsOutbound, 256),
		psWsMsgAdapter: h.psWsMsgAdapter,
		app:            h.app,
		limits:         h.limits,
		hub:            h,
		fileTransfer:   make(map[uuid.UUID]*domain.Transfer),
		fileTransferMu: sync.Mutex{},
	}

	err = h.register(client)
	if err != nil {
		h.limits.ReleaseConn(ip)
		closeWith(conn, websocket.CloseTryAgainLater, "server full")
		slog.Warn("not possible to subscribe client", slog.String("error", err.Error()))
		return
	}

	// Allow collection of memory referenced by the caller by doing all work in
	// new goroutines.
	go client.writePump()
	go client.readPump()

	slog.Debug("new ws client connected", slog.String("client_uid", client.UID.String()))
}

// register subscribes the client. An older connection with the same client id is closed and
// its subscription removed first — otherwise its channel would be replaced silently and the
// old goroutines would hang forever.
func (h *wsHandler) register(c *WsClient) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	old := h.clients[c.UID]
	if old != nil {
		err := h.psWsMsgAdapter.Unsubscribe(c.UID)
		if err != nil {
			slog.Error("not possible to unsubscribe replaced connection", slog.String("error", err.Error()))
		}
		_ = old.conn.Close()
		delete(h.clients, c.UID)
	}

	_, err := h.psWsMsgAdapter.SubscribeWithID(c.UID, c.UID, func(obj WsOutbound) {
		c.send <- obj
	})
	if err != nil {
		return err
	}

	h.clients[c.UID] = c

	return nil
}

// unregister removes the subscription of the client — unless a newer connection with the
// same id has replaced it already. Returns false in that case.
func (h *wsHandler) unregister(c *WsClient) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.clients[c.UID] != c {
		return false
	}
	delete(h.clients, c.UID)

	err := h.psWsMsgAdapter.Unsubscribe(c.UID)
	if err != nil {
		slog.Error("not possible to unsubscribe client", slog.String("error", err.Error()))
	}

	return true
}

// readClientUID reads the client id from the hello frame. Older clients still send it as
// query parameter "client_uid".
func readClientUID(r *http.Request, conn *websocket.Conn) (uuid.UUID, error) {
	legacy := r.URL.Query().Get("client_uid")
	if legacy != "" {
		return uuid.Parse(legacy)
	}

	err := conn.SetReadDeadline(time.Now().Add(helloWait))
	if err != nil {
		return uuid.Nil, err
	}

	msgType, data, err := conn.ReadMessage()
	if err != nil {
		return uuid.Nil, err
	}
	if msgType != websocket.TextMessage {
		return uuid.Nil, errors.New("hello must be a text frame")
	}

	var wsMsg domain.WsMessage
	err = json.Unmarshal(data, &wsMsg)
	if err != nil || domain.WsMessageType(wsMsg.Type) != domain.WsTypeHello {
		return uuid.Nil, errors.New("first frame is not hello")
	}

	var hello domain.Hello
	err = json.Unmarshal(wsMsg.Data, &hello)
	if err != nil {
		return uuid.Nil, err
	}

	return uuid.Parse(hello.ClientUID)
}

func closeWith(conn *websocket.Conn, code int, reason string) {
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
	_ = conn.Close()
}
