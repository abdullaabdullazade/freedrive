package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
)

// Config holds all application configuration.
type Config struct {
	Port           int
	DataDir        string
	JWTSecret      string
	MaxUploadBytes int64
	AdminEmail     string
	AdminPassword  string
}

// Load reads configuration from environment variables with sensible defaults.
func Load() (*Config, error) {
	cfg := &Config{
		Port:           getEnvInt("FREEDRIVE_PORT", 8080),
		DataDir:        getEnvStr("FREEDRIVE_DATA_DIR", "./data"),
		JWTSecret:      getEnvStr("FREEDRIVE_JWT_SECRET", ""),
		MaxUploadBytes: int64(getEnvInt("FREEDRIVE_MAX_UPLOAD_MB", 5120)) * 1024 * 1024,
		AdminEmail:     getEnvStr("FREEDRIVE_ADMIN_EMAIL", "admin@freedrive.local"),
		AdminPassword:  getEnvStr("FREEDRIVE_ADMIN_PASSWORD", ""),
	}

	// Auto-generate or load JWT secret if not provided via env
	if cfg.JWTSecret == "" {
		secretPath := cfg.DataDir + "/jwt_secret.key"
		if b, err := os.ReadFile(secretPath); err == nil && len(b) > 0 {
			cfg.JWTSecret = string(b)
		} else {
			// Generate and save
			secret, err := generateSecret(32)
			if err != nil {
				return nil, fmt.Errorf("failed to generate JWT secret: %w", err)
			}
			os.MkdirAll(cfg.DataDir, 0755)
			if err := os.WriteFile(secretPath, []byte(secret), 0600); err != nil {
				fmt.Printf("Warning: failed to save JWT secret to disk: %v\n", err)
			}
			cfg.JWTSecret = secret
		}
	}
	if cfg.JWTSecret == "gents-reorder-goldsmith-proton-siren-spout" {
		return nil, fmt.Errorf("FREEDRIVE_JWT_SECRET uses a publicly known example value; remove it to auto-generate a secret")
	}
	if len(cfg.JWTSecret) < 32 {
		return nil, fmt.Errorf("FREEDRIVE_JWT_SECRET must be at least 32 characters")
	}

	return cfg, nil
}

func generateSecret(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func getEnvStr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return fallback
}
