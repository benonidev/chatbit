package port

import (
	"chatbit/internal/domain"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

var (
	ErrTooManyConnections = errors.New("too many connections")
	ErrTooManyConnects    = errors.New("too many connection attempts")
)

// LimitConfig holds all limits against abuse. Every value can be set with the environment
// variable named in LoadLimitConfig; the defaults are far above normal use.
type LimitConfig struct {
	MaxConnections         int           // MAX_CONNECTIONS
	MaxConnectionsPerIP    int           // MAX_CONNECTIONS_PER_IP
	ConnectsPerMinutePerIP int           // CONNECTS_PER_MINUTE_PER_IP
	TrustedProxies         []*net.IPNet  // TRUSTED_PROXIES
	MaxRoomSubscribers     int           // MAX_ROOM_SUBSCRIBERS
	MessagesPerSecond      float64       // MESSAGES_PER_SECOND
	MessageBurst           int           // MESSAGE_BURST
	MessagesPerSecondPerIP float64       // MESSAGES_PER_SECOND_PER_IP
	JoinsPerSecond         float64       // JOINS_PER_SECOND
	MaxRoomsPerJoin        int           // MAX_ROOMS_PER_JOIN
	RoomsPerHourPerIP      int           // ROOMS_PER_HOUR_PER_IP
	RoomIdleTime           time.Duration // ROOM_IDLE_DAYS
	MaxUploadsPerConn      int           // MAX_UPLOADS_PER_CONNECTION
	UploadMBPerHourPerIP   int           // UPLOAD_MB_PER_HOUR_PER_IP
	MinFreeDiskMB          int           // MIN_FREE_DISK_MB
	PushInterval           time.Duration // PUSH_INTERVAL_SECONDS
}

// LoadLimitConfig reads the limits from the environment. Invalid values are logged and the
// default is used instead. MAX_FILE_SIZE_MB is applied to domain.MaxFileSize directly.
func LoadLimitConfig() LimitConfig {
	cfg := LimitConfig{
		MaxConnections:         envInt("MAX_CONNECTIONS", 10000),
		MaxConnectionsPerIP:    envInt("MAX_CONNECTIONS_PER_IP", 20),
		ConnectsPerMinutePerIP: envInt("CONNECTS_PER_MINUTE_PER_IP", 30),
		TrustedProxies:         envNets("TRUSTED_PROXIES", "127.0.0.1/8,::1/128"),
		MaxRoomSubscribers:     envInt("MAX_ROOM_SUBSCRIBERS", 256),
		MessagesPerSecond:      envFloat("MESSAGES_PER_SECOND", 5),
		MessageBurst:           envInt("MESSAGE_BURST", 20),
		MessagesPerSecondPerIP: envFloat("MESSAGES_PER_SECOND_PER_IP", 20),
		JoinsPerSecond:         envFloat("JOINS_PER_SECOND", 2),
		MaxRoomsPerJoin:        envInt("MAX_ROOMS_PER_JOIN", 200),
		RoomsPerHourPerIP:      envInt("ROOMS_PER_HOUR_PER_IP", 10),
		RoomIdleTime:           time.Duration(envInt("ROOM_IDLE_DAYS", 30)) * 24 * time.Hour,
		MaxUploadsPerConn:      envInt("MAX_UPLOADS_PER_CONNECTION", 2),
		UploadMBPerHourPerIP:   envInt("UPLOAD_MB_PER_HOUR_PER_IP", 500),
		MinFreeDiskMB:          envInt("MIN_FREE_DISK_MB", 1024),
		PushInterval:           time.Duration(envInt("PUSH_INTERVAL_SECONDS", 30)) * time.Second,
	}

	domain.MaxFileSize = int64(envInt("MAX_FILE_SIZE_MB", 25)) * 1024 * 1024

	return cfg
}

func envInt(name string, def int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return def
	}

	v, err := strconv.Atoi(raw)
	if err != nil || v <= 0 {
		slog.Warn("invalid limit, using default", slog.String("env", name), slog.String("value", raw), slog.Int("default", def))
		return def
	}

	return v
}

func envFloat(name string, def float64) float64 {
	raw := os.Getenv(name)
	if raw == "" {
		return def
	}

	v, err := strconv.ParseFloat(raw, 64)
	if err != nil || v <= 0 {
		slog.Warn("invalid limit, using default", slog.String("env", name), slog.String("value", raw), slog.Float64("default", def))
		return def
	}

	return v
}

// envNets parses a comma separated list of IPs or CIDRs. "none" trusts no proxy.
func envNets(name, def string) []*net.IPNet {
	raw := os.Getenv(name)
	if raw == "" {
		raw = def
	}
	if raw == "none" {
		return nil
	}

	var nets []*net.IPNet
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.Contains(part, "/") {
			if strings.Contains(part, ":") {
				part += "/128"
			} else {
				part += "/32"
			}
		}

		_, n, err := net.ParseCIDR(part)
		if err != nil {
			slog.Warn("invalid trusted proxy, ignored", slog.String("env", name), slog.String("value", part))
			continue
		}
		nets = append(nets, n)
	}

	return nets
}

// clientIP returns the IP of the client. X-Forwarded-For is only used if the request comes
// from a trusted proxy — otherwise anybody could fake an IP and bypass the per IP limits.
// The rightmost address that is not a trusted proxy is the client.
func clientIP(r *http.Request, trusted []*net.IPNet) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}

	if !isTrusted(host, trusted) {
		return host
	}

	hops := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(hops) - 1; i >= 0; i-- {
		hop := strings.TrimSpace(hops[i])
		if hop == "" {
			continue
		}
		if !isTrusted(hop, trusted) {
			return hop
		}
	}

	return host
}

