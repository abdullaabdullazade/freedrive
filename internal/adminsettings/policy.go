package adminsettings

import (
	"net"
	"strings"
)

func security(data map[string]interface{}) map[string]interface{} {
	s, _ := data["security"].(map[string]interface{})
	if s == nil {
		return map[string]interface{}{}
	}
	return s
}

func backup(data map[string]interface{}) map[string]interface{} {
	b, _ := data["backup"].(map[string]interface{})
	if b == nil {
		return map[string]interface{}{}
	}
	return b
}

func securityIPList(key string) []string {
	raw, ok := security(load())[key].([]interface{})
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	seen := map[string]bool{}
	for _, item := range raw {
		m, _ := item.(map[string]interface{})
		ip := strings.TrimSpace(asString(m["ip"]))
		if ip == "" || seen[ip] {
			continue
		}
		seen[ip] = true
		out = append(out, ip)
	}
	return out
}

// SecurityBlocklist returns blocked IP addresses from admin settings.
func SecurityBlocklist() []string {
	return securityIPList("blocklist")
}

// SecurityAllowlist returns allowed IP addresses when allowlist mode is active.
func SecurityAllowlist() []string {
	return securityIPList("allowlist")
}

// Require2FA returns true when admin forces 2FA (authenticator or email) for all users.
func Require2FA() bool {
	return asBool(security(load())["require_2fa"], false)
}

// IsIPAllowed applies blocklist/allowlist rules from admin settings.
func IsIPAllowed(ip string) bool {
	ip = normalizeIP(ip)
	if ip == "" {
		return true
	}
	if isLoopback(ip) {
		return true
	}
	for _, blocked := range SecurityBlocklist() {
		if ipMatches(ip, blocked) {
			return false
		}
	}
	allowlist := SecurityAllowlist()
	if len(allowlist) > 0 {
		for _, allowed := range allowlist {
			if ipMatches(ip, allowed) {
				return true
			}
		}
		return false
	}
	return true
}

func normalizeIP(ip string) string {
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return ""
	}
	host := ip
	if strings.Contains(ip, ":") {
		if h, _, err := net.SplitHostPort(ip); err == nil {
			host = h
		}
	}
	host = strings.Trim(host, "[]")
	return host
}

func isLoopback(ip string) bool {
	return ip == "127.0.0.1" || ip == "::1" || ip == "localhost"
}

func ipMatches(clientIP, rule string) bool {
	rule = normalizeIP(rule)
	if rule == "" {
		return false
	}
	if strings.Contains(rule, "/") {
		_, network, err := net.ParseCIDR(rule)
		if err != nil {
			return clientIP == rule
		}
		return network.Contains(net.ParseIP(clientIP))
	}
	return clientIP == rule
}

// VersioningEnabled returns whether file versioning is enabled.
func VersioningEnabled() bool {
	return asBool(storage(load())["versioning"], true)
}

// KeepVersions returns how many versions to retain per file (minimum 1 when versioning on).
func KeepVersions() int {
	n := asInt(storage(load())["keep_versions"], 20)
	if n < 1 {
		return 1
	}
	return n
}

// TotalCapacityBytes returns server-wide storage cap from settings (0 = unlimited).
func TotalCapacityBytes() int64 {
	gb := asInt(storage(load())["total_capacity_gb"], 0)
	if gb <= 0 {
		return 0
	}
	return int64(gb) * 1024 * 1024 * 1024
}

// BackupAutoEnabled returns whether scheduled settings backup is enabled.
func BackupAutoEnabled() bool {
	return asBool(backup(load())["auto_backup"], false)
}

// BackupSchedule returns daily, weekly, or monthly.
func BackupSchedule() string {
	s := strings.ToLower(asString(backup(load())["schedule"]))
	switch s {
	case "weekly", "monthly":
		return s
	default:
		return "daily"
	}
}

// BackupTime returns configured backup time as HH:MM (24h).
func BackupTime() string {
	t := asString(backup(load())["time"])
	if t == "" {
		return "03:00"
	}
	return t
}

// BackupLocation returns backup directory path.
func BackupLocation() string {
	loc := asString(backup(load())["location"])
	if loc == "" {
		return "/var/lib/freedrive/backups"
	}
	return loc
}

// SMTPConfigured reports whether outbound email can be sent.
func SMTPConfigured() bool {
	cfg := SMTP()
	return cfg.Server != "" && cfg.Port > 0 && cfg.FromAddress != ""
}
