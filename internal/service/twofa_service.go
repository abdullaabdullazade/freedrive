package service

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/adminsettings"
	"github.com/abdullaabdullazade/freedrive/internal/domain"
	"github.com/abdullaabdullazade/freedrive/internal/email"
	"github.com/pquerna/otp/totp"
	qrcode "github.com/skip2/go-qrcode"
	"golang.org/x/crypto/bcrypt"
)

var (
	ErrIPBlocked        = errors.New("access denied from this network")
	Err2FARequired      = errors.New("two-factor authentication required")
	Err2FAUnavailable   = errors.New("email two-factor authentication is unavailable")
	ErrInvalid2FACode   = errors.New("invalid or expired verification code")
	ErrCannotDisable2FA = errors.New("two-factor authentication is required by administrator")
	ErrTOTPAlreadyOn    = errors.New("authenticator app is already enabled")
	ErrTOTPNotEnabled   = errors.New("authenticator app is not enabled")
	ErrTOTPNotPending   = errors.New("authenticator setup has not been started")
	ErrInvalidTOTPCode  = errors.New("invalid authenticator code")
	ErrEnable2FAFirst   = errors.New("enable two-factor authentication in Security before signing in")
)

// TwoFAChallenge is returned when login requires a second factor.
type TwoFAChallenge struct {
	ChallengeID      string   `json:"challenge_id"`
	Method           string   `json:"method"`
	MethodsAvailable []string `json:"methods_available"`
	EmailMasked      string   `json:"email_masked,omitempty"`
}

// TotpSetupResult is returned when starting authenticator enrollment.
type TotpSetupResult struct {
	Secret     string `json:"secret"`
	OTPAuthURL string `json:"otpauth_url"`
	QR         string `json:"qr"`
}

// TotpConfirmResult is returned after confirming authenticator enrollment.
type TotpConfirmResult struct {
	BackupCodes []string `json:"backup_codes"`
}

// Needs2FA reports whether the user must complete 2FA at login.
func Needs2FA(user *domain.User) bool {
	if user == nil {
		return false
	}
	return adminsettings.Require2FA() || user.Email2FAEnabled || user.TotpEnabled
}

// HasConfigured2FA reports whether the user has at least one personal 2FA method.
func HasConfigured2FA(user *domain.User) bool {
	if user == nil {
		return false
	}
	return user.Email2FAEnabled || user.TotpEnabled
}

// CanSetEmail2FA reports whether a user may toggle their personal email 2FA setting.
func CanSetEmail2FA(user *domain.User, enabled bool) error {
	if enabled {
		return nil
	}
	if !adminsettings.Require2FA() {
		return nil
	}
	if user != nil && user.TotpEnabled {
		return nil
	}
	return ErrCannotDisable2FA
}

// CanDisableTOTP reports whether a user may disable authenticator 2FA.
func CanDisableTOTP(user *domain.User) error {
	if !adminsettings.Require2FA() {
		return nil
	}
	if user != nil && user.Email2FAEnabled {
		return nil
	}
	return ErrCannotDisable2FA
}

func availableLoginMethods(user *domain.User) []string {
	methods := make([]string, 0, 2)
	if user.TotpEnabled {
		methods = append(methods, domain.TwoFAMethodTOTP)
	}
	if user.Email2FAEnabled || (adminsettings.Require2FA() && adminsettings.SMTPConfigured()) {
		methods = append(methods, domain.TwoFAMethodEmail)
	}
	return methods
}

func emailMethodAvailable(user *domain.User) bool {
	if !adminsettings.SMTPConfigured() {
		return false
	}
	return user.Email2FAEnabled || adminsettings.Require2FA()
}

// VerifyCredentials checks email/password without issuing tokens.
func (s *AuthService) VerifyCredentials(ctx context.Context, email, password string) (*domain.User, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	user, err := s.userRepo.GetByEmail(ctx, email)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, ErrInvalidCredentials
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return nil, ErrInvalidCredentials
	}
	if user.Suspended {
		return nil, ErrAccountSuspended
	}
	return user, nil
}

