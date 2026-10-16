package handlers

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/abdullaabdullazade/freedrive/internal/adminsettings"
)

func TestPublicConfigOnlyExposesLanguage(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"general":{"language":"zh-CN","site_name":"Private"},"email":{"smtp_pass":"private-setting"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	adminsettings.SetDataDir(dir)
	t.Cleanup(func() { adminsettings.SetDataDir("data") })
	response := httptest.NewRecorder()
	PublicConfig(response, httptest.NewRequest("GET", "/api/v1/public/config", nil))
	if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("unexpected response: %d %v", response.Code, response.Header())
	}
	var body map[string]interface{}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body) != 1 || body["language"] != "zh-CN" {
		t.Fatalf("unexpected public fields: %v", body)
	}
}
