package web

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"

	"dshoo/internal/store"
	"dshoo/internal/tunnel"
)

// maxDisplayName bounds a plugin-supplied name so the list stays readable.
const maxDisplayName = 64

// handleTunnel accepts the plugin's outbound WebSocket. The plugin
// authenticates with the account it was configured with, reports what machine
// it runs on, and then carries every proxied stream for that instance.
func (s *Server) handleTunnel(w http.ResponseWriter, r *http.Request) {
	username, password, ok := r.BasicAuth()
	if !ok {
		w.Header().Set("WWW-Authenticate", `Basic realm="dshoo"`)
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	user, err := s.store.FindUserByName(r.Context(), username)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			s.log.Error("tunnel lookup user", "err", err)
		}
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := store.VerifyPassword(user.PasswordHash, password); err != nil {
		s.log.Warn("tunnel auth failed", "user", username, "ip", s.clientIP(r))
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns:  []string{"*"},
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		s.log.Warn("tunnel accept", "err", err)
		return
	}
	// Proxied responses arrive in 32 KB chunks plus the frame header, and a
	// rewritten index page can be larger still; the library default is 32 KB.
	conn.SetReadLimit(64 << 20)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	helloCtx, helloCancel := context.WithTimeout(ctx, 20*time.Second)
	typ, data, err := conn.Read(helloCtx)
	helloCancel()
	if err != nil || typ != websocket.MessageText {
		_ = conn.Close(websocket.StatusPolicyViolation, "hello required")
		return
	}
	var meta tunnel.HelloMeta
	if err := json.Unmarshal(data, &meta); err != nil || strings.TrimSpace(meta.Key) == "" {
		_ = conn.Close(websocket.StatusPolicyViolation, "bad hello")
		return
	}
	meta.Name = sanitizeName(meta.Name, meta.Hostname, user.Username)

	instance, err := s.store.UpsertInstance(r.Context(), store.Instance{
		UserID:     user.ID,
		Key:        meta.Key,
		Name:       meta.Name,
		Hostname:   meta.Hostname,
		OS:         meta.OS,
		Arch:       meta.Arch,
		DSHVersion: meta.DSHVersion,
		PluginVer:  meta.PluginVer,
		Status:     "online",
	})
	if err != nil {
		s.log.Error("register instance", "err", err)
		_ = conn.Close(websocket.StatusInternalError, "register failed")
		return
	}

	var tun *tunnel.Tunnel
	tun = tunnel.NewTunnel(instance.ID, user.ID, conn, s.log, func() {
		s.hub.Remove(tun)
		bg, bgCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer bgCancel()
		if err := s.store.MarkOffline(bg, instance.ID); err != nil {
			s.log.Warn("mark offline", "instance", instance.ID, "err", err)
		}
		s.bus.publish(event{Kind: "instance", InstanceID: instance.ID, Online: false})
		s.log.Info("instance disconnected", "name", instance.Name, "id", instance.ID, "user", user.Username)
	})
	tun.Meta = meta
	s.hub.Add(tun)

	if err := tun.SendJSON(tunnel.HelloAck{
		Type:       "hello-ack",
		InstanceID: instance.ID,
		Prefix:     "/i/" + instance.ID,
		ServerTime: time.Now().Unix(),
	}); err != nil {
		tun.Close()
		return
	}
	s.bus.publish(event{Kind: "instance", InstanceID: instance.ID, Online: true})
	s.log.Info("instance connected", "name", instance.Name, "id", instance.ID,
		"user", user.Username, "os", meta.OS, "dsh", meta.DSHVersion)

	go tun.Pinger(ctx, 25*time.Second)
	_ = tun.ReadLoop(ctx)
}

// sanitizeName picks the best available display name for an instance.
func sanitizeName(candidates ...string) string {
	for _, c := range candidates {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if len([]rune(c)) > maxDisplayName {
			c = string([]rune(c)[:maxDisplayName])
		}
		return c
	}
	return "未命名实例"
}
