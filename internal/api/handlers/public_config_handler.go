package handlers

import (
	"net/http"

	"github.com/abdullaabdullazade/freedrive/internal/adminsettings"
)

// PublicConfig exposes only the default UI language; no private admin settings.
func PublicConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{"language": adminsettings.DefaultLanguage()})
}
