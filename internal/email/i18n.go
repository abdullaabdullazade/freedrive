package email

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/abdullaabdullazade/freedrive/internal/adminsettings"
)

// Server-generated messages (emails, push notifications) follow the site
// language chosen in Admin → Settings → General. Like the web catalog, the
// English source text is the key, so English output never changes. Every
// translation must keep the fmt verbs of its key in the same order.
var zhCN = map[string]string{
	// Sign-in code
	"Your FreeDrive sign-in code": "你的 FreeDrive 登录验证码",
	"Hello %s,\n\nYour FreeDrive sign-in verification code is:\n\n%s\n\nThis code expires in 10 minutes. If you did not try to sign in, change your password immediately.\n": "%s，你好：\n\n你的 FreeDrive 登录验证码是：\n\n%s\n\n验证码将在 10 分钟后失效。如果不是你本人在尝试登录，请立即修改密码。\n",

	// Email change
	"Confirm your new FreeDrive email": "确认你的 FreeDrive 新邮箱",
	"Hello %s,\n\nYou requested to change your FreeDrive account email to this address.\n\nConfirm your new email:\n%s\n\nThis link expires in 24 hours. If you did not request this change, ignore this email.\n": "%s，你好：\n\n你申请将 FreeDrive 账号邮箱更改为此地址。\n\n请点击以下链接确认新邮箱：\n%s\n\n链接将在 24 小时后失效。如果你没有申请此更改，请忽略此邮件。\n",
	"FreeDrive email change requested": "FreeDrive 邮箱更改申请",
	"Hello %s,\n\nA request was made to change your FreeDrive account email to %s.\n\nIf this was not you, contact your administrator immediately.\n": "%s，你好：\n\n有人申请将你的 FreeDrive 账号邮箱更改为 %s。\n\n如果这不是你本人的操作，请立即联系管理员。\n",

	// Two-factor reminder
	"Enable two-factor authentication on FreeDrive": "请在 FreeDrive 上启用双重验证",
	"Hello %s,\n\nYour FreeDrive administrator recommends enabling two-factor authentication for your account (authenticator app or email codes).\n\nSign in to FreeDrive, open Security from your profile menu, and set up an authenticator app or turn on email two-factor authentication.\n": "%s，你好：\n\n你的 FreeDrive 管理员建议你为账号启用双重验证（身份验证器应用或邮箱验证码）。\n\n请登录 FreeDrive，从个人资料菜单打开“安全”，设置身份验证器应用或开启邮箱双重验证。\n",

	// Invites
	"You're invited to FreeDrive":    "邀请你加入 FreeDrive",
	"FreeDrive Invite Link (Resent)": "FreeDrive 邀请链接（重新发送）",
	"Hello %s,\n\nYou've been invited to join FreeDrive.\n\nInvite link:\n%s\n\nSign in email (required): %s\nRole: %s\nQuota: %.1f GB\n":      "%s，你好：\n\n你已受邀加入 FreeDrive。\n\n邀请链接：\n%s\n\n登录邮箱（必填）：%s\n角色：%s\n存储配额：%.1f GB\n",
	"Hello %s,\n\nYour FreeDrive invite link has been resent.\n\nInvite link:\n%s\n\nSign in email (required): %s\nRole: %s\nQuota: %.1f GB\n": "%s，你好：\n\n你的 FreeDrive 邀请链接已重新发送。\n\n邀请链接：\n%s\n\n登录邮箱（必填）：%s\n角色：%s\n存储配额：%.1f GB\n",
	"\nMessage from admin:\n%s\n": "\n管理员留言：\n%s\n",
	"\nUse the email address above when creating your account and when signing in.\nIf the link does not open automatically, copy and paste it into your browser.\n": "\n创建账号和登录时请使用上面的邮箱地址。\n如果链接无法自动打开，请将其复制并粘贴到浏览器中。\n",

	// Password reset
	"FreeDrive Password Reset": "FreeDrive 密码重置",
	"Hello %s,\n\nA password reset was requested for your FreeDrive account.\n\nReset link:\n%s\n\nIf you did not request this, you can ignore this email.\n": "%s，你好：\n\n有人为你的 FreeDrive 账号申请了密码重置。\n\n重置链接：\n%s\n\n如果这不是你本人的操作，可以忽略此邮件。\n",
	"Reset your FreeDrive password": "重置你的 FreeDrive 密码",
	"Hello,\n\nUse this link to reset your password (expires in 30 minutes):\n\n%s\n\nIf you did not request this, ignore this email.\n": "你好：\n\n请使用以下链接重置密码（30 分钟内有效）：\n\n%s\n\n如果这不是你本人的操作，请忽略此邮件。\n",

	// SMTP test
	"FreeDrive Test Email": "FreeDrive 测试邮件",
	"This is a test email sent from your FreeDrive Admin Panel.\nIf you received this, your SMTP configuration is correct!\n": "这是一封从 FreeDrive 管理后台发送的测试邮件。\n如果你收到了此邮件，说明 SMTP 配置正确！\n",

	// Phone sign-in approval push
	"Is this you signing in?":                                    "是你本人在登录吗？",
	"Someone is trying to sign in. Tap to approve or deny.":      "有人正在尝试登录。点按以批准或拒绝。",
	"Someone is trying to sign in (%s). Tap to approve or deny.": "有人正在尝试登录（%s）。点按以批准或拒绝。",
	"Sign-in attempt from %s. Tap to approve or deny.":           "来自 %s 的登录请求。点按以批准或拒绝。",
	"Sign-in attempt from %s (%s). Tap to approve or deny.":      "来自 %s（%s）的登录请求。点按以批准或拒绝。",

	// Roles and generated device names
	"ADMIN":       "管理员",
	"USER":        "用户",
	"GUEST":       "访客",
	"Desktop app": "桌面应用",
	"Mobile app":  "移动应用",
	"Browser":     "浏览器",
	"Unknown OS":  "未知系统",
	"%s on %s":    "%[2]s 上的 %[1]s",
}

var catalogs = map[string]map[string]string{"zh-CN": zhCN}

// T returns the site-language version of an English message or format string.
func T(message string) string {
	return translate(adminsettings.DefaultLanguage(), message)
}

func translate(language, message string) string {
	if translated, ok := catalogs[language][message]; ok {
		return translated
	}
	return message
}

// Role formats an invite role (admin, user, guest) for the site language.
func Role(role string) string {
	return T(strings.ToUpper(strings.TrimSpace(role)))
}

var generatedDeviceName = regexp.MustCompile(`^(Browser|Edge|Chrome|Firefox|Safari|Opera) on (Unknown OS|Windows|macOS|Android|iOS|Linux)$`)

// DeviceName translates server-generated device names ("Chrome on Linux");
// names supplied by desktop or mobile clients are returned unchanged.
func DeviceName(name string) string {
	language := adminsettings.DefaultLanguage()
	if name == "Desktop app" || name == "Mobile app" {
		return translate(language, name)
	}
	match := generatedDeviceName.FindStringSubmatch(name)
	if match == nil || catalogs[language] == nil {
		return name
	}
	return fmt.Sprintf(translate(language, "%s on %s"), translate(language, match[1]), translate(language, match[2]))
}
