package web

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/coder/websocket"

	"dshoo/internal/store"
	"dshoo/internal/tunnel"
)

// hopHeaders are connection-scoped and must not be forwarded through the tunnel.
var hopHeaders = map[string]bool{
	"connection":          true,
	"keep-alive":          true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"te":                  true,
	"trailer":             true,
	"transfer-encoding":   true,
	"upgrade":             true,
	"host":                true,
	"cookie":              true,
	"authorization":       true,
}

// filterRequestHeaders copies headers worth relaying to the instance. Cookies
// and credentials are dropped: the plugin authenticates to its own harness
// with a session it mints locally.
func filterRequestHeaders(h http.Header) map[string][]string {
	out := make(map[string][]string, len(h))
	for k, v := range h {
		if hopHeaders[strings.ToLower(k)] {
			continue
		}
		out[k] = append([]string(nil), v...)
	}
	// The instance is served under a prefix; tell it so, in case a plugin
	// inside the instance wants to build absolute URLs.
	return out
}

func filterResponseHeaders(h map[string][]string, prefix string) http.Header {
	out := make(http.Header, len(h))
	for k, v := range h {
		lower := strings.ToLower(k)
		if hopHeaders[lower] || lower == "set-cookie" {
			continue
		}
		out[k] = append([]string(nil), v...)
	}
	// A root-absolute redirect from the instance must stay inside the prefix.
	if loc := out.Get("Location"); strings.HasPrefix(loc, "/") && !strings.HasPrefix(loc, "//") {
		out.Set("Location", prefix+loc)
	}
	return out
}

// splitInstancePath turns "/i/<id>/rest" into its id and remaining path. The
// remaining path is "" when the request has no trailing slash.
func splitInstancePath(p string) (id, rest string) {
	p = strings.TrimPrefix(p, "/i/")
	if i := strings.IndexByte(p, '/'); i >= 0 {
		return p[:i], p[i:]
	}
	return p, ""
}

// handleProxy forwards one browser request to the instance's harness and
// streams the answer back.
func (s *Server) handleProxy(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r)
	if !ok {
		s.proxyErrorPage(w, http.StatusUnauthorized, "需要登录", "请重新登录后再打开实例。")
		return
	}
	id, rest := splitInstancePath(r.URL.Path)
	if id == "" {
		s.proxyErrorPage(w, http.StatusNotFound, "实例不存在", "地址不完整。")
		return
	}
	if _, err := s.store.GetInstance(r.Context(), user.ID, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			s.proxyErrorPage(w, http.StatusNotFound, "实例不存在", "这个实例已被删除，或者不属于当前账号。")
			return
		}
		s.proxyErrorPage(w, http.StatusInternalServerError, "读取实例失败", "服务器内部错误，请查看服务端日志。")
		return
	}
	if rest == "" {
		target := "/i/" + id + "/"
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusSeeOther)
		return
	}
	tun, live := s.hub.Get(id)
	if !live {
		s.proxyErrorPage(w, http.StatusBadGateway, "实例当前离线",
			"在设备上打开 DeepSeek Harness 的「设置 → 远程访问」，点击连接后刷新这个页面。")
		return
	}
	if r.URL.RawQuery != "" {
		rest += "?" + r.URL.RawQuery
	}
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		s.proxyWebsocket(w, r, tun, rest)
		return
	}
	s.proxyHTTP(w, r, tun, rest, "/i/"+id)
}

func (s *Server) proxyHTTP(w http.ResponseWriter, r *http.Request, tun *tunnel.Tunnel, rest, prefix string) {
	streamID, frames, release := tun.OpenStream()
	defer release()

	head := tunnel.Head{
		Method:  r.Method,
		Path:    rest,
		Headers: filterRequestHeaders(r.Header),
	}
	body, err := json.Marshal(head)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "encode request")
		return
	}
	if err := tun.Send(tunnel.Frame{Type: tunnel.FrameReqHead, ID: streamID, Payload: body}); err != nil {
		s.proxyErrorPage(w, http.StatusBadGateway, "实例连接已断开", "隧道写入失败，请稍后重试。")
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go s.pumpRequestBody(ctx, r, tun, streamID)

	var (
		started  bool
		finished bool
	)
	for {
		select {
		case <-ctx.Done():
			if !finished {
				// Tell the instance to abandon the upstream request.
				_ = tun.Send(tunnel.Frame{Type: tunnel.FrameError, ID: streamID,
					Payload: []byte(`{"message":"client disconnected"}`)})
			}
			return
		case f, ok := <-frames:
			if !ok {
				if !started {
					s.proxyErrorPage(w, http.StatusBadGateway, "实例连接已断开", "隧道已关闭，请确认设备上的连接状态。")
				}
				return
			}
			switch f.Type {
			case tunnel.FrameResHead:
				var rh tunnel.ResHead
				if err := json.Unmarshal(f.Payload, &rh); err != nil {
					s.proxyErrorPage(w, http.StatusBadGateway, "实例响应异常", "无法解析实例返回的响应头。")
					return
				}
				hdr := filterResponseHeaders(rh.Headers, prefix)
				copyHeaders(w.Header(), hdr)
				// The proxied app is same-origin; forbid it from framing us and
				// from being cached as HTML.
				w.Header().Set("X-Content-Type-Options", "nosniff")
				status := rh.Status
				if status == 0 {
					status = http.StatusOK
				}
				w.WriteHeader(status)
				started = true
				flush(w)
			case tunnel.FrameResBody:
				if !started {
					// A body before a head is a protocol violation; drop it.
					continue
				}
				if _, err := w.Write(f.Payload); err != nil {
					cancel()
					return
				}
				if len(f.Payload) > 0 {
					flush(w)
				}
			case tunnel.FrameResEnd:
				finished = true
				return
			case tunnel.FrameError:
				msg := "实例返回错误"
				var we tunnel.WSError
				if json.Unmarshal(f.Payload, &we) == nil && we.Message != "" {
					msg = we.Message
				}
				if !started {
					s.proxyErrorPage(w, http.StatusBadGateway, "实例返回错误", msg)
				}
				return
			}
		}
	}
}

