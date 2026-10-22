package web

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"dshoo/internal/config"
	"dshoo/internal/store"
	"dshoo/internal/tunnel"
)

// newTestServer builds the smallest server that can exercise tunnel state:
// a real SQLite database, a hub, and no HTTP listener.
func newTestServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "dshoo.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := &Server{
		cfg:          config.Config{},
		store:        st,
		hub:          tunnel.NewHub(),
		log:          log,
		bus:          newBroadcaster(),
		mux:          nil,
		offlineGrace: 120 * time.Millisecond,
	}
	return s, st
}

func seedInstance(t *testing.T, st *store.Store) store.Instance {
	t.Helper()
	ctx := context.Background()
	user, err := st.CreateFirstUser(ctx, "admin", "hash")
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	instance, err := st.UpsertInstance(ctx, store.Instance{
		UserID: user.ID, Key: "key-1", Name: "lab", Status: "online",
	})
	if err != nil {
		t.Fatalf("upsert instance: %v", err)
	}
	return instance
}

func fakeTunnel(id string) *tunnel.Tunnel {
	return tunnel.NewTunnel(id, 1, nil, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
}

func instanceStatus(t *testing.T, st *store.Store, userID int64, id string) string {
	t.Helper()
	instance, err := st.GetInstance(context.Background(), userID, id)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	return instance.Status
}

// A dropped tunnel is not reported offline immediately: the instance keeps its
// state for the grace period so a forced reconnect never flickers in the UI.
func TestDisconnectWaitsForTheGracePeriod(t *testing.T) {
	s, st := newTestServer(t)
	instance := seedInstance(t, st)

	dropped := fakeTunnel(instance.ID)
	s.hub.Add(dropped)
	s.onTunnelClosed(dropped, instance.ID, instance.Name, "admin")

	if got := instanceStatus(t, st, 1, instance.ID); got != "online" {
		t.Fatalf("status right after the drop = %q, want online", got)
	}

	time.Sleep(2 * s.offlineGrace)
	if got := instanceStatus(t, st, 1, instance.ID); got != "offline" {
		t.Fatalf("status after the grace period = %q, want offline", got)
	}
}

// Reconnecting inside the window cancels the transition, so the instance never
// appears offline.
func TestReconnectInsideTheGraceKeepsTheInstanceOnline(t *testing.T) {
	s, st := newTestServer(t)
	instance := seedInstance(t, st)

	dropped := fakeTunnel(instance.ID)
	s.hub.Add(dropped)
	s.onTunnelClosed(dropped, instance.ID, instance.Name, "admin")

	// The plugin comes back before the timer fires.
	replacement := fakeTunnel(instance.ID)
	s.hub.Add(replacement)
	s.cancelOffline(instance.ID)

	time.Sleep(2 * s.offlineGrace)
	if got := instanceStatus(t, st, 1, instance.ID); got != "online" {
		t.Fatalf("status after reconnecting = %q, want online", got)
	}
}

// A tunnel that is replaced by a newer one must not report a disconnect.
func TestSupersededTunnelDoesNotScheduleOffline(t *testing.T) {
	s, st := newTestServer(t)
	instance := seedInstance(t, st)

	older := fakeTunnel(instance.ID)
	s.hub.Add(older)
	newer := fakeTunnel(instance.ID)
	s.hub.Add(newer) // replaces and closes the older tunnel

	// The close callback the handler installs runs for the older tunnel; it
	// must recognise that a newer tunnel owns the instance and stay silent.
	s.onTunnelClosed(older, instance.ID, instance.Name, "admin")

	time.Sleep(2 * s.offlineGrace)
	if got := instanceStatus(t, st, 1, instance.ID); got != "online" {
		t.Fatalf("status after a handover = %q, want online", got)
	}
	if !s.hub.Online(instance.ID) {
		t.Fatal("the newer tunnel was removed by the older one's close")
	}
}
