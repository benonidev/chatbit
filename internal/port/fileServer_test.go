package port

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSecurityHeaders(t *testing.T) {
	tests := []struct {
		host      string
		websocket bool
	}{
		{"chat.example.com", true},
		{"localhost:8080", true},
		{"[::1]:8080", true},
		{"evil.com; script-src *", false},
	}
	for _, tt := range tests {
		r := httptest.NewRequest("GET", "/", nil)
		r.Host = tt.host
		w := httptest.NewRecorder()

		setSecurityHeaders(w, r)

		csp := w.Header().Get("Content-Security-Policy")
		if !strings.Contains(csp, "script-src 'self' 'wasm-unsafe-eval';") {
			t.Errorf("%s: script-src missing in %q", tt.host, csp)
		}
		if got := strings.Contains(csp, "wss://"+tt.host); got != tt.websocket {
			t.Errorf("%s: websocket source in CSP = %v, want %v", tt.host, got, tt.websocket)
		}
		if strings.Count(csp, "script-src") != 1 {
			t.Errorf("%s: host injected a directive: %q", tt.host, csp)
		}
		if w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: nosniff missing", tt.host)
		}
	}
}
