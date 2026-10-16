package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"mime"
	"net/http"
)

// writeJSON writes a JSON response.
func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// writeError writes a JSON error response.
func writeError(w http.ResponseWriter, message string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}

// attachmentDisposition builds a Content-Disposition value for a download.
// Non-ASCII names (for example Chinese) use RFC 5987 filename*, because raw
// UTF-8 header bytes are read as Latin-1 by browsers and fetch().
func attachmentDisposition(filename string) string {
	if value := mime.FormatMediaType("attachment", map[string]string{"filename": filename}); value != "" {
		return value
	}
	return "attachment"
}

// generateRandomString generates a random hex string.
func generateRandomString(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}
