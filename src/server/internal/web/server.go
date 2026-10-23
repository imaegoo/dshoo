package web

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"path"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"dshoo/internal/config"
	"dshoo/internal/store"
	"dshoo/internal/tunnel"
)

//go:embed ui
var uiFiles embed.FS

// Server owns the HTTP surface: the browser app, the plugin tunnel, and the
// per-instance reverse proxy.
type Server struct {
	cfg   config.Config
	store *store.Store
	hub   *tunnel.Hub
	log   *slog.Logger
	bus   *broadcaster
	lim   *loginLimiter
	mux   *http.ServeMux

	// needsSetup is true until the first account exists. It is read on every
	// request, so it stays in memory; the database still owns the decision.
	needsSetup atomic.Bool

	// offlineGrace is how long a disconnected instance stays "online" before it
	// is reported offline, so a forced reconnect does not flap the UI.
	offlineGrace time.Duration
	// offlineTimers holds the pending transition per instance id.
	offlineTimers sync.Map
}

// defaultOfflineGrace covers the plugin's retry cadence with margin.
const defaultOfflineGrace = 30 * time.Second

// New builds the server and its route table.
func New(cfg config.Config, st *store.Store, hub *tunnel.Hub, log *slog.Logger) (*Server, error) {
	s := &Server{
		cfg:          cfg,
		store:        st,
		hub:          hub,
		log:          log,
		bus:          newBroadcaster(),
		lim:          newLoginLimiter(),
		mux:          http.NewServeMux(),
		offlineGrace: defaultOfflineGrace,
	}
	users, err := st.CountUsers(context.Background())
	if err != nil {
		return nil, fmt.Errorf("count users: %w", err)
	}
	s.needsSetup.Store(users == 0)
	if err := s.routes(); err != nil {
		return nil, err
	}
	return s, nil
}

// Handler returns the composed HTTP handler.
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Before the first account exists the server exposes nothing but the
		// setup page, so a fresh deployment is never anonymously readable.
		if s.needsSetup.Load() && !allowedBeforeSetup(r.URL.Path) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				writeJSON(w, http.StatusPreconditionRequired, map[string]any{"error": "setup required"})
				return
			}
			target := "/setup"
			if r.URL.Path == "/" {
				target = "/setup"
			}
			http.Redirect(w, r, target, http.StatusSeeOther)
			return
		}
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		s.mux.ServeHTTP(sw, r)
		if r.URL.Path != "/api/events" {
			s.log.Debug("http", "method", r.Method, "path", r.URL.Path, "status", sw.status,
				"ms", time.Since(start).Milliseconds())
		}
	})
}

// allowedBeforeSetup lists what a server with no account still answers.
func allowedBeforeSetup(path string) bool {
	switch path {
	case "/setup", "/api/setup", "/healthz", "/favicon.ico":
		return true
	}
	return strings.HasPrefix(path, "/static/")
}

func (s *Server) routes() error {
	staticFS, err := fs.Sub(uiFiles, "ui")
	if err != nil {
		return err
	}
	s.mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))

	s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "instances": s.hub.Count(), "time": time.Now().UTC(),
		})
	})

	s.mux.HandleFunc("GET /login", s.handleLoginPage)
	s.mux.HandleFunc("GET /setup", s.handleSetupPage)
	s.mux.HandleFunc("POST /api/setup", s.handleSetup)
	s.mux.HandleFunc("GET /favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/static/favicon.svg", http.StatusMovedPermanently)
	})
	// The catch-all owns "/" plus every method-specific path under it, which is
	// what lets the instance proxy carry POST/PUT/PATCH/DELETE. Named routes
	// above are more specific in both method and path, so they win.
	s.mux.HandleFunc("/", s.requireSession(s.handleApp, false))

	s.mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	s.mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	s.mux.HandleFunc("GET /api/me", s.requireSession(s.handleMe, true))

	s.mux.HandleFunc("GET /api/instances", s.requireSession(s.handleListInstances, true))
	s.mux.HandleFunc("GET /api/instances/{id}", s.requireSession(s.handleGetInstance, true))
	s.mux.HandleFunc("DELETE /api/instances/{id}", requireCustomHeader(s.requireSession(s.handleDeleteInstance, true)))
	s.mux.HandleFunc("GET /api/events", s.requireSession(s.handleEvents, true))

	s.mux.HandleFunc("GET /tunnel", s.handleTunnel)

	// Instance proxying owns everything under /i/. It is dispatched from the
	// root handler rather than registered as its own pattern because the proxy
	// must accept every method, and a method-less subtree pattern would
	// conflict with "GET /".
	return nil
}

