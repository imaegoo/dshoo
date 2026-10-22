package tunnel

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// ErrTunnelClosed is returned when a stream is opened on a dead tunnel.
var ErrTunnelClosed = errors.New("tunnel: closed")

// Tunnel is one connected plugin. Its WebSocket carries every proxied stream
// for the instance: HTTP requests, response bodies, and WebSocket messages all
// share the connection and are told apart by stream id.
type Tunnel struct {
	ID     string
	UserID int64
	Meta   HelloMeta

	conn   *websocket.Conn
	writeM sync.Mutex

	streamM sync.RWMutex
	streams map[uint32]chan Frame

	nextID  atomic.Uint32
	closed  atomic.Bool
	once    sync.Once
	done    chan struct{}
	closeFn func()

	log *slog.Logger
}

// NewTunnel wraps an accepted WebSocket. closeFn runs once when the tunnel dies.
func NewTunnel(id string, userID int64, conn *websocket.Conn, log *slog.Logger, closeFn func()) *Tunnel {
	return &Tunnel{
		ID:      id,
		UserID:  userID,
		conn:    conn,
		streams: make(map[uint32]chan Frame),
		done:    make(chan struct{}),
		closeFn: closeFn,
		log:     log,
	}
}

// Done is closed when the tunnel stops.
func (t *Tunnel) Done() <-chan struct{} { return t.done }

// Close tears the tunnel down, failing every open stream.
func (t *Tunnel) Close() {
	t.once.Do(func() {
		t.closed.Store(true)
		close(t.done)
		t.streamM.Lock()
		for id, ch := range t.streams {
			close(ch)
			delete(t.streams, id)
		}
		t.streamM.Unlock()
		if t.conn != nil {
			_ = t.conn.Close(websocket.StatusNormalClosure, "tunnel closed")
		}
		if t.closeFn != nil {
			t.closeFn()
		}
	})
}

// OpenStream reserves a stream id and returns the channel its frames arrive on.
// The returned release function must be called when the stream ends.
func (t *Tunnel) OpenStream() (uint32, chan Frame, func()) {
	id := t.nextID.Add(1)
	ch := make(chan Frame, 32)
	t.streamM.Lock()
	if t.closed.Load() {
		t.streamM.Unlock()
		close(ch)
		return id, ch, func() {}
	}
	t.streams[id] = ch
	t.streamM.Unlock()
	release := func() {
		t.streamM.Lock()
		if existing, ok := t.streams[id]; ok {
			delete(t.streams, id)
			close(existing)
		}
		t.streamM.Unlock()
	}
	return id, ch, release
}

// Send writes one binary frame, serialising concurrent writers.
func (t *Tunnel) Send(f Frame) error {
	if t.closed.Load() {
		return ErrTunnelClosed
	}
	buf := AppendFrame(make([]byte, 0, HeaderSize+len(f.Payload)), f)
	return t.writeBinary(buf)
}

func (t *Tunnel) writeBinary(buf []byte) error {
	t.writeM.Lock()
	defer t.writeM.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := t.conn.Write(ctx, websocket.MessageBinary, buf); err != nil {
		t.log.Debug("tunnel write failed", "instance", t.ID, "err", err)
		return err
	}
	return nil
}

// SendJSON writes a control frame as a WebSocket text message.
func (t *Tunnel) SendJSON(v any) error {
	if t.closed.Load() {
		return ErrTunnelClosed
	}
	body, err := json.Marshal(v)
	if err != nil {
		return err
	}
	t.writeM.Lock()
	defer t.writeM.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return t.conn.Write(ctx, websocket.MessageText, body)
}

// Pinger keeps the WebSocket warm so proxies do not idle it out.
func (t *Tunnel) Pinger(ctx context.Context, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.done:
			return
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := t.conn.Ping(pingCtx)
			cancel()
			if err != nil {
				t.Close()
				return
			}
		}
	}
}

// ReadLoop dispatches frames until the tunnel closes. it returns the read error.
func (t *Tunnel) ReadLoop(ctx context.Context) error {
	defer t.Close()
	for {
		typ, data, err := t.conn.Read(ctx)
		if err != nil {
			return err
		}
		if typ == websocket.MessageText {
			// Text frames are control messages the plugin may send (hello is
			// handled before the loop starts). Ignore unknown ones.
			continue
		}
		f, err := DecodeFrame(data)
		if err != nil {
			t.log.Warn("bad tunnel frame", "instance", t.ID, "err", err)
			continue
		}
		t.deliver(f)
	}
}

func (t *Tunnel) deliver(f Frame) {
	t.streamM.RLock()
	ch, ok := t.streams[f.ID]
	t.streamM.RUnlock()
	if !ok {
		// The stream was released before the frame arrived; drop it rather
		// than blocking the reader for every other stream.
		return
	}
	select {
	case ch <- f:
	case <-t.done:
	}
}

// Hub is the live tunnel registry, keyed by instance id.
type Hub struct {
	m sync.RWMutex
	t map[string]*Tunnel
}

// NewHub builds an empty registry.
func NewHub() *Hub { return &Hub{t: make(map[string]*Tunnel)} }

// Add installs a tunnel, replacing and closing any previous one for the same
// instance. It reports whether a previous tunnel was replaced.
func (h *Hub) Add(tun *Tunnel) bool {
	h.m.Lock()
	old, existed := h.t[tun.ID]
	h.t[tun.ID] = tun
	h.m.Unlock()
	if existed && old != tun {
		old.Close()
	}
	return existed
}

// Get finds a live tunnel.
func (h *Hub) Get(id string) (*Tunnel, bool) {
	h.m.RLock()
	defer h.m.RUnlock()
	tun, ok := h.t[id]
	return tun, ok
}

// Remove drops a tunnel if it is still the registered one.
func (h *Hub) Remove(tun *Tunnel) {
	h.m.Lock()
	defer h.m.Unlock()
	if cur, ok := h.t[tun.ID]; ok && cur == tun {
		delete(h.t, tun.ID)
	}
}

// Online reports whether the instance currently has a tunnel.
func (h *Hub) Online(id string) bool {
	_, ok := h.Get(id)
	return ok
}

// Count is the number of connected instances.
func (h *Hub) Count() int {
	h.m.RLock()
	defer h.m.RUnlock()
	return len(h.t)
}
