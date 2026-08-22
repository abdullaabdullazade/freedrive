package service

import "testing"

func TestValidateItemName(t *testing.T) {
	for _, good := range []string{"report.txt", "Məlumat 2026.xlsx", "archive.tar.gz"} {
		if err := ValidateItemName(good); err != nil {
			t.Errorf("rejected valid name %q: %v", good, err)
		}
	}
	for _, bad := range []string{"", " ", ".", "..", "../secret", `dir\\secret`, "C:secret", "CON", "nul.txt", "report. "} {
		if err := ValidateItemName(bad); err == nil {
			t.Errorf("accepted unsafe name %q", bad)
		}
	}
}