// ---- pages ----

func (s *Server) serveAsset(w http.ResponseWriter, name string) {
	body, err := uiFiles.ReadFile("ui/" + name)
	if err != nil {
		http.NotFound(w, nil)
		return
	}
	ct := mime.TypeByExtension(path.Ext(name))
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(body)
}

func (s *Server) handleLoginPage(w http.ResponseWriter, r *http.Request) {
	if s.needsSetup.Load() {
		http.Redirect(w, r, "/setup", http.StatusSeeOther)
		return
	}
	if token := s.requestToken(r); token != "" {
		if _, _, err := s.store.SessionUser(r.Context(), store.TokenHash(token)); err == nil {
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
	}
	s.serveAsset(w, "login.html")
}

// handleSetupPage renders the first-run form that creates the only account.
func (s *Server) handleSetupPage(w http.ResponseWriter, r *http.Request) {
	if !s.needsSetup.Load() {
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}
	s.serveAsset(w, "setup.html")
}

func (s *Server) handleApp(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/i/") {
		s.handleProxy(w, r)
		return
	}
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	s.serveAsset(w, "app.html")
}

// ---- auth API ----

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	if wait := s.lim.blocked(ip); wait > 0 {
		w.Header().Set("Retry-After", fmt.Sprint(int(wait.Seconds())))
		writeError(w, http.StatusTooManyRequests, "尝试次数过多，请稍后再试")
		return
	}
	var req loginRequest
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "请求格式错误")
			return
		}
	} else {
		if err := r.ParseForm(); err != nil {
			writeError(w, http.StatusBadRequest, "请求格式错误")
			return
		}
		req.Username = r.PostFormValue("username")
		req.Password = r.PostFormValue("password")
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "请输入用户名和密码")
		return
	}
	user, err := s.store.FindUserByName(r.Context(), req.Username)
	if err != nil {
		s.lim.fail(ip)
		// Compare against a dummy hash so a missing user costs the same time
		// as a wrong password.
		_, _ = store.HashPassword("dummy")
		writeError(w, http.StatusUnauthorized, "用户名或密码不正确")
		return
	}
	if err := store.VerifyPassword(user.PasswordHash, req.Password); err != nil {
		s.lim.fail(ip)
		writeError(w, http.StatusUnauthorized, "用户名或密码不正确")
		return
	}
	expires := time.Now().Add(s.cfg.SessionTTL)
	token, err := store.NewToken(32)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "无法创建会话")
		return
	}
	if err := s.store.CreateSession(r.Context(), user.ID, store.TokenHash(token), expires, r.UserAgent()); err != nil {
		s.log.Error("create session", "err", err)
		writeError(w, http.StatusInternalServerError, "无法创建会话")
		return
	}
	s.lim.success(ip)
	s.setSessionCookie(w, token, expires)
	s.log.Info("login", "user", user.Username, "ip", ip)
	writeJSON(w, http.StatusOK, map[string]any{
		"user":    map[string]any{"id": user.ID, "username": user.Username},
		"expires": expires.UTC(),
	})
}

