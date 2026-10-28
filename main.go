package main

import (
	"chatbit/internal/adapter/vapid"
	"chatbit/internal/core"
	"chatbit/internal/domain"
	"chatbit/internal/port"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"
)

// Injected at build time via -ldflags (see Taskfile.yml)
var (
	version   = "dev"
	commit    = "none"
	buildDate = "unknown"
)

func main() {
	// chatbit -asset-hash: prints the hash of the web app in ./dist (the one the app shows before
	// an update) — to compare a server or a release with the source
	assetHash := flag.Bool("asset-hash", false, "print the hash of ./dist and exit")
	flag.Parse()
	if *assetHash {
		hash, err := port.AssetHash(port.StaticPath)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println(hash)
		return
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	slog.SetLogLoggerLevel(logLevel())

	// Without a build date (go run, go build without the Taskfile) the start time is used.
	// It names the service worker cache, so the clients get an update after every restart.
	if buildDate == "unknown" {
		buildDate = time.Now().UTC().Format(time.RFC3339)
	}

	app := core.NewApplication()

	// log := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	logger.Info("ChatBit start")

	// Store every message; the TTL was already replaced with the room TTL by the WebSocket client
	_, err := app.PS.Message.Subscribe(func(obj domain.Message) {
		obj.TTL = domain.ClampTTL(obj.TTL)

		err := app.DB.Message.AddWithTTL(obj, obj.TTL)
		if err != nil {
			logger.Error("not possible to store message", slog.String("room", obj.RoomID.String()), slog.String("error", err.Error()))
		}
	})
	if err != nil {
		logger.Error("not possible to subscribe to messages", slog.String("error", err.Error()))
		os.Exit(1)
	}

	vapid.LoadKeys()

	serv := port.NewServer(app, port.BuildInfo{
		Version:   version,
		Commit:    commit,
		BuildDate: buildDate,
	})
	err = serv.Start()
	if err != nil {
		logger.Error("server stopped", slog.String("error", err.Error()))
		os.Exit(1)
	}

}

// logLevel reads LOG_LEVEL (debug, info, warn, error; default info). Client, room and message
// ids are only logged on debug — keep it off in production, logs are metadata.
func logLevel() slog.Level {
	var level slog.Level
	err := level.UnmarshalText([]byte(os.Getenv("LOG_LEVEL")))
	if err != nil {
		return slog.LevelInfo
	}

	return level
}
