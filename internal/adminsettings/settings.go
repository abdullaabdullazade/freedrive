package adminsettings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

var settingsFile = "data/settings.json"

// SetDataDir points settings reads at dataDir/settings.json (call from main).
func SetDataDir(dataDir string) {
	if strings.TrimSpace(dataDir) != "" {
		settingsFile = filepath.Join(dataDir, "settings.json")
	}
}

func load() map[string]interface{} {
	out := map[string]interface{}{}
	if err := os.MkdirAll(filepath.Dir(settingsFile), 0755); err != nil {
		return out
	}
	bytes, err := os.ReadFile(settingsFile)
	if err != nil {
		return out
	}
	_ = json.Unmarshal(bytes, &out)
	return out
}

func general(data map[string]interface{}) map[string]interface{} {
	g, _ := data["general"].(map[string]interface{})
	if g == nil {
		return map[string]interface{}{}
	}
	return g
}

func storage(data map[string]interface{}) map[string]interface{} {
	s, _ := data["storage"].(map[string]interface{})
	if s == nil {
		return map[string]interface{}{}
	}
	return s
}

func asString(v interface{}) string {
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t)
	case float64:
		return strconv.FormatInt(int64(t), 10)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	default:
		return ""
	}
}

func asInt(v interface{}, fallback int) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case int64:
		return int(t)
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(t)); err == nil {
			return n
		}
	}
	return fallback
}

// RegistrationMode returns open, invite, or closed (default invite).
func RegistrationMode() string {
	mode := strings.ToLower(asString(general(load())["registration"]))
	switch mode {
	case "open", "closed":
		return mode
	default:
		return "invite"
	}
}

// DefaultQuotaBytes returns the configured default user quota.
func DefaultQuotaBytes() int64 {
	gb := asInt(general(load())["default_quota_gb"], 10)
	if gb <= 0 {
		gb = 10
	}
	return int64(gb) * 1024 * 1024 * 1024
}

// MaxUploadMB returns admin max upload size in megabytes (0 if unset).
func MaxUploadMB() int {
	return asInt(general(load())["max_upload_mb"], 0)
}

// AllowedTypesUnlimited returns true when the admin disabled the extension whitelist.
func AllowedTypesUnlimited() bool {
	return asBool(general(load())["allowed_types_unlimited"], false)
}

// AllowedTypes returns lowercase file extensions without dots.
func AllowedTypes() []string {
	raw, ok := general(load())["allowed_types"].([]interface{})
	if !ok || len(raw) == 0 {
		return nil
	}
	out := make([]string, 0, len(raw))
	seen := map[string]bool{}
	for _, item := range raw {
		ext := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(asString(item)), "."))
		if ext == "" || seen[ext] {
			continue
		}
		seen[ext] = true
		out = append(out, ext)
	}
	return out
}

// TrashAutoEmptyDays returns retention days; 0 means never auto-empty.
func TrashAutoEmptyDays() int {
	v := strings.ToLower(asString(storage(load())["trash_auto_empty"]))
	if v == "" || v == "never" {
		return 0
	}
	return asInt(v, 30)
}

// EffectiveMaxUploadBytes picks the larger of config limit and admin setting.
func EffectiveMaxUploadBytes(configLimit int64) int64 {
	mb := MaxUploadMB()
	if mb <= 0 {
		return configLimit
	}
	setting := int64(mb) * 1024 * 1024
	if setting > configLimit {
		return setting
	}
	return configLimit
}

// SMTPConfig holds outbound mail settings from admin settings.
type SMTPConfig struct {
	Server      string
	Port        int
	User        string
	Pass        string
	FromAddress string
	FromName    string
	TLS         bool
}

// SMTP returns configured SMTP settings (empty if unset).
func SMTP() SMTPConfig {
	emailCfg := email(load())
	return SMTPConfig{
		Server:      asString(emailCfg["smtp_server"]),
		Port:        asInt(emailCfg["smtp_port"], 0),
		User:        asString(emailCfg["smtp_user"]),
		Pass:        asString(emailCfg["smtp_pass"]),
		FromAddress: asString(emailCfg["from_address"]),
		FromName:    asString(emailCfg["from_name"]),
		TLS:         asBool(emailCfg["tls"], false),
	}
}

func email(data map[string]interface{}) map[string]interface{} {
	e, _ := data["email"].(map[string]interface{})
	if e == nil {
		return map[string]interface{}{}
	}
	return e
}

func asBool(v interface{}, fallback bool) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		s := strings.ToLower(strings.TrimSpace(x))
		return s == "1" || s == "true" || s == "yes" || s == "on"
	default:
		return fallback
	}
}

// SiteURL returns configured site URL from general settings.
func SiteURL() string {
	return strings.TrimSpace(asString(general(load())["site_url"]))
}
