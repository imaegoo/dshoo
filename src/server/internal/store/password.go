package store

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Password storage uses PBKDF2-HMAC-SHA256 in the self-describing form
// "pbkdf2-sha256$<iterations>$<salt-b64>$<hash-b64>" so the cost can be raised
// later without invalidating existing rows.

const (
	pbkdf2Iterations = 210_000
	pbkdf2KeyLen     = 32
	pbkdf2SaltLen    = 16
	pbkdf2Scheme     = "pbkdf2-sha256"
)

// ErrBadPassword reports a credential that does not match.
var ErrBadPassword = errors.New("store: password mismatch")

// HashPassword derives a storable verifier for plain.
func HashPassword(plain string) (string, error) {
	salt := make([]byte, pbkdf2SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := pbkdf2SHA256([]byte(plain), salt, pbkdf2Iterations, pbkdf2KeyLen)
	return fmt.Sprintf("%s$%d$%s$%s",
		pbkdf2Scheme,
		pbkdf2Iterations,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// VerifyPassword checks plain against a stored verifier.
func VerifyPassword(encoded, plain string) error {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != pbkdf2Scheme {
		return errors.New("store: unsupported password encoding")
	}
	iterations, err := strconv.Atoi(parts[1])
	if err != nil || iterations <= 0 {
		return errors.New("store: invalid password iterations")
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil {
		return errors.New("store: invalid password salt")
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return errors.New("store: invalid password hash")
	}
	got := pbkdf2SHA256([]byte(plain), salt, iterations, len(want))
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return ErrBadPassword
	}
	return nil
}

// pbkdf2SHA256 is PBKDF2 (RFC 8018) with HMAC-SHA256 as the PRF.
func pbkdf2SHA256(password, salt []byte, iterations, keyLen int) []byte {
	hashLen := sha256.Size
	blocks := (keyLen + hashLen - 1) / hashLen
	out := make([]byte, 0, blocks*hashLen)
	prf := hmac.New(sha256.New, password)
	var counter [4]byte
	for block := 1; block <= blocks; block++ {
		prf.Reset()
		prf.Write(salt)
		binary.BigEndian.PutUint32(counter[:], uint32(block))
		prf.Write(counter[:])
		u := prf.Sum(nil)
		t := make([]byte, len(u))
		copy(t, u)
		for i := 1; i < iterations; i++ {
			prf.Reset()
			prf.Write(u)
			u = prf.Sum(u[:0])
			for j := range t {
				t[j] ^= u[j]
			}
		}
		out = append(out, t...)
	}
	return out[:keyLen]
}

// NewToken mints a URL-safe random secret.
func NewToken(bytesLen int) (string, error) {
	buf := make([]byte, bytesLen)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// TokenHash is what the database stores instead of a bearer token.
func TokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
