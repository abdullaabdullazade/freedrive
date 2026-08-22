package adminsettings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func withSettingsFile(t *testing.T, data map[string]interface{}) {
	t.Helper()
	dir := t.TempDir()
	SetDataDir(dir)
	bytes, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, bytes, 0644); err != nil {
		t.Fatalf("write settings: %v", err)
	}
}

func TestAllowedTypesUnlimited_DefaultFalse(t *testing.T) {
	withSettingsFile(t, map[string]interface{}{
		"general": map[string]interface{}{
			"allowed_types": []string{"pdf", "png"},
		},
	})
	if AllowedTypesUnlimited() {
		t.Fatal("expected false when allowed_types_unlimited is missing")
	}
}

func TestAllowedTypesUnlimited_TrueWhenSet(t *testing.T) {
	withSettingsFile(t, map[string]interface{}{
		"general": map[string]interface{}{
			"allowed_types_unlimited": true,
			"allowed_types":           []string{"pdf"},
		},
	})
	if !AllowedTypesUnlimited() {
		t.Fatal("expected true when allowed_types_unlimited is true")
	}
}
