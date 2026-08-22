package email

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/smtp"
	"strings"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/adminsettings"
)

// SendFromSettings sends mail using admin SMTP settings from settings.json.
func SendFromSettings(toAddress, subject, body string) error {
	cfg := adminsettings.SMTP()
	if cfg.Server == "" || cfg.Port == 0 || cfg.FromAddress == "" {
		return fmt.Errorf("smtp settings are incomplete: set server, port and from address in admin settings")
	}
	return Send(cfg, toAddress, subject, body)
}

// Send delivers a plain-text email using the given SMTP configuration.
func Send(cfg adminsettings.SMTPConfig, toAddress, subject, body string) error {
	if cfg.Port == 443 || strings.HasPrefix(cfg.Server, "https://") || strings.HasPrefix(cfg.Server, "http://") || strings.Contains(cfg.Server, "api.mailersend.com") || strings.Contains(cfg.Server, "api.zeptomail.") {
		return sendHTTP(cfg.Server, cfg.Pass, cfg.FromAddress, cfg.FromName, toAddress, subject, body)
	}

	fromHeader := cfg.FromAddress
	if strings.TrimSpace(cfg.FromName) != "" {
		fromHeader = fmt.Sprintf("%s <%s>", cfg.FromName, cfg.FromAddress)
	}

	msg := []byte(
		"Subject: " + subject + "\r\n" +
			"From: " + fromHeader + "\r\n" +
			"To: " + toAddress + "\r\n" +
			"MIME-Version: 1.0\r\n" +
			"Content-Type: text/plain; charset=\"utf-8\"\r\n" +
			"\r\n" +
			body,
	)

	addr := fmt.Sprintf("%s:%d", cfg.Server, cfg.Port)
	var auth smtp.Auth
	if cfg.User != "" || cfg.Pass != "" {
		auth = smtp.PlainAuth("", cfg.User, cfg.Pass, cfg.Server)
	}

	if cfg.TLS && cfg.Port == 465 {
		tlsconfig := &tls.Config{
			InsecureSkipVerify: true,
			ServerName:         cfg.Server,
		}
		conn, errConn := tls.Dial("tcp", addr, tlsconfig)
		if errConn != nil {
			return fmt.Errorf("failed to connect via TLS: %w", errConn)
		}
		client, errClient := smtp.NewClient(conn, cfg.Server)
		if errClient != nil {
			return fmt.Errorf("failed to create SMTP client: %w", errClient)
		}
		defer client.Close()

		if auth != nil {
			if err := client.Auth(auth); err != nil {
				return fmt.Errorf("smtp auth failed: %w", err)
			}
		}
		if err := client.Mail(cfg.FromAddress); err != nil {
			return fmt.Errorf("smtp mail failed: %w", err)
		}
		if err := client.Rcpt(toAddress); err != nil {
			return fmt.Errorf("smtp rcpt failed: %w", err)
		}
		writer, errWriter := client.Data()
		if errWriter != nil {
			return fmt.Errorf("smtp data failed: %w", errWriter)
		}
		if _, err := writer.Write(msg); err != nil {
			return fmt.Errorf("failed to write email body: %w", err)
		}
		if err := writer.Close(); err != nil {
			return fmt.Errorf("failed to close email body writer: %w", err)
		}
		_ = client.Quit()
		return nil
	}

	client, err := smtp.Dial(addr)
	if err != nil {
		return fmt.Errorf("failed to dial SMTP server: %w", err)
	}
	defer client.Close()

	if cfg.TLS {
		if ok, _ := client.Extension("STARTTLS"); ok {
			tlsConfig := &tls.Config{
				InsecureSkipVerify: true,
				ServerName:         cfg.Server,
			}
			if err := client.StartTLS(tlsConfig); err != nil {
				return fmt.Errorf("starttls failed: %w", err)
			}
		} else {
			return fmt.Errorf("smtp server does not support STARTTLS")
		}
	}

	if auth != nil {
		if ok, _ := client.Extension("AUTH"); ok {
			if err := client.Auth(auth); err != nil {
				return fmt.Errorf("smtp auth failed: %w", err)
			}
		} else if cfg.User != "" || cfg.Pass != "" {
			return fmt.Errorf("smtp auth is required but not supported by server")
		}
	}

	if err := client.Mail(cfg.FromAddress); err != nil {
		return fmt.Errorf("smtp mail failed: %w", err)
	}
	if err := client.Rcpt(toAddress); err != nil {
		return fmt.Errorf("smtp rcpt failed: %w", err)
	}
	writer, errWriter := client.Data()
	if errWriter != nil {
		return fmt.Errorf("smtp data failed: %w", errWriter)
	}
	if _, err := writer.Write(msg); err != nil {
		return fmt.Errorf("failed to write email body: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("failed to close email body writer: %w", err)
	}
	_ = client.Quit()
	return nil
}

func sendHTTP(apiURL, apiToken, fromAddress, fromName, toAddress, subject, body string) error {
	if !strings.HasPrefix(apiURL, "http") {
		apiURL = "https://" + apiURL
	}

	var payload []byte
	var err error
	isZepto := false

	if strings.Contains(apiURL, "mailersend") {
		if !strings.Contains(apiURL, "/v1/email") {
			apiURL = strings.TrimRight(apiURL, "/") + "/v1/email"
		}
		reqBody := map[string]interface{}{
			"from":    map[string]string{"email": fromAddress, "name": fromName},
			"to":      []map[string]string{{"email": toAddress}},
			"subject": subject,
			"text":    body,
		}
		payload, err = json.Marshal(reqBody)
	} else if strings.Contains(apiURL, "zeptomail") {
		isZepto = true
		if !strings.Contains(apiURL, "/v1.1/email") {
			apiURL = strings.TrimRight(apiURL, "/") + "/v1.1/email"
		}
		reqBody := map[string]interface{}{
			"from": map[string]string{"address": fromAddress, "name": fromName},
			"to": []map[string]interface{}{
				{"email_address": map[string]string{"address": toAddress, "name": toAddress}},
			},
			"subject":  subject,
			"textbody": body,
		}
		payload, err = json.Marshal(reqBody)
	} else {
		reqBody := map[string]string{
			"from_email": fromAddress,
			"from_name":  fromName,
			"to_email":   toAddress,
			"subject":    subject,
			"body":       body,
		}
		payload, err = json.Marshal(reqBody)
	}
	if err != nil {
		return err
	}

	req, err := http.NewRequest("POST", apiURL, bytes.NewBuffer(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if apiToken != "" {
		if isZepto {
			if !strings.HasPrefix(apiToken, "Zoho-enczapikey ") {
				apiToken = "Zoho-enczapikey " + apiToken
			}
			req.Header.Set("Authorization", apiToken)
		} else {
			if !strings.HasPrefix(apiToken, "Bearer ") {
				apiToken = "Bearer " + apiToken
			}
			req.Header.Set("Authorization", apiToken)
		}
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}