// setupRequest is the first-run form payload.
type setupRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$`)

// handleSetup creates the only account this server will ever create from the
// browser, then signs the new account in.
func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	if wait := s.lim.blocked(ip); wait > 0 {
		w.Header().Set("Retry-After", fmt.Sprint(int(wait.Seconds())))
		writeError(w, http.StatusTooManyRequests, "尝试次数过多，请稍后再试")
		return
	}
	if !s.needsSetup.Load() {
		writeError(w, http.StatusConflict, "服务器已经初始化，请直接登录")
		return
	}
	var req setupRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if !usernamePattern.MatchString(req.Username) {
		writeError(w, http.StatusBadRequest, "用户名需为 3-32 位字母、数字、点、下划线或连字符")
		return
	}
	if len(req.Password) < 8 {
		writeError(w, http.StatusBadRequest, "密码至少 8 位")
		return
	}
	if len(req.Password) > 200 {
		writeError(w, http.StatusBadRequest, "密码过长")
		return
	}
	hash, err := store.HashPassword(req.Password)
	if err != nil {
		s.log.Error("hash password", "err", err)
		writeError(w, http.StatusInternalServerError, "无法创建账号")
		return
	}
	user, err := s.store.CreateFirstUser(r.Context(), req.Username, hash)
	if err != nil {
		if errors.Is(err, store.ErrAlreadyInitialized) {
			s.needsSetup.Store(false)
			writeError(w, http.StatusConflict, "服务器已经初始化，请直接登录")
			return
		}
		s.log.Error("create first user", "err", err)
		writeError(w, http.StatusInternalServerError, "无法创建账号")
		return
	}
	expires := time.Now().Add(s.cfg.SessionTTL)
	token, err := store.NewToken(32)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "无法创建会话")
		return
	}
	if err := s.store.CreateSession(r.Context(), user.ID, store.TokenHash(token), expires, r.UserAgent()); err != nil {
		s.log.Error("create session", "err", err)
		writeError(w, http.StatusInternalServerError, "无法创建会话")
		return
	}
	s.needsSetup.Store(false)
	s.lim.success(ip)
	s.setSessionCookie(w, token, expires)
	s.log.Info("server initialized", "user", user.Username, "ip", ip)
	writeJSON(w, http.StatusOK, map[string]any{
		"user":    map[string]any{"id": user.ID, "username": user.Username},
		"expires": expires.UTC(),
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	token := s.requestToken(r)
	if token != "" {
		_ = s.store.DeleteSession(r.Context(), store.TokenHash(token))
	}
	s.clearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	user, _ := userFrom(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]any{"id": user.ID, "username": user.Username},
	})
}

// ---- instance API ----

type instanceView struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Hostname    string `json:"hostname"`
	OS          string `json:"os"`
	Arch        string `json:"arch"`
	DSHVersion  string `json:"dshVersion"`
	PluginVer   string `json:"pluginVersion"`
	Online      bool   `json:"online"`
	ConnectedAt string `json:"connectedAt,omitempty"`
	LastSeen    string `json:"lastSeen,omitempty"`
	URL         string `json:"url"`
}

func (s *Server) view(in store.Instance) instanceView {
	// An instance inside its reconnect window still counts as online: the
	// plugin is re-dialling, and showing it as offline would flap the list on
	// every gateway-forced reconnect.
	_, reconnecting := s.offlineTimers.Load(in.ID)
	online := s.hub.Online(in.ID) || reconnecting
	v := instanceView{
		ID: in.ID, Name: in.Name, Hostname: in.Hostname, OS: in.OS, Arch: in.Arch,
		DSHVersion: in.DSHVersion, PluginVer: in.PluginVer, Online: online,
		URL: "/i/" + in.ID + "/",
	}
	if !in.ConnectedAt.IsZero() {
		v.ConnectedAt = in.ConnectedAt.Format(time.RFC3339)
	}
	if !in.LastSeen.IsZero() {
		v.LastSeen = in.LastSeen.Format(time.RFC3339)
	}
	return v
}

func (s *Server) handleListInstances(w http.ResponseWriter, r *http.Request) {
	user, _ := userFrom(r)
	items, err := s.store.ListInstances(r.Context(), user.ID)
	if err != nil {
		s.log.Error("list instances", "err", err)
		writeError(w, http.StatusInternalServerError, "读取实例列表失败")
		return
	}
	views := make([]instanceView, 0, len(items))
	online := 0
	for _, in := range items {
		v := s.view(in)
		if v.Online {
			online++
		}
		views = append(views, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"instances": views,
		"total":     len(views),
		"online":    online,
	})
}

func (s *Server) handleGetInstance(w http.ResponseWriter, r *http.Request) {
	user, _ := userFrom(r)
	in, err := s.store.GetInstance(r.Context(), user.ID, r.PathValue("id"))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "实例不存在")
			return
		}
		writeError(w, http.StatusInternalServerError, "读取实例失败")
		return
	}
	writeJSON(w, http.StatusOK, s.view(in))
}

func (s *Server) handleDeleteInstance(w http.ResponseWriter, r *http.Request) {
	user, _ := userFrom(r)
	id := r.PathValue("id")
	if tun, ok := s.hub.Get(id); ok {
		if tun.UserID != user.ID {
			writeError(w, http.StatusNotFound, "实例不存在")
			return
		}
		tun.Close()
	}
	// The row is about to disappear, so no pending offline transition is needed.
	s.cancelOffline(id)
	if err := s.store.DeleteInstance(r.Context(), user.ID, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "实例不存在")
			return
		}
		writeError(w, http.StatusInternalServerError, "删除实例失败")
		return
	}
	s.bus.publish(event{Kind: "instances"})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// proxyErrorPage renders a small page inside the instance chrome when the
// instance cannot be reached at all.
func (s *Server) proxyErrorPage(w http.ResponseWriter, status int, title, detail string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>%s</title><link rel="stylesheet" href="/static/style.css">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml"></head>
<body class="embed-body"><div class="embed-error"><div class="embed-error-mark">!</div>
<h1>%s</h1><p>%s</p><a class="btn" href="/">返回实例列表</a></div></body></html>`, title, title, detail)
}

