package adminsettings

import "testing"

func TestDefaultLanguage(t *testing.T) {
	previous := settingsFile
	t.Cleanup(func() { settingsFile = previous })
	for _, tt := range []struct{ input, want string }{
		{"", "en"}, {"en", "en"}, {"zh-CN", "zh-CN"}, {"zh_cn", "zh-CN"},
		{"zh", "zh-CN"}, {"zh-Hans", "zh-CN"}, {"zh-Hans-CN", "zh-CN"},
		{"az", "az"}, {"tr", "tr"}, {"de", "de"}, {"unknown", "en"},
	} {
		t.Run(tt.input, func(t *testing.T) {
			withSettingsFile(t, map[string]interface{}{"general": map[string]interface{}{"language": tt.input}})
			if got := DefaultLanguage(); got != tt.want {
				t.Fatalf("DefaultLanguage() = %q, want %q", got, tt.want)
			}
		})
	}
}
