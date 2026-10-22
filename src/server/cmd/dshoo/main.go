package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"dshoo/internal/config"
	"dshoo/internal/store"
	"dshoo/internal/tunnel"
	"dshoo/internal/web"
)

// version is stamped by the release pipeline.
var version = "dev"

func main() {
	showVersion := flag.Bool("version", false, "print version and exit")
	passwd := flag.Bool("passwd", false, "reset one account's password and exit")
	account := flag.String("user", "", "account for -passwd")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

	level := slog.LevelInfo
	if strings.EqualFold(os.Getenv("DSHOO_DEBUG"), "1") {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)

	cfg := config.Load()
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		log.Error("create data dir", "dir", cfg.DataDir, "err", err)
		os.Exit(1)
	}

	st, err := store.Open(filepath.Join(cfg.DataDir, "dshoo.db"))
	if err != nil {
		log.Error("open database", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *passwd {
		resetPassword(ctx, st, *account, log)
		return
	}

	if err := st.MarkAllOffline(ctx); err != nil {
		log.Warn("reset instance status", "err", err)
	}

	hub := tunnel.NewHub()
	srv, err := web.New(cfg, st, hub, log)
	if err != nil {
		log.Error("build server", "err", err)
		os.Exit(1)
	}
	srv.StartMaintenance(ctx)

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 20 * time.Second,
		IdleTimeout:       120 * time.Second,
		// No WriteTimeout: proxied SSE streams and WebSockets stay open.
	}
	go func() {
		log.Info("dshoo server listening", "addr", cfg.Addr, "data", cfg.DataDir, "version", version)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("listen", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
	log.Info("stopped")
}

// resetPassword replaces one account's password from DSHOO_NEW_PASSWORD or
// standard input, so a forgotten password needs no SQL. The value never appears
// on the command line, where other processes could read it.
func resetPassword(ctx context.Context, st *store.Store, account string, log *slog.Logger) {
	if account == "" {
		log.Error("-passwd requires -user <name>")
		os.Exit(2)
	}
	password := os.Getenv("DSHOO_NEW_PASSWORD")
	if password == "" {
		scanner := bufio.NewScanner(os.Stdin)
		if scanner.Scan() {
			password = strings.TrimRight(scanner.Text(), "\r\n")
		}
		if err := scanner.Err(); err != nil {
			log.Error("read password from stdin", "err", err)
			os.Exit(1)
		}
	}
	if len(password) < 8 {
		log.Error("password must be at least 8 characters")
		os.Exit(2)
	}
	user, err := st.FindUserByName(ctx, account)
	if err != nil {
		log.Error("account not found", "user", account, "err", err)
		os.Exit(1)
	}
	hash, err := store.HashPassword(password)
	if err != nil {
		log.Error("hash password", "err", err)
		os.Exit(1)
	}
	if err := st.SetPassword(ctx, user.ID, hash); err != nil {
		log.Error("update password", "err", err)
		os.Exit(1)
	}
	log.Info("password updated", "user", account)
}
