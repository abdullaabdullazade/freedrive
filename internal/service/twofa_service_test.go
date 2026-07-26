package service_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/adminsettings"
	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/service"
	"github.com/pquerna/otp/totp"
)

func withRequire2FA(t *testing.T, enabled bool) {
	t.Helper()
	dir := t.TempDir()
	adminsettings.SetDataDir(dir)
	data := map[string]interface{}{
		"security": map[string]interface{}{
			"require_2fa": enabled,
		},
	}
	bytes, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), bytes, 0644); err != nil {
		t.Fatalf("write settings: %v", err)
	}
}

func TestNeeds2FACombinations(t *testing.T) {
	withRequire2FA(t, false)
	u := &domain.User{}
	if service.Needs2FA(u) {
		t.Fatal("expected no 2FA")
	}
	u.Email2FAEnabled = true
	if !service.Needs2FA(u) {
		t.Fatal("expected email 2FA")
	}
	u.Email2FAEnabled = false
	u.TotpEnabled = true
	if !service.Needs2FA(u) {
		t.Fatal("expected totp 2FA")
	}

	withRequire2FA(t, true)
	u = &domain.User{}
	if !service.Needs2FA(u) {
		t.Fatal("expected require_2fa")
	}
}

func TestTOTPConfirmVerifyAndBackupSingleUse(t *testing.T) {
	withRequire2FA(t, false)
	auth, userRepo, db := newTestAuth(t)
	defer db.Close()
	user := createTestUser(t, userRepo, "u-totp-1", "totp@example.com")
	ctx := context.Background()

	setup, err := auth.SetupTOTP(ctx, user.ID)
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if setup.Secret == "" || setup.QR == "" || setup.OTPAuthURL == "" {
		t.Fatal("expected setup payload")
	}

	code, err := totp.GenerateCode(setup.Secret, time.Now())
	if err != nil {
		t.Fatalf("generate code: %v", err)
	}
	confirm, err := auth.ConfirmTOTP(ctx, user.ID, code)
	if err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if len(confirm.BackupCodes) != 8 {
		t.Fatalf("expected 8 backup codes, got %d", len(confirm.BackupCodes))
	}

	reloaded, err := userRepo.GetByID(ctx, user.ID)
	if err != nil || reloaded == nil || !reloaded.TotpEnabled {
		t.Fatal("expected totp enabled")
	}

	challenge, err := auth.StartLogin2FA(ctx, reloaded)
	if err != nil {
		t.Fatalf("start login 2fa: %v", err)
	}
	if challenge.Method != domain.TwoFAMethodTOTP {
		t.Fatalf("expected totp method, got %s", challenge.Method)
	}

	loginCode, err := totp.GenerateCode(setup.Secret, time.Now())
	if err != nil {
		t.Fatalf("login code: %v", err)
	}
	tokens, _, err := auth.VerifyEmail2FA(ctx, challenge.ChallengeID, loginCode, service.DeviceInfo{DeviceType: "web"})
	if err != nil || tokens == nil {
		t.Fatalf("verify totp: %v", err)
	}

	challenge2, err := auth.StartLogin2FA(ctx, reloaded)
	if err != nil {
		t.Fatalf("start login 2fa 2: %v", err)
	}
	backup := confirm.BackupCodes[0]
	tokens2, _, err := auth.VerifyEmail2FA(ctx, challenge2.ChallengeID, backup, service.DeviceInfo{DeviceType: "web"})
	if err != nil || tokens2 == nil {
		t.Fatalf("verify backup: %v", err)
	}

	challenge3, err := auth.StartLogin2FA(ctx, reloaded)
	if err != nil {
		t.Fatalf("start login 2fa 3: %v", err)
	}
	if _, _, err := auth.VerifyEmail2FA(ctx, challenge3.ChallengeID, backup, service.DeviceInfo{DeviceType: "web"}); err != service.ErrInvalid2FACode {
		t.Fatalf("expected used backup to fail, got %v", err)
	}
}

func TestTOTPWindowSkew(t *testing.T) {
	withRequire2FA(t, false)
	auth, userRepo, db := newTestAuth(t)
	defer db.Close()
	user := createTestUser(t, userRepo, "u-totp-2", "totp2@example.com")
	ctx := context.Background()

	setup, err := auth.SetupTOTP(ctx, user.ID)
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	code, err := totp.GenerateCode(setup.Secret, time.Now())
	if err != nil {
		t.Fatalf("code: %v", err)
	}
	if _, err := auth.ConfirmTOTP(ctx, user.ID, code); err != nil {
		t.Fatalf("confirm: %v", err)
	}
	reloaded, _ := userRepo.GetByID(ctx, user.ID)
	challenge, err := auth.StartLogin2FA(ctx, reloaded)
	if err != nil {
		t.Fatalf("challenge: %v", err)
	}

	prev := time.Now().Add(-30 * time.Second)
	prevCode, err := totp.GenerateCode(setup.Secret, prev)
	if err != nil {
		t.Fatalf("prev code: %v", err)
	}
	if _, _, err := auth.VerifyEmail2FA(ctx, challenge.ChallengeID, prevCode, service.DeviceInfo{DeviceType: "web"}); err != nil {
		t.Fatalf("expected previous period code to validate: %v", err)
	}
}

func TestHasConfigured2FA(t *testing.T) {
	if service.HasConfigured2FA(&domain.User{}) {
		t.Fatal("expected false")
	}
	if !service.HasConfigured2FA(&domain.User{Email2FAEnabled: true}) {
		t.Fatal("expected email")
	}
	if !service.HasConfigured2FA(&domain.User{TotpEnabled: true}) {
		t.Fatal("expected totp")
	}
}
