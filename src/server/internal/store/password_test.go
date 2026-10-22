package store

import (
	"strings"
	"testing"
)

func TestPasswordRoundTrip(t *testing.T) {
	encoded, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if !strings.HasPrefix(encoded, "pbkdf2-sha256$") {
		t.Fatalf("unexpected encoding: %q", encoded)
	}
	if err := VerifyPassword(encoded, "correct horse battery staple"); err != nil {
		t.Fatalf("verify correct password: %v", err)
	}
	if err := VerifyPassword(encoded, "wrong password"); err == nil {
		t.Fatal("verify accepted a wrong password")
	}
}

func TestPasswordSaltsDiffer(t *testing.T) {
	first, err := HashPassword("same")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	second, err := HashPassword("same")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if first == second {
		t.Fatal("two hashes of the same password are identical; the salt is not random")
	}
}

func TestVerifyRejectsBrokenEncodings(t *testing.T) {
	cases := []string{
		"",
		"plaintext",
		"pbkdf2-sha256$abc$c2FsdA$Zm9v",
		"pbkdf2-sha256$1000$not-base64$Zm9v",
		"scrypt$1$c2FsdA$Zm9v",
	}
	for _, encoded := range cases {
		if err := VerifyPassword(encoded, "anything"); err == nil {
			t.Fatalf("VerifyPassword accepted %q", encoded)
		}
	}
}

func TestTokenHashIsStable(t *testing.T) {
	if TokenHash("abc") != TokenHash("abc") {
		t.Fatal("token hash is not deterministic")
	}
	if TokenHash("abc") == TokenHash("abd") {
		t.Fatal("token hash collided for different inputs")
	}
}
