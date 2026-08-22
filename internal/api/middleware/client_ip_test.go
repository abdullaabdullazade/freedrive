package middleware

import (
	"net/http/httptest"
	"testing"
)

func TestClientIPIgnoresForwardingHeadersFromUntrustedPeer(t *testing.T) {
	t.Setenv("FREEDRIVE_TRUSTED_PROXIES", "")
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "203.0.113.10:4567"
	r.Header.Set("X-Forwarded-For", "198.51.100.8")
	if got := ClientIP(r); got != "203.0.113.10" {
		t.Fatalf("ClientIP = %q", got)
	}
}

func TestClientIPAcceptsForwardingHeadersFromTrustedPeer(t *testing.T) {
	t.Setenv("FREEDRIVE_TRUSTED_PROXIES", "127.0.0.1,10.0.0.0/8")
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "127.0.0.1:4567"
	r.Header.Set("X-Forwarded-For", "198.51.100.8, 10.0.0.4")
	if got := ClientIP(r); got != "198.51.100.8" {
		t.Fatalf("ClientIP = %q", got)
	}
}
