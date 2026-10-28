package vapid

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"time"
)

// pushHosts are the push services of the browsers. A subscription endpoint must point to one
// of them — otherwise a client could make the server send requests to any address
// (e.g. services in the internal network).
var pushHosts = []string{
	"fcm.googleapis.com",                // Chrome, Android, Edge (Chromium)
	".push.apple.com",                   // Safari, iOS
	"updates.push.services.mozilla.com", // Firefox
	".notify.windows.com",               // Edge (legacy), Windows
}

// ValidEndpoint reports whether a push subscription endpoint is an https URL of a known push service.
func ValidEndpoint(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Port() != "" || u.User != nil {
		return false
	}

	host := strings.ToLower(u.Hostname())
	for _, h := range pushHosts {
		if host == h || (strings.HasPrefix(h, ".") && strings.HasSuffix(host, h)) {
			return true
		}
	}

	return false
}

var errBlockedAddress = errors.New("push endpoint resolves to a blocked address")

// cgnat is the shared address space of carrier grade NAT (100.64.0.0/10), not covered by IsPrivate
var cgnat = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

func blockedIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsInterfaceLocalMulticast() || cgnat.Contains(ip)
}

// pushClient sends the push requests. The dialer checks the IP after the DNS lookup, so a
// host name that points to an internal address is refused as well. No proxy, no redirects.
var pushClient = &http.Client{
	Timeout: 10 * time.Second,
	Transport: &http.Transport{
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout: 5 * time.Second,
			Control: func(_, address string, _ syscall.RawConn) error {
				host, _, err := net.SplitHostPort(address)
				if err != nil {
					return err
				}
				ip := net.ParseIP(host)
				if ip == nil || blockedIP(ip) {
					return errBlockedAddress
				}
				return nil
			},
		}).DialContext,
		TLSHandshakeTimeout: 5 * time.Second,
		MaxIdleConns:        20,
		IdleConnTimeout:     90 * time.Second,
	},
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// HTTPClient returns the client for sending push notifications (webpush.Options.HTTPClient).
func HTTPClient() *http.Client {
	return pushClient
}

// dialContext is used by the tests
var dialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
	return pushClient.Transport.(*http.Transport).DialContext(ctx, network, addr)
}