// StartLogin2FA creates a login challenge, preferring TOTP when enabled.
func (s *AuthService) StartLogin2FA(ctx context.Context, user *domain.User) (*TwoFAChallenge, error) {
	if user == nil {
		return nil, ErrInvalidCredentials
	}

	methods := availableLoginMethods(user)
	if user.TotpEnabled {
		return s.createChallenge(ctx, user, domain.TwoFAMethodTOTP, "", methods)
	}

	if emailMethodAvailable(user) {
		return s.startEmailChallenge(ctx, user, methods)
	}

	if adminsettings.Require2FA() && !HasConfigured2FA(user) {
		if adminsettings.SMTPConfigured() {
			return s.startEmailChallenge(ctx, user, []string{domain.TwoFAMethodEmail})
		}
		return nil, ErrEnable2FAFirst
	}

	return nil, Err2FAUnavailable
}

// StartEmail2FA creates an email challenge (compat wrapper).
func (s *AuthService) StartEmail2FA(ctx context.Context, user *domain.User) (*TwoFAChallenge, error) {
	return s.StartLogin2FA(ctx, user)
}

func (s *AuthService) startEmailChallenge(ctx context.Context, user *domain.User, methods []string) (*TwoFAChallenge, error) {
	if !adminsettings.SMTPConfigured() {
		return nil, Err2FAUnavailable
	}
	code, err := randomDigits(6)
	if err != nil {
		return nil, err
	}
	challenge, err := s.createChallenge(ctx, user, domain.TwoFAMethodEmail, hash2FACode(code), methods)
	if err != nil {
		return nil, err
	}
	s.sendSignInCodeEmail(user, code)
	return challenge, nil
}

func (s *AuthService) createChallenge(ctx context.Context, user *domain.User, method, codeHash string, methods []string) (*TwoFAChallenge, error) {
	_ = s.email2faRepo.DeleteByUserID(ctx, user.ID)
	challenge := &domain.Email2FAChallenge{
		UserID:    user.ID,
		Method:    method,
		CodeHash:  codeHash,
		ExpiresAt: time.Now().Add(10 * time.Minute),
	}
	if err := s.email2faRepo.Create(ctx, challenge); err != nil {
		return nil, err
	}
	out := &TwoFAChallenge{
		ChallengeID:      challenge.ID,
		Method:           method,
		MethodsAvailable: methods,
	}
	if containsMethod(methods, domain.TwoFAMethodEmail) || method == domain.TwoFAMethodEmail {
		out.EmailMasked = maskAuthEmail(user.Email)
	}
	return out, nil
}

func (s *AuthService) sendSignInCodeEmail(user *domain.User, code string) {
	subject := "Your FreeDrive sign-in code"
	body := fmt.Sprintf(
		"Hello %s,\n\nYour FreeDrive sign-in verification code is:\n\n%s\n\nThis code expires in 10 minutes. If you did not try to sign in, change your password immediately.\n",
		chooseAuthDisplayName(user.Username, user.Email),
		code,
	)
	go func() {
		_ = email.SendFromSettings(user.Email, subject, body)
	}()
}

// SendEmail2FAFallback switches an existing challenge to email and sends a code.
func (s *AuthService) SendEmail2FAFallback(ctx context.Context, challengeID string) (*TwoFAChallenge, error) {
	challengeID = strings.TrimSpace(challengeID)
	if challengeID == "" {
		return nil, ErrInvalid2FACode
	}
	entry, err := s.email2faRepo.GetByID(ctx, challengeID)
	if err != nil || entry == nil {
		return nil, ErrInvalid2FACode
	}
	if time.Now().After(entry.ExpiresAt) {
		_ = s.email2faRepo.DeleteByID(ctx, entry.ID)
		return nil, ErrInvalid2FACode
	}

	user, err := s.userRepo.GetByID(ctx, entry.UserID)
	if err != nil || user == nil {
		return nil, ErrInvalid2FACode
	}
	if user.Suspended {
		return nil, ErrAccountSuspended
	}
	if !emailMethodAvailable(user) {
		return nil, Err2FAUnavailable
	}

	code, err := randomDigits(6)
	if err != nil {
		return nil, err
	}
	entry.Method = domain.TwoFAMethodEmail
	entry.CodeHash = hash2FACode(code)
	entry.ExpiresAt = time.Now().Add(10 * time.Minute)
	if err := s.email2faRepo.Update(ctx, entry); err != nil {
		return nil, err
	}
	s.sendSignInCodeEmail(user, code)

	methods := availableLoginMethods(user)
	if !containsMethod(methods, domain.TwoFAMethodEmail) {
		methods = append(methods, domain.TwoFAMethodEmail)
	}
	return &TwoFAChallenge{
		ChallengeID:      entry.ID,
		Method:           domain.TwoFAMethodEmail,
		MethodsAvailable: methods,
		EmailMasked:      maskAuthEmail(user.Email),
	}, nil
}

