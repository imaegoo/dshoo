package tunnel

import (
	"bytes"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	frames := []Frame{
		{Type: FrameReqHead, ID: 1, Payload: []byte(`{"method":"GET"}`)},
		{Type: FrameResBody, ID: 900, Payload: bytes.Repeat([]byte{0x41}, 40_000)},
		{Type: FrameReqEnd, ID: 4_294_967_295},
	}
	for _, want := range frames {
		encoded := AppendFrame(nil, want)
		got, err := DecodeFrame(encoded)
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		if got.Type != want.Type || got.ID != want.ID {
			t.Fatalf("header mismatch: got type %d id %d, want type %d id %d",
				got.Type, got.ID, want.Type, want.ID)
		}
		if !bytes.Equal(got.Payload, want.Payload) {
			t.Fatalf("payload mismatch for id %d", want.ID)
		}
	}
}

func TestDecodeRejectsShortFrame(t *testing.T) {
	if _, err := DecodeFrame([]byte{1, 2, 3}); err == nil {
		t.Fatal("DecodeFrame accepted a frame shorter than its header")
	}
}

func TestAppendFrameIsAppendable(t *testing.T) {
	prefix := []byte("prefix")
	encoded := AppendFrame(prefix, Frame{Type: FrameResEnd, ID: 7})
	if string(encoded[:len(prefix)]) != "prefix" {
		t.Fatal("AppendFrame overwrote the destination buffer")
	}
	if len(encoded) != len(prefix)+HeaderSize {
		t.Fatalf("unexpected length %d", len(encoded))
	}
}

func TestHubReplaceClosesPrevious(t *testing.T) {
	hub := NewHub()
	first := &Tunnel{ID: "abc", streams: map[uint32]chan Frame{}, done: make(chan struct{})}
	second := &Tunnel{ID: "abc", streams: map[uint32]chan Frame{}, done: make(chan struct{})}

	if hub.Add(first) {
		t.Fatal("first registration reported a replacement")
	}
	if !hub.Add(second) {
		t.Fatal("second registration did not report a replacement")
	}
	select {
	case <-first.Done():
	default:
		t.Fatal("replaced tunnel was not closed")
	}
	if !hub.Online("abc") {
		t.Fatal("replacement tunnel is not registered")
	}
	hub.Remove(first)
	if !hub.Online("abc") {
		t.Fatal("removing a stale tunnel dropped the live one")
	}
	hub.Remove(second)
	if hub.Online("abc") {
		t.Fatal("instance still online after removal")
	}
}