// ---- SSE ----

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	ch, cancel := s.bus.subscribe()
	defer cancel()
	fmt.Fprint(w, "event: ready\ndata: {}\n\n")
	flusher.Flush()

	keepalive := time.NewTicker(25 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-keepalive.C:
			fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		case ev, ok := <-ch:
			if !ok {
				return
			}
			body, _ := json.Marshal(ev)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Kind, body)
			flusher.Flush()
		}
	}
}

// ---- helpers ----

type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (w *statusWriter) WriteHeader(code int) {
	if !w.wroteHeader {
		w.status = code
		w.wroteHeader = true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if !w.wroteHeader {
		w.wroteHeader = true
	}
	return w.ResponseWriter.Write(b)
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap exposes the underlying writer to http.ResponseController.
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// ---- event bus ----

type event struct {
	Kind       string `json:"kind"`
	InstanceID string `json:"instanceId,omitempty"`
	Online     bool   `json:"online,omitempty"`
}

type broadcaster struct {
	m    sync.Mutex
	subs map[chan event]struct{}
}

func newBroadcaster() *broadcaster {
	return &broadcaster{subs: make(map[chan event]struct{})}
}

func (b *broadcaster) subscribe() (chan event, func()) {
	ch := make(chan event, 8)
	b.m.Lock()
	b.subs[ch] = struct{}{}
	b.m.Unlock()
	return ch, func() {
		b.m.Lock()
		if _, ok := b.subs[ch]; ok {
			delete(b.subs, ch)
			close(ch)
		}
		b.m.Unlock()
	}
}

func (b *broadcaster) publish(ev event) {
	b.m.Lock()
	defer b.m.Unlock()
	for ch := range b.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// ---- login rate limiting ----

type loginLimiter struct {
	m      sync.Mutex
	byIP   map[string]*attempt
	maxAge time.Duration
}

type attempt struct {
	count int
	until time.Time
}

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{byIP: make(map[string]*attempt), maxAge: 10 * time.Minute}
}

func (l *loginLimiter) blocked(ip string) time.Duration {
	l.m.Lock()
	defer l.m.Unlock()
	a, ok := l.byIP[ip]
	if !ok {
		return 0
	}
	if time.Now().After(a.until) {
		delete(l.byIP, ip)
		return 0
	}
	if a.count >= 8 {
		return time.Until(a.until)
	}
	return 0
}

func (l *loginLimiter) fail(ip string) {
	l.m.Lock()
	defer l.m.Unlock()
	a, ok := l.byIP[ip]
	if !ok || time.Now().After(a.until) {
		a = &attempt{}
		l.byIP[ip] = a
	}
	a.count++
	if a.count == 1 {
		a.until = time.Now().Add(l.maxAge)
	}
	if a.count >= 8 {
		a.until = time.Now().Add(5 * time.Minute)
	}
}

func (l *loginLimiter) success(ip string) {
	l.m.Lock()
	defer l.m.Unlock()
	delete(l.byIP, ip)
}

// renewSessions periodically drops expired rows.
func (s *Server) StartMaintenance(ctx context.Context) {
	go func() {
		t := time.NewTicker(30 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if err := s.store.PurgeExpiredSessions(ctx); err != nil {
					s.log.Warn("purge sessions", "err", err)
				}
			}
		}
	}()
}
