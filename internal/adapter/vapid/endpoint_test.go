package vapid

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

func TestValidEndpoint(t *testing.T) {
	tests := []struct {
		url   string
		valid bool
	}{
		{"https://fcm.googleapis.com/fcm/send/abc", true},
		{"https://web.push.apple.com/QGx", true},
		{"https://updates.push.services.mozilla.com/wpush/v2/x", true},
		{"https://db5p.notify.windows.com/w/?token=x", true},
		{"http://fcm.googleapis.com/fcm/send/abc", false},    // no https
		{"https://fcm.googleapis.com:8443/x", false},         // other port
		{"https://evil.com/fcm.googleapis.com", false},       // host only in the path
		{"https://fcm.googleapis.com.evil.com/x", false},     // suffix trick
		{"https://evilpush.apple.com.attacker.net/x", false}, // suffix trick
		{"https://user@fcm.googleapis.com/x", false},         // user info
		{"https://127.0.0.1/x", false},                       // internal address
		{"https://localhost/x", false},                       // internal name
		{"not a url", false},
	}

	for _, tt := range tests {
		got := ValidEndpoint(tt.url)
		if got != tt.valid {
			t.Errorf("ValidEndpoint(%q) = %v, want %v", tt.url, got, tt.valid)
		}
	}
}

func TestPushClientBlocksInternalAddresses(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:443", "10.0.0.1:443", "192.168.1.1:443", "169.254.169.254:80", "[::1]:443", "100.64.0.1:443"} {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		conn, err := dialContext(ctx, "tcp", addr)
		cancel()
		if conn != nil {
			_ = conn.Close()
		}
		if !errors.Is(err, errBlockedAddress) {
			t.Errorf("dial %s: got %v, want errBlockedAddress", addr, err)
		}
	}

	if blockedIP(net.ParseIP("142.250.185.106")) {
		t.Error("public address must not be blocked")
	}
}
