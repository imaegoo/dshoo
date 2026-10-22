package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the complete server configuration, read from the environment so the
// container image needs no config file.
type Config struct {
	Addr         string
	DataDir      string
	SessionTTL   time.Duration
	CookieName   string
	SecureCookie bool
	PublicURL    string
	TrustProxy   bool
}

// Load reads the environment, applying defaults for anything unset.
//
// There is no bootstrap account: the first browser visit creates the account
// through the setup page, so a fresh deployment never ships with known
// credentials.
func Load() Config {
	c := Config{
		Addr:       env("DSHOO_ADDR", ":9830"),
		DataDir:    env("DSHOO_DATA", "./data"),
		SessionTTL: time.Duration(envInt("DSHOO_SESSION_DAYS", 7)) * 24 * time.Hour,
		CookieName: "dshoo_session",
		PublicURL:  strings.TrimRight(os.Getenv("DSHOO_PUBLIC_URL"), "/"),
	}
	// A cookie marked Secure is dropped by the browser on plain HTTP, so the
	// default follows the deployment: HTTPS deployments set DSHOO_PUBLIC_URL.
	c.SecureCookie = envBool("DSHOO_SECURE_COOKIE", strings.HasPrefix(c.PublicURL, "https://"))
	c.TrustProxy = envBool("DSHOO_TRUST_PROXY", false)
	return c
}

func env(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}

func envInt(name string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

func envBool(name string, fallback bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(name)))
	switch v {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}