func isTrusted(addr string, trusted []*net.IPNet) bool {
	ip := net.ParseIP(addr)
	if ip == nil {
		return false
	}

	for _, n := range trusted {
		if n.Contains(ip) {
			return true
		}
	}

	return false
}

// -----------------------------------------------------------------------------
// Token bucket
// -----------------------------------------------------------------------------

// bucket is a token bucket: it holds up to burst tokens and refills rate tokens per second.
type bucket struct {
	tokens float64
	last   time.Time
}

func (b *bucket) allow(now time.Time, rate, burst, n float64) bool {
	if b.last.IsZero() {
		b.tokens = burst
	} else {
		b.tokens = min(burst, b.tokens+now.Sub(b.last).Seconds()*rate)
	}
	b.last = now

	if b.tokens < n {
		return false
	}

	b.tokens -= n
	return true
}

// keyedLimiter is a token bucket per key (IP address).
type keyedLimiter struct {
	mu        sync.Mutex
	rate      float64
	burst     float64
	buckets   map[string]*bucket
	lastSweep time.Time
}

func newKeyedLimiter(rate, burst float64) *keyedLimiter {
	return &keyedLimiter{rate: rate, burst: burst, buckets: make(map[string]*bucket)}
}

func (l *keyedLimiter) Allow(key string, n float64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	l.sweep(now)

	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{}
		l.buckets[key] = b
	}

	return b.allow(now, l.rate, l.burst, n)
}

// sweep forgets buckets that are full again, so the map does not grow with every IP ever seen.
func (l *keyedLimiter) sweep(now time.Time) {
	if now.Sub(l.lastSweep) < time.Minute {
		return
	}
	l.lastSweep = now

	for key, b := range l.buckets {
		if b.tokens+now.Sub(b.last).Seconds()*l.rate >= l.burst {
			delete(l.buckets, key)
		}
	}
}

// -----------------------------------------------------------------------------
// Limits shared by all connections
// -----------------------------------------------------------------------------

type Limits struct {
	cfg LimitConfig

	mu         sync.Mutex
	conns      int
	connsPerIP map[string]int

	connects    *keyedLimiter // connection attempts per IP
	messagesIP  *keyedLimiter // messages per IP
	roomCreates *keyedLimiter // new rooms per IP
	uploadBytes *keyedLimiter // uploaded bytes per IP

	pushMu   sync.Mutex
	lastPush map[uuid.UUID]time.Time
}

func NewLimits(cfg LimitConfig) *Limits {
	const mb = 1024 * 1024

	return &Limits{
		cfg:         cfg,
		connsPerIP:  make(map[string]int),
		connects:    newKeyedLimiter(float64(cfg.ConnectsPerMinutePerIP)/60, float64(cfg.ConnectsPerMinutePerIP)),
		messagesIP:  newKeyedLimiter(cfg.MessagesPerSecondPerIP, cfg.MessagesPerSecondPerIP*4),
		roomCreates: newKeyedLimiter(float64(cfg.RoomsPerHourPerIP)/3600, float64(cfg.RoomsPerHourPerIP)),
		uploadBytes: newKeyedLimiter(float64(cfg.UploadMBPerHourPerIP)*mb/3600, float64(cfg.UploadMBPerHourPerIP)*mb),
		lastPush:    make(map[uuid.UUID]time.Time),
	}
}

// AcquireConn reserves a connection slot for the IP. ReleaseConn must be called when the
// connection ends.
func (l *Limits) AcquireConn(ip string) error {
	if !l.connects.Allow(ip, 1) {
		return ErrTooManyConnects
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	if l.conns >= l.cfg.MaxConnections || l.connsPerIP[ip] >= l.cfg.MaxConnectionsPerIP {
		return ErrTooManyConnections
	}

	l.conns++
	l.connsPerIP[ip]++

	return nil
}

func (l *Limits) ReleaseConn(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.conns--
	l.connsPerIP[ip]--
	if l.connsPerIP[ip] <= 0 {
		delete(l.connsPerIP, ip)
	}
}

func (l *Limits) AllowMessageIP(ip string) bool {
	return l.messagesIP.Allow(ip, 1)
}

func (l *Limits) AllowRoomCreate(ip string) bool {
	return l.roomCreates.Allow(ip, 1)
}

func (l *Limits) AllowUpload(ip string, bytes int64) bool {
	return l.uploadBytes.Allow(ip, float64(bytes))
}

// AllowPush returns false if the device got a push less than PushInterval ago. Many messages
// in a short time then cause one notification instead of one per message.
func (l *Limits) AllowPush(peer uuid.UUID) bool {
	l.pushMu.Lock()
	defer l.pushMu.Unlock()

	now := time.Now()
	if now.Sub(l.lastPush[peer]) < l.cfg.PushInterval {
		return false
	}
	l.lastPush[peer] = now

	// Forget old entries now and then
	if len(l.lastPush) > 10000 {
		for id, t := range l.lastPush {
			if now.Sub(t) >= l.cfg.PushInterval {
				delete(l.lastPush, id)
			}
		}
	}

	return true
}

// RoomStoreTTL is how long a room record is kept after the last activity: the longest
// message lifetime plus RoomIdleTime. Unused rooms (and their member lists) disappear by themselves.
func (l *Limits) RoomStoreTTL(r *domain.Room) int64 {
	return domain.ClampTTL(r.TTL) + int64(l.cfg.RoomIdleTime.Seconds())
}

// connLimits are the limits of one connection.
type connLimits struct {
	messages   bucket
	joins      bucket
	violations int // dropped frames; too many close the connection
}

// maxViolations is the number of dropped frames after which a connection is closed
const maxViolations = 100
