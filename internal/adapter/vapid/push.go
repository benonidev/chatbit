package vapid

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"sync"

	"github.com/SherClockHolmes/webpush-go"
)

type VapidKeys struct {
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
}

var (
	keys         VapidKeys
	subMu        sync.Mutex
	subscription *webpush.Subscription // Demo: a single subscription kept in memory
)

// GenerateVAPIDKeys will create a private and public VAPID key pair
func GenerateVAPIDKeys() (privateKey, publicKey string, err error) {
	// Get the private key from the P256 curve
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return
	}

	// PublicKey returns the uncompressed byte format (65 bytes) by default for P256
	pub := priv.PublicKey().Bytes()
	privBytes := priv.Bytes()

	// Convert to URL-safe base64 without padding as per VAPID spec
	publicKey = base64.RawURLEncoding.EncodeToString(pub)
	privateKey = base64.RawURLEncoding.EncodeToString(privBytes)

	return
}

func ensureVapidKeys(path string) (VapidKeys, error) {
	// load existing keys if present
	b, err := os.ReadFile(path)
	if err == nil {
		var k VapidKeys
		err = json.Unmarshal(b, &k)
		if err != nil {
			return VapidKeys{}, err
		}
		if k.PublicKey != "" && k.PrivateKey != "" {
			return k, nil
		}
	}

	// otherwise generate new keys
	priv, pub, err := GenerateVAPIDKeys()
	if err != nil {
		return VapidKeys{}, err
	}
	k := VapidKeys{PublicKey: pub, PrivateKey: priv}

	b, _ = json.MarshalIndent(k, "", "  ")
	err = os.WriteFile(path, b, 0600)
	if err != nil {
		return VapidKeys{}, err
	}
	log.Println("✅ VAPID keys generated:", path)
	log.Println(pub)
	return k, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// LoadKeys loads the VAPID key pair used to sign web push messages.
// Priority:
//  1. env VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (both must be set)
//  2. vapid.json in the working directory
//  3. a newly generated key pair, which is then stored in vapid.json
//
// The browser subscribes with the public key, so it must not change between restarts —
// otherwise all existing push subscriptions become invalid.
func LoadKeys() {
	pub := os.Getenv("VAPID_PUBLIC_KEY")
	priv := os.Getenv("VAPID_PRIVATE_KEY")

	if pub != "" || priv != "" {
		if pub == "" || priv == "" {
			log.Fatal("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together")
		}

		keys = VapidKeys{PublicKey: pub, PrivateKey: priv}
		log.Println("VAPID keys loaded from env")

		return
	}

	var err error
	keys, err = ensureVapidKeys("vapid.json")
	if err != nil {
		log.Fatal(err)
	}
}

// Keys returns the key pair loaded by LoadKeys.
func Keys() VapidKeys {
	return keys
}

// --- API ---
var VapIDPubKeyFunc = func(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]string{"publicKey": keys.PublicKey})
}

var SubscribeFunc = func(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(405)
		return
	}
	var sub webpush.Subscription
	err := json.NewDecoder(r.Body).Decode(&sub)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid subscription json"})
		return
	}
	subMu.Lock()
	subscription = &sub
	subMu.Unlock()

	writeJSON(w, 201, map[string]bool{"ok": true})
}

var SendFunc = func(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(405)
		return
	}

	subMu.Lock()
	sub := subscription
	subMu.Unlock()
	if sub == nil {
		writeJSON(w, 400, map[string]string{"error": "No subscription found. Call /subscribe first."})
		return
	}

	// Payload as expected by the service worker
	var req struct {
		Title string `json:"title"`
		Body  string `json:"body"`
		URL   string `json:"url"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.Title == "" {
		req.Title = "Hello from the PWA 👋"
	}
	if req.Body == "" {
		req.Body = "This is a test push notification."
	}
	if req.URL == "" {
		req.URL = "/"
	}

	payload, _ := json.Marshal(map[string]any{
		"title": req.Title,
		"body":  req.Body,
		"url":   req.URL,
	})

	resp, err := webpush.SendNotification(payload, sub, &webpush.Options{
		Subscriber:      "alessandro@chatbit.ch",
		VAPIDPublicKey:  keys.PublicKey,
		VAPIDPrivateKey: keys.PrivateKey,
		TTL:             60, // seconds
	})
	if err != nil {
		log.Println("❌ push error:", err)
		writeJSON(w, 500, map[string]string{"error": "push failed", "details": err.Error()})
		return
	}
	_ = resp.Body.Close()

	writeJSON(w, 200, map[string]bool{"ok": true})
}
