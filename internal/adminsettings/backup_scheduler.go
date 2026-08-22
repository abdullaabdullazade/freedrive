package adminsettings

import (
	"context"
	"encoding/json"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"time"
)

// RunSettingsBackup writes a settings snapshot JSON to the configured backup location.
func RunSettingsBackup() (string, error) {
	location := BackupLocation()
	if err := os.MkdirAll(location, 0755); err != nil {
		return "", err
	}

	data := load()
	now := time.Now()
	fileName := "freedrive-backup-" + now.Format("20060102-150405") + ".json"
	fullPath := filepath.Join(location, fileName)
	payload := map[string]interface{}{
		"created_at": now.UTC().Format(time.RFC3339),
		"kind":       "settings_snapshot",
		"settings":   data,
	}
	bytes, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(fullPath, bytes, fs.FileMode(0644)); err != nil {
		return "", err
	}
	return fullPath, nil
}

// StartBackupScheduler runs scheduled settings backups when enabled in admin settings.
func StartBackupScheduler(ctx context.Context) {
	var lastRunKey string
	go func() {
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				if !BackupAutoEnabled() {
					continue
				}
				if !backupDue(now) {
					continue
				}
				key := now.Format("2006-01-02-15:04")
				if key == lastRunKey {
					continue
				}
				path, err := RunSettingsBackup()
				if err != nil {
					log.Printf("scheduled settings backup failed: %v", err)
					continue
				}
				lastRunKey = key
				log.Printf("scheduled settings backup written: %s", path)
			}
		}
	}()
}

func backupDue(now time.Time) bool {
	cfgTime := BackupTime()
	parts := splitTime(cfgTime)
	if len(parts) != 2 {
		return false
	}
	if now.Hour() != parts[0] || now.Minute() != parts[1] {
		return false
	}
	switch BackupSchedule() {
	case "weekly":
		return now.Weekday() == time.Monday
	case "monthly":
		return now.Day() == 1
	default:
		return true
	}
}

func splitTime(value string) [2]int {
	var h, m int
	for i, ch := range value {
		if ch == ':' {
			h = atoi(value[:i])
			m = atoi(value[i+1:])
			break
		}
	}
	return [2]int{h, m}
}

func atoi(s string) int {
	n := 0
	for _, ch := range s {
		if ch < '0' || ch > '9' {
			continue
		}
		n = n*10 + int(ch-'0')
	}
	return n
}
