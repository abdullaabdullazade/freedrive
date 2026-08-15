package handlers

import (
	"net/http"
	"strings"
	"unicode"

	"github.com/abdullaabdullazade/freedrive/internal/api/middleware"
	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/service"
)

const maxDeviceIDLen = 64

// deviceInfoFromRequest builds DeviceInfo from headers / User-Agent.
func deviceInfoFromRequest(r *http.Request) service.DeviceInfo {
	ua := r.UserAgent()
	deviceType := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Device-Type")))
	deviceName := strings.TrimSpace(r.Header.Get("X-Device-Name"))
	deviceID := sanitizeDeviceID(r.Header.Get("X-Device-ID"))

	if deviceType == domain.DeviceTypeDesktop {
		if deviceName == "" {
			deviceName = "Desktop app"
		}
		return service.DeviceInfo{
			DeviceID:   deviceID,
			DeviceName: deviceName,
			DeviceType: domain.DeviceTypeDesktop,
			UserAgent:  ua,
			IPAddress:  middleware.ClientIP(r),
		}
	}

	if deviceType == domain.DeviceTypeMobile {
		if deviceName == "" {
			deviceName = "Mobile app"
		}
		return service.DeviceInfo{
			DeviceID:   deviceID,
			DeviceName: deviceName,
			DeviceType: domain.DeviceTypeMobile,
			UserAgent:  ua,
			IPAddress:  middleware.ClientIP(r),
		}
	}

	if deviceName == "" {
		deviceName = describeUserAgent(ua)
	}
	return service.DeviceInfo{
		DeviceID:   deviceID,
		DeviceName: deviceName,
		DeviceType: domain.DeviceTypeWeb,
		UserAgent:  ua,
		IPAddress:  middleware.ClientIP(r),
	}
}

func sanitizeDeviceID(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(raw))
	for _, r := range raw {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	out := b.String()
	if len(out) > maxDeviceIDLen {
		out = out[:maxDeviceIDLen]
	}
	return out
}

func describeUserAgent(ua string) string {
	uaLower := strings.ToLower(ua)
	browser := "Browser"
	switch {
	case strings.Contains(uaLower, "edg/"):
		browser = "Edge"
	case strings.Contains(uaLower, "chrome/") && !strings.Contains(uaLower, "edg/"):
		browser = "Chrome"
	case strings.Contains(uaLower, "firefox/"):
		browser = "Firefox"
	case strings.Contains(uaLower, "safari/") && !strings.Contains(uaLower, "chrome/"):
		browser = "Safari"
	case strings.Contains(uaLower, "opr/") || strings.Contains(uaLower, "opera"):
		browser = "Opera"
	}

	osName := "Unknown OS"
	switch {
	case strings.Contains(uaLower, "windows"):
		osName = "Windows"
	case strings.Contains(uaLower, "mac os") || strings.Contains(uaLower, "macintosh"):
		osName = "macOS"
	case strings.Contains(uaLower, "android"):
		osName = "Android"
	case strings.Contains(uaLower, "iphone") || strings.Contains(uaLower, "ipad"):
		osName = "iOS"
	case strings.Contains(uaLower, "linux"):
		osName = "Linux"
	}

	return browser + " on " + osName
}