// VerifyEmail2FA validates a challenge code (email, TOTP, or backup) and issues tokens.
func (s *AuthService) VerifyEmail2FA(ctx context.Context, challengeID, code string, device DeviceInfo) (*TokenPair, *domain.User, error) {
	challengeID = strings.TrimSpace(challengeID)
	code = strings.TrimSpace(code)
	if challengeID == "" || code == "" {
		return nil, nil, ErrInvalid2FACode
	}

	entry, err := s.email2faRepo.GetByID(ctx, challengeID)
	if err != nil || entry == nil {
		return nil, nil, ErrInvalid2FACode
	}
	if time.Now().After(entry.ExpiresAt) {
		_ = s.email2faRepo.DeleteByID(ctx, entry.ID)
		return nil, nil, ErrInvalid2FACode
	}

	user, err := s.userRepo.GetByID(ctx, entry.UserID)
	if err != nil || user == nil {
		return nil, nil, ErrInvalid2FACode
	}
	if user.Suspended {
		return nil, nil, ErrAccountSuspended
	}

	method := entry.Method
	if method == "" {
		method = domain.TwoFAMethodEmail
	}

	switch method {
	case domain.TwoFAMethodEmail:
		if entry.CodeHash != hash2FACode(code) {
			return nil, nil, ErrInvalid2FACode
		}
	case domain.TwoFAMethodTOTP:
		ok, err := s.verifyTOTPOrBackup(ctx, user, code)
		if err != nil {
			return nil, nil, err
		}
		if !ok {
			return nil, nil, ErrInvalid2FACode
		}
	default:
		return nil, nil, ErrInvalid2FACode
	}

	_ = s.email2faRepo.DeleteByID(ctx, entry.ID)
	tokens, err := s.IssueTokens(ctx, user, device)
	if err != nil {
		return nil, nil, err
	}
	return tokens, user, nil
}

func (s *AuthService) verifyTOTPOrBackup(ctx context.Context, user *domain.User, code string) (bool, error) {
	code = strings.TrimSpace(code)
	if user.TotpEnabled && user.TotpSecret != "" {
		secret, err := s.decryptTOTPSecret(user.TotpSecret)
		if err == nil && totp.Validate(code, secret) {
			return true, nil
		}
	}
	normalized := normalizeBackupCode(code)
	if normalized == "" {
		return false, nil
	}
	return s.totpBackupRepo.ConsumeUnused(ctx, user.ID, hash2FACode(normalized))
}

// SetupTOTP starts authenticator enrollment and returns secret + QR.
func (s *AuthService) SetupTOTP(ctx context.Context, userID string) (*TotpSetupResult, error) {
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil || user == nil {
		return nil, ErrInvalidCredentials
	}
	if user.TotpEnabled {
		return nil, ErrTOTPAlreadyOn
	}

	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      "FreeDrive",
		AccountName: user.Email,
	})
	if err != nil {
		return nil, err
	}

	enc, err := s.encryptTOTPSecret(key.Secret())
	if err != nil {
		return nil, err
	}
	user.TotpSecret = enc
	user.TotpEnabled = false
	user.TotpEnrolledAt = nil
	if err := s.userRepo.Update(ctx, user); err != nil {
		return nil, err
	}

	png, err := qrcode.Encode(key.URL(), qrcode.Medium, 256)
	if err != nil {
		return nil, err
	}
	return &TotpSetupResult{
		Secret:     key.Secret(),
		OTPAuthURL: key.URL(),
		QR:         "data:image/png;base64," + base64.StdEncoding.EncodeToString(png),
	}, nil
}

