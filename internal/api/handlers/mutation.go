package handlers

import (
	"context"
	"net/http"

	"github.com/abdullaabdullazade/freedrive/internal/api/middleware"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
)

func clientMutationID(r *http.Request) string {
	if id := r.Header.Get("X-Client-Mutation-Id"); id != "" {
		return id
	}
	return r.URL.Query().Get("client_mutation_id")
}

// acceptClientMutation records an idempotent mutation ID. Returns false when duplicate.
func acceptClientMutation(ctx context.Context, repo repository.ClientMutationRepository, r *http.Request) bool {
	mutationID := clientMutationID(r)
	if mutationID == "" || repo == nil {
		return true
	}
	userID := middleware.GetUserID(ctx)
	ok, err := repo.TryRecord(ctx, userID, mutationID)
	if err != nil {
		return true
	}
	return ok
}
