package port

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

func testConfig() LimitConfig {
	return LimitConfig{
		MaxConnections:         3,
		MaxConnectionsPerIP:    2,
		ConnectsPerMinutePerIP: 100,
		MessagesPerSecondPerIP: 1,
		RoomsPerHourPerIP:      2,
		UploadMBPerHourPerIP:   1,
		PushInterval:           time.Minute,
	}
}

func TestBucket(t *testing.T) {
	var b bucket
	now := time.Now()

	for i := 0; i < 3; i++ {
		if !b.allow(now, 1, 3, 1) {
			t.Fatalf("token %d of the burst refused", i)
		}
	}
	if b.allow(now, 1, 3, 1) {
		t.Fatal("bucket must be empty after the burst")
	}
	if !b.allow(now.Add(time.Second), 1, 3, 1) {
		t.Fatal("one token per second must be refilled")
	}
}

func TestAcquireConn(t *testing.T) {
	l := NewLimits(testConfig())

	for i := 0; i < 2; i++ {
		err := l.AcquireConn("1.1.1.1")
		if err != nil {
			t.Fatalf("connection %d of one IP refused: %v", i+1, err)
		}
	}
	err := l.AcquireConn("1.1.1.1")
	if !errors.Is(err, ErrTooManyConnections) {
		t.Fatalf("third connection of one IP: got %v", err)
	}

	if l.AcquireConn("2.2.2.2") != nil {
		t.Fatal("other IP must get a connection")
	}
	err = l.AcquireConn("3.3.3.3")
	if !errors.Is(err, ErrTooManyConnections) {
		t.Fatalf("global limit: got %v", err)
	}

	l.ReleaseConn("1.1.1.1")
	if l.AcquireConn("3.3.3.3") != nil {
		t.Fatal("released slot must be free again")
	}
}

func TestConnectRate(t *testing.T) {
	cfg := testConfig()
	cfg.ConnectsPerMinutePerIP = 2
	cfg.MaxConnectionsPerIP = 100
	cfg.MaxConnections = 100
	l := NewLimits(cfg)

	_ = l.AcquireConn("1.1.1.1")
	_ = l.AcquireConn("1.1.1.1")
	err := l.AcquireConn("1.1.1.1")
	if !errors.Is(err, ErrTooManyConnects) {
		t.Fatalf("got %v, want ErrTooManyConnects", err)
	}
}

func TestUploadQuota(t *testing.T) {
	l := NewLimits(testConfig()) // 1 MB per hour

	if !l.AllowUpload("1.1.1.1", 700*1024) {
		t.Fatal("first upload must fit")
	}
	if l.AllowUpload("1.1.1.1", 700*1024) {
		t.Fatal("second upload exceeds the quota")
	}
	if !l.AllowUpload("2.2.2.2", 700*1024) {
		t.Fatal("quota is per IP")
	}
}

func TestAllowPush(t *testing.T) {
	l := NewLimits(testConfig())
	peer := uuid.New()

	if !l.AllowPush(peer) {
		t.Fatal("first push must be sent")
	}
	if l.AllowPush(peer) {
		t.Fatal("second push within the interval must be suppressed")
	}
	if !l.AllowPush(uuid.New()) {
		t.Fatal("interval is per device")
	}
}

func TestClientIP(t *testing.T) {
	trusted := envNets("TEST_UNSET_TRUSTED_PROXIES", "127.0.0.1/8,::1/128")

	tests := []struct {
		name   string
		remote string
		xff    string
		want   string
	}{
		{"direct client", "8.8.8.8:1234", "", "8.8.8.8"},
		{"direct client fakes header", "8.8.8.8:1234", "1.2.3.4", "8.8.8.8"},
		{"behind proxy", "127.0.0.1:1234", "8.8.8.8", "8.8.8.8"},
		{"behind proxy, client fakes first hop", "127.0.0.1:1234", "1.2.3.4, 8.8.8.8", "8.8.8.8"},
		{"proxy without header", "127.0.0.1:1234", "", "127.0.0.1"},
		{"ipv6 proxy", "[::1]:1234", "2001:db8::1", "2001:db8::1"},
	}

	for _, tt := range tests {
		r := &http.Request{RemoteAddr: tt.remote, Header: http.Header{}}
		if tt.xff != "" {
			r.Header.Set("X-Forwarded-For", tt.xff)
		}
		got := clientIP(r, trusted)
		if got != tt.want {
			t.Errorf("%s: clientIP = %s, want %s", tt.name, got, tt.want)
		}
	}
}
