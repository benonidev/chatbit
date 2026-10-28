package port

import (
	"bytes"
	"chatbit/internal/adapter/vapid"
	"chatbit/internal/domain"
	"encoding/json"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
)

const StaticPath = "./dist/"

func (s *Server) StartFileServer(info BuildInfo) {
	servFile, err := NewFileHandler(vapid.Keys().PublicKey, info)
	if err != nil {
		slog.Error("failed to create file handler", slog.String("error", err.Error()))
		return
	}

	s.servMux.Handle("/", servFile)
}

type fileHandler struct {
	static      http.Handler
	indexHTML   []byte
	swJS        []byte
	versionJSON []byte
}

// versionInfo is /version.json: what the server delivers right now. The app shows it next to its
// own version before it updates (AssetHash: compare with the release on GitHub).
type versionInfo struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildDate string `json:"buildDate"`
	AssetHash string `json:"assetHash"`
}

type templateData struct {
	VAPIDPublicKey string
	Version        string
	Commit         string
	BuildDate      string
	MaxFileSize    int64 // bytes (encrypted), so the app can refuse too large files before the upload
	AssetHash      string
}

func NewFileHandler(vapidPubKey string, info BuildInfo) (*fileHandler, error) {
	assetHash, err := AssetHash(StaticPath)
	if err != nil {
		return nil, fmt.Errorf("asset hash: %w", err)
	}

	versionJSON, err := json.Marshal(versionInfo{Version: info.Version, Commit: info.Commit, BuildDate: info.BuildDate, AssetHash: assetHash})
	if err != nil {
		return nil, fmt.Errorf("version info: %w", err)
	}

	data := templateData{
		VAPIDPublicKey: vapidPubKey,
		Version:        info.Version,
		Commit:         info.Commit,
		BuildDate:      info.BuildDate,
		MaxFileSize:    domain.MaxFileSize,
		AssetHash:      assetHash,
	}

	indexHTML, err := renderTemplate(filepath.Join(StaticPath, "index.html"), data)
	if err != nil {
		return nil, fmt.Errorf("render index.html: %w", err)
	}

	swJS, err := renderTemplate(filepath.Join(StaticPath, "service-worker.js"), data)
	if err != nil {
		return nil, fmt.Errorf("render service-worker.js: %w", err)
	}

	return &fileHandler{
		static:      http.FileServer(http.Dir(StaticPath)),
		indexHTML:   indexHTML,
		swJS:        swJS,
		versionJSON: versionJSON,
	}, nil
}

func renderTemplate(path string, data any) ([]byte, error) {
	tmpl, err := template.ParseFiles(path)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	err = tmpl.Execute(&buf, data)
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// contentSecurityPolicy only allows code, styles, images and connections from our own origin.
// Even if HTML gets injected somewhere (e.g. through a room name), no script of an attacker runs
// and nothing can be sent elsewhere — the room keys stay on the device.
//   - 'wasm-unsafe-eval': the zxing QR decoder is WebAssembly (no eval of JavaScript)
//   - style-src 'unsafe-inline': style attributes in the templates and of Bootstrap / ionicons
//   - blob: / data: images: decrypted images are shown as blob URLs, the CSS uses data: icons
//   - connect-src: the WebSocket on the same host (older Safari does not count ws/wss as 'self')
const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self' 'wasm-unsafe-eval'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' blob: data:; " +
	"media-src 'self' blob:; " +
	"font-src 'self'; " +
	"worker-src 'self'; " +
	"manifest-src 'self'; " +
	"object-src 'none'; " +
	"base-uri 'none'; " +
	"form-action 'none'; " +
	"frame-ancestors 'none'; " +
	"connect-src 'self'"

// validHost matches host[:port] — anything else in the Host header is not put into the CSP
var validHost = regexp.MustCompile(`^[A-Za-z0-9.\-]+(:[0-9]+)?$|^\[[0-9A-Fa-f:.]+\](:[0-9]+)?$`)

// setSecurityHeaders adds the CSP and the other browser protections to every response
func setSecurityHeaders(w http.ResponseWriter, r *http.Request) {
	csp := contentSecurityPolicy
	if validHost.MatchString(r.Host) {
		csp += " wss://" + r.Host + " ws://" + r.Host
	}

	h := w.Header()
	h.Set("Content-Security-Policy", csp)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Permissions-Policy", "camera=(self), microphone=(), geolocation=(), payment=(), usb=()")
}

func (h *fileHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setSecurityHeaders(w, r)

	// Intercept service worker — serve rendered version with injected build info
	if r.URL.Path == "/service-worker.js" {
		w.Header().Set("Content-Type", "application/javascript")
		w.Header().Set("Cache-Control", "no-store")
		_, err := w.Write(h.swJS)
		if err != nil {
			slog.Debug("not possible to write service worker", slog.String("error", err.Error()))
		}
		return
	}

	if r.URL.Path == "/version.json" {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, err := w.Write(h.versionJSON)
		if err != nil {
			slog.Debug("not possible to write version info", slog.String("error", err.Error()))
		}
		return
	}

	// The page itself is always the rendered template — http.FileServer would send "/" and
	// "/index.html" as they are on disk, with the {{...}} placeholders
	if r.URL.Path == "/" || r.URL.Path == "/index.html" {
		h.serveIndex(w, r)
		return
	}

	path := filepath.Join(StaticPath, filepath.Clean(r.URL.Path))

	_, err := os.Stat(path)
	switch {
	case os.IsNotExist(err):
		slog.Debug("file not found, serving index.html", slog.String("path", path))
		h.serveIndex(w, r)

	case err != nil:
		slog.Error("file server error", slog.String("path", path), slog.String("error", err.Error()))
		http.Error(w, err.Error(), http.StatusInternalServerError)

	default:
		// no-cache: the browser may keep the file but must revalidate it (cheap 304 via Last-Modified).
		// Without it browsers cache JS modules heuristically and mix old and new files after a deploy.
		w.Header().Set("Cache-Control", "no-cache")
		h.static.ServeHTTP(w, r)
	}
}

func (h *fileHandler) serveIndex(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, err := w.Write(h.indexHTML)
	if err != nil {
		slog.Debug("not possible to write index.html", slog.String("error", err.Error()))
	}
}
