package middleware

import (
	"net"
	"net/http"
	"os"
	"strings"
)

// ClientIP returns the direct peer unless that peer is explicitly configured as
// a trusted proxy. Untrusted clients cannot spoof forwarding headers.
func ClientIP(r *http.Request) string {
	peer := stripPort(r.RemoteAddr)
	if peer == "" || !isTrustedProxy(peer) {
		return peer
	}

	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		parts := strings.Split(xff, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			candidate := stripPort(parts[i])
			if net.ParseIP(candidate) == nil {
				continue
			}
			if !isTrustedProxy(candidate) {
				return candidate
			}
		}
	}
	if xri := stripPort(r.Header.Get("X-Real-IP")); net.ParseIP(xri) != nil {
		return xri
	}
	return peer
}

func isTrustedProxy(ip string) bool {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return false
	}
	for _, raw := range strings.Split(os.Getenv("FREEDRIVE_TRUSTED_PROXIES"), ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		if candidate := net.ParseIP(raw); candidate != nil && candidate.Equal(parsed) {
			return true
		}
		if _, network, err := net.ParseCIDR(raw); err == nil && network.Contains(parsed) {
			return true
		}
	}
	return false
}

func stripPort(addr string) string {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return ""
	}
	host := addr
	if strings.Contains(addr, ":") {
		if h, _, err := net.SplitHostPort(addr); err == nil {
			host = h
		}
	}
	return strings.Trim(host, "[]")
}