// pumpRequestBody streams the browser's request body into tunnel frames.
func (s *Server) pumpRequestBody(ctx context.Context, r *http.Request, tun *tunnel.Tunnel, streamID uint32) {
	if r.Body == nil {
		_ = tun.Send(tunnel.Frame{Type: tunnel.FrameReqEnd, ID: streamID})
		return
	}
	buf := make([]byte, 32*1024)
	for {
		if ctx.Err() != nil {
			_ = tun.Send(tunnel.Frame{Type: tunnel.FrameReqEnd, ID: streamID})
			return
		}
		n, err := r.Body.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			if sendErr := tun.Send(tunnel.Frame{Type: tunnel.FrameReqBody, ID: streamID, Payload: chunk}); sendErr != nil {
				return
			}
		}
		if err != nil {
			_ = tun.Send(tunnel.Frame{Type: tunnel.FrameReqEnd, ID: streamID})
			return
		}
	}
}

// requestedSubprotocols reads the browser's Sec-WebSocket-Protocol offer.
func requestedSubprotocols(r *http.Request) []string {
	raw := r.Header.Get("Sec-WebSocket-Protocol")
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// proxyWebsocket relays one browser WebSocket to the instance over the tunnel.
func (s *Server) proxyWebsocket(w http.ResponseWriter, r *http.Request, tun *tunnel.Tunnel, rest string) {
	subprotocols := requestedSubprotocols(r)
	opts := &websocket.AcceptOptions{
		OriginPatterns:  []string{"*"},
		CompressionMode: websocket.CompressionDisabled,
	}
	if len(subprotocols) > 0 {
		opts.Subprotocols = subprotocols[:1]
	}
	conn, err := websocket.Accept(w, r, opts)
	if err != nil {
		s.log.Warn("websocket accept", "instance", tun.ID, "err", err)
		return
	}
	// Session traffic can carry attachment and paste payloads far above the
	// 32 KB default the library applies.
	conn.SetReadLimit(64 << 20)
	defer conn.CloseNow()

	streamID, frames, release := tun.OpenStream()
	defer release()

	open := tunnel.WSOpen{Path: rest, Headers: filterRequestHeaders(r.Header), Protocol: subprotocols}
	payload, _ := json.Marshal(open)
	if err := tun.Send(tunnel.Frame{Type: tunnel.FrameWSOpen, ID: streamID, Payload: payload}); err != nil {
		_ = conn.Close(websocket.StatusInternalError, "tunnel closed")
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	go func() {
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				_ = tun.Send(tunnel.Frame{Type: tunnel.FrameWSClose, ID: streamID,
					Payload: []byte(`{"code":1000,"reason":""}`)})
				return
			}
			frameType := tunnel.FrameWSText
			if typ == websocket.MessageBinary {
				frameType = tunnel.FrameWSBinary
			}
			if sendErr := tun.Send(tunnel.Frame{Type: frameType, ID: streamID, Payload: data}); sendErr != nil {
				return
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case f, ok := <-frames:
			if !ok {
				return
			}
			switch f.Type {
			case tunnel.FrameWSText:
				if err := conn.Write(ctx, websocket.MessageText, f.Payload); err != nil {
					return
				}
			case tunnel.FrameWSBinary:
				if err := conn.Write(ctx, websocket.MessageBinary, f.Payload); err != nil {
					return
				}
			case tunnel.FrameWSClose:
				code := websocket.StatusNormalClosure
				var body struct {
					Code int `json:"code"`
				}
				if json.Unmarshal(f.Payload, &body) == nil && body.Code >= 1000 && body.Code <= 4999 {
					code = websocket.StatusCode(body.Code)
				}
				_ = conn.Close(code, "")
				return
			case tunnel.FrameError:
				_ = conn.Close(websocket.StatusInternalError, "upstream error")
				return
			}
		}
	}
}

func copyHeaders(dst, src http.Header) {
	for k, v := range src {
		for _, value := range v {
			dst.Add(k, value)
		}
	}
}

func flush(w http.ResponseWriter) {
	_ = http.NewResponseController(w).Flush()
}
