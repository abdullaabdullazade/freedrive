package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
)

const expoPushURL = "https://exp.host/--/api/v2/push/send"

// ExpoPushService sends Expo push notifications.
type ExpoPushService struct {
	httpClient *http.Client
	tokenRepo  repository.PushTokenRepository
}

func NewExpoPushService(tokenRepo repository.PushTokenRepository) *ExpoPushService {
	return &ExpoPushService{
		httpClient: &http.Client{Timeout: 15 * time.Second},
		tokenRepo:  tokenRepo,
	}
}

type expoPushMessage struct {
	To    string                 `json:"to"`
	Title string                 `json:"title"`
	Body  string                 `json:"body"`
	Sound string                 `json:"sound,omitempty"`
	Data  map[string]interface{} `json:"data,omitempty"`
}

// SendLoginApproval notifies all registered devices for the user (English copy).
func (s *ExpoPushService) SendLoginApproval(ctx context.Context, userID, challengeID, deviceName, ip string) error {
	tokens, err := s.tokenRepo.ListByUser(ctx, userID)
	if err != nil {
		return err
	}
	if len(tokens) == 0 {
		return nil
	}
	body := "Someone is trying to sign in"
	if deviceName != "" {
		body = fmt.Sprintf("Sign-in attempt from %s", deviceName)
	}
	if ip != "" {
		body += fmt.Sprintf(" (%s)", ip)
	}
	body += ". Tap to approve or deny."

	msgs := make([]expoPushMessage, 0, len(tokens))
	for _, t := range tokens {
		if t.ExpoPushToken == "" {
			continue
		}
		msgs = append(msgs, expoPushMessage{
			To:    t.ExpoPushToken,
			Title: "Is this you signing in?",
			Body:  body,
			Sound: "default",
			Data: map[string]interface{}{
				"type":         "login_approval",
				"challenge_id": challengeID,
			},
		})
	}
	if len(msgs) == 0 {
		return nil
	}
	payload, err := json.Marshal(msgs)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, expoPushURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("expo push status %d", resp.StatusCode)
	}
	return nil
}

// HasPushTokens reports whether the user has at least one registered token.
func (s *ExpoPushService) HasPushTokens(ctx context.Context, userID string) (bool, error) {
	tokens, err := s.tokenRepo.ListByUser(ctx, userID)
	if err != nil {
		return false, err
	}
	for _, t := range tokens {
		if t.ExpoPushToken != "" {
			return true, nil
		}
	}
	return false, nil
}