// ConfirmTOTP verifies a code from the authenticator and enables TOTP.
func (s *AuthService) ConfirmTOTP(ctx context.Context, userID, code string) (*TotpConfirmResult, error) {
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil || user == nil {
		return nil, ErrInvalidCredentials
	}
	if user.TotpEnabled {
		return nil, ErrTOTPAlreadyOn
	}
	if strings.TrimSpace(user.TotpSecret) == "" {
		return nil, ErrTOTPNotPending
	}

	secret, err := s.decryptTOTPSecret(user.TotpSecret)
	if err != nil {
		return nil, err
	}
	if !totp.Validate(strings.TrimSpace(code), secret) {
		return nil, ErrInvalidTOTPCode
	}

	plainCodes, hashes, err := generateBackupCodes(8)
	if err != nil {
		return nil, err
	}
	if err := s.totpBackupRepo.ReplaceAll(ctx, user.ID, hashes); err != nil {
		return nil, err
	}

	now := time.Now()
	user.TotpEnabled = true
	user.TotpEnrolledAt = &now
	if err := s.userRepo.Update(ctx, user); err != nil {
		return nil, err
	}
	return &TotpConfirmResult{BackupCodes: plainCodes}, nil
}

// DisableTOTP turns off authenticator 2FA after verifying a code or password.
func (s *AuthService) DisableTOTP(ctx context.Context, userID, code, password string) error {
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil || user == nil {
		return ErrInvalidCredentials
	}
	if !user.TotpEnabled {
		return ErrTOTPNotEnabled
	}
	if err := CanDisableTOTP(user); err != nil {
		return err
	}

	ok := false
	if strings.TrimSpace(code) != "" {
		ok, err = s.verifyTOTPOrBackup(ctx, user, code)
		if err != nil {
			return err
		}
	}
	if !ok && strings.TrimSpace(password) != "" {
		if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err == nil {
			ok = true
		}
	}
	if !ok {
		return ErrInvalidTOTPCode
	}

	user.TotpEnabled = false
	user.TotpSecret = ""
	user.TotpEnrolledAt = nil
	if err := s.userRepo.Update(ctx, user); err != nil {
		return err
	}
	_ = s.totpBackupRepo.DeleteByUserID(ctx, user.ID)
	return nil
}

func (s *AuthService) encryptTOTPSecret(plain string) (string, error) {
	key := sha256.Sum256(s.jwtSecret)
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nonce, nonce, []byte(plain), nil)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

func (s *AuthService) decryptTOTPSecret(enc string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", err
	}
	key := sha256.Sum256(s.jwtSecret)
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", errors.New("invalid totp secret")
	}
	nonce, ciphertext := raw[:gcm.NonceSize()], raw[gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func generateBackupCodes(n int) ([]string, []string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	codes := make([]string, 0, n)
	hashes := make([]string, 0, n)
	for i := 0; i < n; i++ {
		var b strings.Builder
		for j := 0; j < 8; j++ {
			v, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
			if err != nil {
				return nil, nil, err
			}
			b.WriteByte(alphabet[v.Int64()])
		}
		code := b.String()
		codes = append(codes, code)
		hashes = append(hashes, hash2FACode(normalizeBackupCode(code)))
	}
	return codes, hashes, nil
}

func normalizeBackupCode(code string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	code = strings.ReplaceAll(code, "-", "")
	code = strings.ReplaceAll(code, " ", "")
	return code
}

func containsMethod(methods []string, method string) bool {
	for _, m := range methods {
		if m == method {
			return true
		}
	}
	return false
}

func hash2FACode(code string) string {
	h := sha256.Sum256([]byte(code))
	return hex.EncodeToString(h[:])
}

func randomDigits(n int) (string, error) {
	out := make([]byte, n)
	for i := 0; i < n; i++ {
		v, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return "", err
		}
		out[i] = byte('0' + v.Int64())
	}
	return string(out), nil
}

func maskAuthEmail(addr string) string {
	addr = strings.TrimSpace(strings.ToLower(addr))
	parts := strings.Split(addr, "@")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "***"
	}
	if len(parts[0]) == 1 {
		return "*@" + parts[1]
	}
	return parts[0][:1] + "***@" + parts[1]
}

func chooseAuthDisplayName(username, email string) string {
	if strings.TrimSpace(username) != "" {
		return username
	}
	return email
}
