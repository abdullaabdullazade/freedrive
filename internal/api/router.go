package api

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"net/http"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/api/handlers"
	"github.com/abdullaabdullazade/freedrive/internal/api/middleware"
	"github.com/abdullaabdullazade/freedrive/internal/repository"
	"github.com/abdullaabdullazade/freedrive/internal/repository/sqlite"
	"github.com/abdullaabdullazade/freedrive/internal/service"
	"github.com/abdullaabdullazade/freedrive/internal/storage"
	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
)

// NewRouter creates and configures the HTTP router.
func NewRouter(
	webFS embed.FS,
	authService *service.AuthService,
	fileService *service.FileService,
	folderService *service.FolderService,
	computerService *service.ComputerService,
	syncFeedService *service.SyncFeedService,
	shareService *service.ShareService,
	passwordResetService *service.PasswordResetService,
	accessService *service.AccessService,
	cryptoService *service.CryptoService,
	fileRepo repository.FileRepository,
	userRepo repository.UserRepository,
	folderRepo repository.FolderRepository,
	emailChangeRepo repository.EmailChangeRepository,
	commentRepo repository.CommentRepository,
	activityRepo repository.ActivityRepository,
	searchRepo *sqlite.SearchRepo,
	approvalRepo *sqlite.ApprovalRepo,
	diskStorage *storage.DiskStorage,
	maxUpload int64,
	dataDir string,
	clientMutationRepo repository.ClientMutationRepository,
	uploadSessionRepo repository.UploadSessionRepository,
	loginApprovalService *service.LoginApprovalService,
) http.Handler {
	r := chi.NewRouter()

	r.Use(chiMiddleware.RequestID)
	r.Use(chiMiddleware.RealIP)
	r.Use(chiMiddleware.Logger)
	r.Use(chiMiddleware.Recoverer)
	r.Use(chiMiddleware.Compress(5))
	r.Use(middleware.CORS)

	limiter := middleware.NewRateLimiter(100, 400)
	r.Use(limiter.Limit)

	authHandler := handlers.NewAuthHandler(authService, cryptoService, emailChangeRepo, userRepo, activityRepo, passwordResetService)
	if loginApprovalService != nil {
		authHandler.SetLoginApproval(loginApprovalService)
	}
	loginApprovalHandler := handlers.NewLoginApprovalHandler(loginApprovalService)
	sessionHandler := handlers.NewSessionHandler(authService)
	fileHandler := handlers.NewFileHandler(fileService, fileRepo, diskStorage, maxUpload, clientMutationRepo)
	uploadHandler := handlers.NewUploadHandler(uploadSessionRepo, fileRepo, userRepo, fileService, diskStorage, accessService, maxUpload, dataDir)
	folderHandler := handlers.NewFolderHandler(folderService, clientMutationRepo)
	computerHandler := handlers.NewComputerHandler(computerService, folderService, syncFeedService)
	shareHandler := handlers.NewShareHandler(shareService, fileRepo, userRepo, diskStorage)
	commentHandler := handlers.NewCommentHandler(commentRepo, accessService, userRepo)
	adminHandler := handlers.NewAdminHandler(userRepo, fileRepo, folderRepo, activityRepo, authService, passwordResetService, diskStorage, dataDir)
	userHandler := handlers.NewUserHandler(userRepo, fileRepo, emailChangeRepo, authService)
	searchHandler := handlers.NewSearchHandler(searchRepo)
	approvalHandler := handlers.NewApprovalHandler(approvalRepo, userRepo, accessService)
	cryptoHandler := handlers.NewCryptoHandler(cryptoService)

	r.Route("/api/v1", func(r chi.Router) {
		r.Route("/auth", func(r chi.Router) {
			r.Post("/register", authHandler.Register)
			r.Post("/login", authHandler.Login)
			r.Post("/verify-2fa", authHandler.Verify2FA)
			r.Post("/2fa/send-email", authHandler.Send2FAEmail)
			r.Get("/login-approval/{id}", loginApprovalHandler.Poll)
			r.Post("/refresh", authHandler.Refresh)
			r.Post("/logout", authHandler.Logout)
			r.Post("/forgot-password", authHandler.ForgotPassword)
			r.Post("/reset-password", authHandler.ResetPassword)
			r.Post("/reset-password/crypto-info", authHandler.ResetPasswordCryptoInfo)
			r.Post("/confirm-email", authHandler.ConfirmEmail)
		})

		r.Get("/public/share/{token}", shareHandler.PublicLinkInfo)
		r.Get("/public/share/{token}/download", shareHandler.PublicLinkDownload)

		r.Group(func(r chi.Router) {
			r.Use(middleware.Auth(authService))

			r.Get("/auth/sessions", sessionHandler.List)
			r.Delete("/auth/sessions/{id}", sessionHandler.Revoke)
			r.Post("/auth/sessions/revoke-others", sessionHandler.RevokeOthers)
			r.Get("/auth/login-approval/{id}/details", loginApprovalHandler.Get)
			r.Post("/auth/login-approval/{id}/approve", loginApprovalHandler.Approve)
			r.Post("/auth/login-approval/{id}/deny", loginApprovalHandler.Deny)

			r.Get("/me", userHandler.GetMe)
			r.Patch("/me", userHandler.UpdateMe)
			r.Get("/me/storage", userHandler.MyStorage)
			r.Post("/me/push-token", loginApprovalHandler.RegisterPushToken)
			r.Delete("/me/push-token", loginApprovalHandler.UnregisterPushToken)
			r.Get("/me/login-approvals/pending", loginApprovalHandler.ListPending)
			r.Get("/me/login-approval/status", loginApprovalHandler.Status)
			r.Post("/me/totp/setup", userHandler.SetupTOTP)
			r.Post("/me/totp/confirm", userHandler.ConfirmTOTP)
			r.Post("/me/totp/disable", userHandler.DisableTOTP)
			r.Post("/me/email-change/request", userHandler.RequestEmailChange)
			r.Get("/me/email-change/status", userHandler.EmailChangeStatus)

			r.Get("/search", searchHandler.Search)
			r.Get("/approvals", approvalHandler.List)
			r.Patch("/approvals/{id}", approvalHandler.Update)

			r.Route("/shares", func(r chi.Router) {
				r.Get("/with-me", shareHandler.SharedWithMe)
				r.Get("/by-me", shareHandler.SharedByMe)
				r.Post("/users", shareHandler.CreateUserShare)
				r.Patch("/users/{id}", shareHandler.UpdateUserShare)
				r.Delete("/users/{id}", shareHandler.DeleteUserShare)
				r.Get("/links", shareHandler.ListLinks)
				r.Post("/links", shareHandler.CreateLink)
				r.Delete("/links/{id}", shareHandler.DeleteLink)
			})

			r.Post("/trash/empty", fileHandler.EmptyTrash)

			r.Route("/uploads/sessions", func(r chi.Router) {
				r.Post("/", uploadHandler.CreateSession)
				r.Get("/{id}", uploadHandler.GetSession)
				r.Put("/{id}", uploadHandler.PutChunk)
				r.Delete("/{id}", uploadHandler.AbortSession)
			})

			r.Route("/files", func(r chi.Router) {
				r.Post("/upload", fileHandler.Upload)
				r.Get("/", fileHandler.List)
				r.Get("/trash", fileHandler.Trash)
				r.Get("/{id}", fileHandler.Get)
				r.Post("/{id}/approvals", approvalHandler.Create)
				r.Get("/{id}/comments", commentHandler.List)
				r.Post("/{id}/comments", commentHandler.Create)
				r.Delete("/{id}/comments/{commentId}", commentHandler.Delete)
				r.Get("/{id}/download", fileHandler.Download)
				r.Patch("/{id}", fileHandler.Update)
				r.Post("/{id}/content", fileHandler.UpdateContent)
				r.Delete("/{id}", fileHandler.Delete)
				r.Post("/{id}/restore", fileHandler.Restore)
				r.Delete("/{id}/permanent", fileHandler.PermanentDelete)
				r.Get("/{id}/versions", fileHandler.GetVersions)
				r.Post("/{id}/versions/{version}/restore", fileHandler.RestoreVersion)
				r.Get("/{id}/encryption-key", cryptoHandler.GetFileEncryptionKey)
				r.Put("/{id}/encryption-key", cryptoHandler.PutFileEncryptionKey)
			})

			r.Route("/folders", func(r chi.Router) {
				r.Post("/", folderHandler.Create)
				r.Get("/root", folderHandler.GetRoot)
				r.Get("/all", folderHandler.ListAll)
				r.Get("/trash", folderHandler.Trash)
				r.Get("/{id}", folderHandler.Get)
				r.Patch("/{id}", folderHandler.Update)
				r.Delete("/{id}", folderHandler.Delete)
				r.Post("/{id}/restore", folderHandler.Restore)
				r.Delete("/{id}/permanent", folderHandler.PermanentDelete)
				r.Get("/{id}/breadcrumb", folderHandler.GetBreadcrumb)
			})

			r.Route("/computers", func(r chi.Router) {
				r.Get("/", computerHandler.List)
				r.Post("/register", computerHandler.Register)
				r.Get("/{id}", computerHandler.Get)
				r.Get("/{id}/snapshot", computerHandler.Snapshot)
				r.Get("/{id}/changes", computerHandler.Changes)
				r.Delete("/{id}", computerHandler.Delete)
				r.Post("/{id}/heartbeat", computerHandler.Heartbeat)
			})

			r.Get("/activity", func(w http.ResponseWriter, r *http.Request) {
				adminHandler.MyActivity(w, r)
			})

			r.Get("/disk-stats", handlers.DiskStats)

			r.Route("/crypto", func(r chi.Router) {
				r.Get("/account", cryptoHandler.GetAccount)
				r.Post("/account", cryptoHandler.SetupAccount)
				r.Put("/account", cryptoHandler.UpdateAccount)
			})

			r.Get("/encryption-keys", cryptoHandler.ListEncryptionKeys)
			r.Post("/encryption-keys/bulk", cryptoHandler.BulkPutEncryptionKeys)

			r.Route("/admin", func(r chi.Router) {
				r.Use(middleware.RequireAdmin)

				r.Get("/users", adminHandler.ListUsers)
				r.Post("/users", adminHandler.CreateUser)
				r.Patch("/users/{id}", adminHandler.UpdateUser)
				r.Post("/users/send-2fa-reminder", adminHandler.Send2FAReminder)
				r.Delete("/users/{id}", adminHandler.DeleteUser)
				r.Post("/users/{id}/reset-password", adminHandler.SendPasswordReset)
				r.Post("/users/{id}/revoke-sessions", adminHandler.RevokeUserSessions)
				r.Post("/sessions/revoke-all", adminHandler.RevokeAllSessions)
				r.Get("/stats", adminHandler.Stats)
				r.Post("/invites", adminHandler.CreateInvite)
				r.Post("/invites/resend", adminHandler.ResendInvite)
				r.Get("/invites", adminHandler.ListInvites)
				r.Delete("/invites/{id}", adminHandler.DeleteInvite)
				r.Get("/activity", adminHandler.Activity)
				r.Get("/settings", adminHandler.GetSettings)
				r.Post("/settings", adminHandler.SaveSettings)
				r.Post("/test-email", adminHandler.TestEmail)
				r.Post("/backup/run", adminHandler.RunBackupNow)
				r.Get("/backup/list", adminHandler.ListBackups)
				r.Get("/backup/download/{filename}", adminHandler.DownloadBackup)
				r.Post("/backup/restore", adminHandler.RestoreBackup)
				r.Delete("/backup/{filename}", adminHandler.DeleteBackup)
				r.Post("/storage/purge-trash", adminHandler.PurgeTrash)
				r.Get("/storage/breakdown", adminHandler.StorageBreakdown)
				r.Get("/storage/duplicates", adminHandler.ListDuplicates)
				r.Post("/storage/duplicates/purge", adminHandler.PurgeDuplicates)
				r.Post("/danger/wipe", adminHandler.WipeAllData)
			})
		})

		r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"status":"ok"}`))
		})
	})

	webRoot, err := fs.Sub(webFS, "web")
	if err != nil {
		panic("failed to get web sub filesystem: " + err.Error())
	}

	r.Get("/*", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/" {
			path = "/index.html"
		}

		data, err := webRoot.(fs.ReadFileFS).ReadFile(path[1:])
		if err != nil {
			data, err = webRoot.(fs.ReadFileFS).ReadFile("index.html")
			if err != nil {
				http.NotFound(w, r)
				return
			}
			path = "/index.html"
		}

		sum := sha256.Sum256(data)
		etag := "\"" + hex.EncodeToString(sum[:]) + "\""
		w.Header().Set("ETag", etag)
		w.Header().Set("Cache-Control", "no-cache")

		http.ServeContent(w, r, path, time.Time{}, bytes.NewReader(data))
	})

	return r
}
