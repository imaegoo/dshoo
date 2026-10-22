package tunnel

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// Frame types carried over the tunnel WebSocket.
//
// Control messages (hello, ping) travel as WebSocket text frames holding JSON.
// Everything else is a binary frame with a 5-byte header: type, then a
// big-endian stream id, then the payload. One stream id spans the whole life
// of one proxied HTTP request or one proxied WebSocket.
const (
	FrameReqHead  byte = 1 // JSON request head: method, path, headers
	FrameReqBody  byte = 2 // request body bytes
	FrameReqEnd   byte = 3 // request body finished
	FrameResHead  byte = 4 // JSON response head: status, headers
	FrameResBody  byte = 5 // response body bytes
	FrameResEnd   byte = 6 // response finished
	FrameWSOpen   byte = 7 // JSON: open a WebSocket upstream for this stream
	FrameWSText   byte = 8 // WebSocket text message
	FrameWSBinary byte = 9 // WebSocket binary message
	FrameWSClose  byte = 10
	FrameError    byte = 11 // JSON: stream aborted, message in payload
)

// HeaderSize is the fixed length of every binary frame header.
const HeaderSize = 5

// ErrShortFrame reports a frame that ended before its declared payload.
var ErrShortFrame = errors.New("tunnel: short frame")

// Frame is one decoded tunnel frame. Payload aliases the source buffer.
type Frame struct {
	Type    byte
	ID      uint32
	Payload []byte
}

// AppendFrame encodes f into dst (appending) and returns the extended slice.
func AppendFrame(dst []byte, f Frame) []byte {
	var hdr [HeaderSize]byte
	hdr[0] = f.Type
	binary.BigEndian.PutUint32(hdr[1:], f.ID)
	dst = append(dst, hdr[:]...)
	return append(dst, f.Payload...)
}

// DecodeFrame splits one binary frame. The returned payload aliases b.
func DecodeFrame(b []byte) (Frame, error) {
	if len(b) < HeaderSize {
		return Frame{}, ErrShortFrame
	}
	return Frame{
		Type:    b[0],
		ID:      binary.BigEndian.Uint32(b[1:HeaderSize]),
		Payload: b[HeaderSize:],
	}, nil
}

// HelloMeta is what a plugin reports about the machine it runs on.
type HelloMeta struct {
	Key        string `json:"key"`
	Name       string `json:"name"`
	Hostname   string `json:"hostname"`
	OS         string `json:"os"`
	Arch       string `json:"arch"`
	DSHVersion string `json:"dshVersion"`
	PID        int    `json:"pid"`
	GUIPort    int    `json:"guiPort"`
	PluginVer  string `json:"pluginVersion"`
}

// HelloAck is the server's answer to a plugin hello.
type HelloAck struct {
	Type       string `json:"type"`
	InstanceID string `json:"instanceId"`
	Prefix     string `json:"prefix"`
	ServerTime int64  `json:"serverTime"`
}

// Head is the JSON body of FrameReqHead.
type Head struct {
	Method  string              `json:"method"`
	Path    string              `json:"path"`
	Headers map[string][]string `json:"headers"`
}

// ResHead is the JSON body of FrameResHead.
type ResHead struct {
	Status  int                 `json:"status"`
	Headers map[string][]string `json:"headers"`
}

// WSOpen asks the plugin to dial one upstream WebSocket.
type WSOpen struct {
	Path     string              `json:"path"`
	Headers  map[string][]string `json:"headers"`
	Protocol []string            `json:"protocol,omitempty"`
}

// WSError is the JSON body of FrameError.
type WSError struct {
	Message string `json:"message"`
}

func (f Frame) String() string {
	return fmt.Sprintf("frame{type:%d id:%d len:%d}", f.Type, f.ID, len(f.Payload))
}
