package service

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// ValidateItemName enforces a portable single-component file/folder name.
// This protects every client, including Windows sync clients, from traversal,
// alternate data streams, reserved device names, and ambiguous trailing chars.
func ValidateItemName(name string) error {
	if name == "" || strings.TrimSpace(name) == "" || name == "." || name == ".." {
		return fmt.Errorf("invalid item name")
	}
	if !utf8.ValidString(name) || len([]byte(name)) > 255 || strings.HasSuffix(name, " ") || strings.HasSuffix(name, ".") {
		return fmt.Errorf("invalid item name")
	}
	if strings.ContainsAny(name, `<>:"/\|?*`) {
		return fmt.Errorf("invalid item name")
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("invalid item name")
		}
	}
	stem := strings.ToUpper(strings.SplitN(name, ".", 2)[0])
	if stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" || isNumberedDevice(stem, "COM") || isNumberedDevice(stem, "LPT") {
		return fmt.Errorf("invalid item name")
	}
	return nil
}

func isNumberedDevice(name, prefix string) bool {
	return len(name) == 4 && strings.HasPrefix(name, prefix) && name[3] >= '1' && name[3] <= '9'
}
