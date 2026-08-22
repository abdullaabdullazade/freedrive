package config

import (
	"strings"
	"testing"
)

func TestLoadRejectsWeakJWTSecret(t *testing.T) {
	t.Setenv("FREEDRIVE_DATA_DIR", t.TempDir())
	t.Setenv("FREEDRIVE_JWT_SECRET", "too-short")

	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "at least 32") {
		t.Fatalf("expected weak JWT secret error, got %v", err)
	}
}

func TestLoadGeneratesStrongJWTSecret(t *testing.T) {
	t.Setenv("FREEDRIVE_DATA_DIR", t.TempDir())
	t.Setenv("FREEDRIVE_JWT_SECRET", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if len(cfg.JWTSecret) < 32 {
		t.Fatalf("generated JWT secret is too short: %d", len(cfg.JWTSecret))
	}
}
