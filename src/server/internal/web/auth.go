package web

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"dshoo/internal/store"
)

// ctxKey is the private request-context key type.
type ctxKey int

const (
	ctxUser ctxKey = iota
	ctxSessionToken
)

// user/browser account attached to an authenticated request.
func userFrom(r *http.Request) (store.User, bool) {
	u, ok := r.Context().Value(ctxUser).(store.User)
	return u, ok
}

// sessionTokenFrom returns the raw bearer value, needed only for logout.
func sessionTokenFrom(r *http.Request) string {
	t, _ := r.Context().Value(ctxSessionToken).(string)
	return t
}

// requestToken extracts the session cookie.
func (s *Server) requestToken(r *http.Request) string {
	c, err := r.Cookie(s.cfg.CookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

// requireSession wraps a handler with session authentication. API callers get
// 401 JSON; browsers are redirected to the login page.
func (s *Server) requireSession(next http.HandlerFunc, jsonOnFailure bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := s.requestToken(r)
		if token == "" {
			if jsonOnFailure {
				writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
				return
			}
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
		user, expires, err := s.store.SessionUser(r.Context(), store.TokenHash(token))
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				s.clearSessionCookie(w)
			}
			if jsonOnFailure {
				writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
				return
			}
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
		if time.Until(expires) < 24*time.Hour {
			// Sliding renewal: the browser keeps its session while it is used.
			s.setSessionCookie(w, token, time.Now().Add(s.cfg.SessionTTL))
		}
		ctx := context.WithValue(r.Context(), ctxUser, user)
		ctx = context.WithValue(ctx, ctxSessionToken, token)
		next(w, r.WithContext(ctx))
	}
}

// sameSite guards state-changing API calls: browsers cannot set a custom
// header cross-origin without a preflight, which this server never grants.
func requireCustomHeader(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if r.Header.Get("X-Requested-With") != "dshoo" {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": "missing X-Requested-With"})
				return
			}
		}
		next(w, r)
	}
}

func (s *Server) setSessionCookie(w http.ResponseWriter, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     s.cfg.CookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.cfg.SecureCookie,
		SameSite: http.SameSiteLaxMode,
		Expires:  expires,
		MaxAge:   int(time.Until(expires).Seconds()),
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     s.cfg.CookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   s.cfg.SecureCookie,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}

// clientIP resolves the caller, honouring X-Forwarded-For only when the
// deployment declares a trusted proxy in front.
func (s *Server) clientIP(r *http.Request) string {
	if s.cfg.TrustProxy {
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			if i := strings.IndexByte(fwd, ','); i > 0 {
				return strings.TrimSpace(fwd[:i])
			}
			return strings.TrimSpace(fwd)
		}
	}
	host := r.RemoteAddr
	if i := strings.LastIndexByte(host, ':'); i > 0 {
		host = host[:i]
	}
	return strings.Trim(host, "[]")
}
