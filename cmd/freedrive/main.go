package main

import (
	"context"
	"embed"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/abdullaabdullazade/freedrive/internal/adminsettings"
	"github.com/abdullaabdullazade/freedrive/internal/api"
	"github.com/abdullaabdullazade/freedrive/internal/config"
	"github.com/abdullaabdullazade/freedrive/internal/repository/sqlite"
	"github.com/abdullaabdullazade/freedrive/internal/service"
	"github.com/abdullaabdullazade/freedrive/internal/storage"
)

//go:embed all:web
var webFS embed.FS

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	db, err := sqlite.New(cfg.DataDir)
	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer db.Close()

	if err := db.Migrate(); err != nil {
		log.Fatalf("Failed to run migrations: %v", err)
	}
	log.Println("✓ Database migrations applied")

	adminsettings.SetDataDir(cfg.DataDir)

	diskStorage, err := storage.NewDiskStorage(cfg.DataDir)
	if err != nil {
		log.Fatalf("Failed to initialize storage: %v", err)
	}

	userRepo := sqlite.NewUserRepo(db)
	fileRepo := sqlite.NewFileRepo(db)
	folderRepo := sqlite.NewFolderRepo(db)
	computerRepo := sqlite.NewComputerRepo(db)
	activityRepo := sqlite.NewActivityRepo(db)
	searchRepo := sqlite.NewSearchRepo(db)
	approvalRepo := sqlite.NewApprovalRepo(db)
	emailChangeRepo := sqlite.NewEmailChangeRepo(db)
	email2faRepo := sqlite.NewEmail2FARepo(db)
	totpBackupRepo := sqlite.NewTotpBackupRepo(db)
	shareRepo := sqlite.NewShareRepo(db)
	commentRepo := sqlite.NewCommentRepo(db)
	passwordResetRepo := sqlite.NewPasswordResetRepo(db)
	cryptoRepo := sqlite.NewCryptoRepo(db)
	syncChangeRepo := sqlite.NewSyncChangeRepo(db)
	clientMutationRepo := sqlite.NewClientMutationRepo(db)
	sessionRepo := sqlite.NewSessionRepo(db)
	loginApprovalRepo := sqlite.NewLoginApprovalRepo(db)
	pushTokenRepo := sqlite.NewPushTokenRepo(db)

	accessService := service.NewAccessService(shareRepo, fileRepo, folderRepo)
	shareService := service.NewShareService(shareRepo, fileRepo, folderRepo, userRepo, accessService)
	passwordResetService := service.NewPasswordResetService(userRepo, passwordResetRepo)
	cryptoService := service.NewCryptoService(cryptoRepo, fileRepo, accessService)
	syncChangeService := service.NewSyncChangeService(syncChangeRepo, computerRepo)
	syncFeedService := service.NewSyncFeedService(syncChangeRepo, computerRepo, folderRepo, fileRepo)

	authService := service.NewAuthService(userRepo, email2faRepo, totpBackupRepo, sessionRepo, cfg.JWTSecret)
	expoPush := service.NewExpoPushService(pushTokenRepo)
	loginApprovalService := service.NewLoginApprovalService(loginApprovalRepo, pushTokenRepo, expoPush, authService, userRepo)
	fileService := service.NewFileService(fileRepo, userRepo, diskStorage, activityRepo, accessService, folderRepo, syncChangeService)
	computerService := service.NewComputerService(computerRepo, folderRepo)
	folderService := service.NewFolderService(folderRepo, fileRepo, userRepo, diskStorage, activityRepo, computerRepo, accessService, syncChangeService)

	userCount, err := userRepo.Count(context.Background())
	if err != nil {
		log.Fatalf("Failed to count users: %v", err)
	}
	if userCount == 0 && len(cfg.AdminPassword) < 12 {
		log.Fatal("FREEDRIVE_ADMIN_PASSWORD must be set to at least 12 characters for first startup")
	}
	if userCount == 0 {
		if err := authService.EnsureAdmin(context.Background(), cfg.AdminEmail, cfg.AdminPassword); err != nil {
			log.Fatalf("Could not create initial admin user: %v", err)
		}
		log.Printf("✓ Admin user created: %s", cfg.AdminEmail)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fileService.StartTrashPurge(ctx)
	adminsettings.StartBackupScheduler(ctx)

	router := api.NewRouter(
		webFS,
		authService,
		fileService,
		folderService,
		computerService,
		syncFeedService,
		shareService,
		passwordResetService,
		accessService,
		cryptoService,
		fileRepo,
		userRepo,
		folderRepo,
		emailChangeRepo,
		commentRepo,
		activityRepo,
		searchRepo,
		approvalRepo,
		diskStorage,
		cfg.MaxUploadBytes,
		cfg.DataDir,
		clientMutationRepo,
		sqlite.NewUploadSessionRepo(db),
		loginApprovalService,
	)

	server := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Port),
		Handler:      router,
		ReadTimeout:  5 * time.Minute,
		WriteTimeout: 10 * time.Minute,
		IdleTimeout:  120 * time.Second,
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		log.Printf("╔══════════════════════════════════════════╗")
		log.Printf("║           🚀 FreeDrive v1.0.0           ║")
		log.Printf("║   Your cloud. Your rules. Your server.  ║")
		log.Printf("╠══════════════════════════════════════════╣")
		log.Printf("║   Server: http://localhost:%d            ║", cfg.Port)
		log.Printf("║   Data:   %s                            ║", cfg.DataDir)
		log.Printf("╚══════════════════════════════════════════╝")

		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	<-quit
	log.Println("Shutting down server...")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Fatalf("Server forced shutdown: %v", err)
	}

	cancel()
	log.Println("Server stopped gracefully")
}
