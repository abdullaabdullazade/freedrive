package email

import (
	"bytes"
	"io"
	"mime"
	"mime/quotedprintable"
	"net/mail"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/abdullaabdullazade/freedrive/internal/adminsettings"
)

func withSiteLanguage(t *testing.T, language string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"general":{"language":"`+language+`"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	adminsettings.SetDataDir(dir)
	t.Cleanup(func() { adminsettings.SetDataDir("data") })
}

var verbPattern = regexp.MustCompile(`%(?:\[(\d+)\])?[-+# 0]*\d*(?:\.\d+)?[a-zA-Z%]`)

// verbs lists each argument's verb in argument order, resolving %[n] indexes.
func verbs(format string) []string {
	byArg := map[int]string{}
	next := 1
	for _, match := range verbPattern.FindAllStringSubmatch(format, -1) {
		if strings.HasSuffix(match[0], "%") {
			continue
		}
		arg := next
		if match[1] != "" {
			arg = int(match[1][0] - '0')
		}
		byArg[arg] = match[0][len(match[0])-1:]
		next = arg + 1
	}
	out := make([]string, len(byArg))
	for i := range out {
		out[i] = byArg[i+1]
	}
	return out
}

func TestTranslationsKeepFormatVerbs(t *testing.T) {
	for key, value := range zhCN {
		if got, want := strings.Join(verbs(value), ","), strings.Join(verbs(key), ","); got != want {
			t.Errorf("%q: verbs %q, want %q", key, got, want)
		}
	}
}

func TestEnglishSitesKeepSourceText(t *testing.T) {
	withSiteLanguage(t, "en")
	for key := range zhCN {
		if got := T(key); got != key {
			t.Fatalf("T(%q) = %q on an English site", key, got)
		}
	}
	if got := Role("guest"); got != "GUEST" {
		t.Fatalf("Role(guest) = %q", got)
	}
	if got := DeviceName("Chrome on Linux"); got != "Chrome on Linux" {
		t.Fatalf("DeviceName = %q", got)
	}
}

func TestChineseSitesTranslateServerMessages(t *testing.T) {
	withSiteLanguage(t, "zh_CN")
	if got := T("Your FreeDrive sign-in code"); got != "你的 FreeDrive 登录验证码" {
		t.Fatalf("subject = %q", got)
	}
	if got := Role(" admin "); got != "管理员" {
		t.Fatalf("Role(admin) = %q", got)
	}
	for name, want := range map[string]string{
		"Chrome on Linux":        "Linux 上的 Chrome",
		"Browser on Unknown OS":  "未知系统 上的 浏览器",
		"Desktop app":            "桌面应用",
		"Alice's MacBook":        "Alice's MacBook",
		"Chrome on Linux (beta)": "Chrome on Linux (beta)",
	} {
		if got := DeviceName(name); got != want {
			t.Errorf("DeviceName(%q) = %q, want %q", name, got, want)
		}
	}
	if got := T("unknown message"); got != "unknown message" {
		t.Fatalf("untranslated messages must pass through, got %q", got)
	}
}

func TestBuildMessageEncodesNonASCIIHeadersAndBody(t *testing.T) {
	subject := "你的 FreeDrive 登录验证码"
	body := "你好：\n\n验证码：123456\n" + strings.Repeat("长", 120) + "\n"
	raw := buildMessage("noreply@example.com", "FreeDrive 网盘", "user@example.com", subject, body)
	message, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	for _, header := range []string{"Subject", "From"} {
		for _, c := range message.Header.Get(header) {
			if c > 127 {
				t.Fatalf("%s header is not ASCII: %q", header, message.Header.Get(header))
			}
		}
	}
	decoder := new(mime.WordDecoder)
	if got, err := decoder.DecodeHeader(message.Header.Get("Subject")); err != nil || got != subject {
		t.Fatalf("subject decoded to %q (%v)", got, err)
	}
	from, err := message.Header.AddressList("From")
	if err != nil || from[0].Name != "FreeDrive 网盘" || from[0].Address != "noreply@example.com" {
		t.Fatalf("from = %v (%v)", from, err)
	}
	if message.Header.Get("Content-Transfer-Encoding") != "quoted-printable" {
		t.Fatalf("missing transfer encoding")
	}
	decoded, err := io.ReadAll(quotedprintable.NewReader(message.Body))
	// Line breaks are sent as CRLF, as required by RFC 5322.
	if err != nil || string(decoded) != strings.ReplaceAll(body, "\n", "\r\n") {
		t.Fatalf("body decoded to %q (%v)", decoded, err)
	}
	for _, line := range strings.Split(string(raw), "\r\n") {
		if len(line) > 998 {
			t.Fatalf("line exceeds SMTP limit: %d", len(line))
		}
	}
}
