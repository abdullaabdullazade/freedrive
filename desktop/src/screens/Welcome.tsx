import { Logo } from "../components/Logo";

interface WelcomeProps {
  onGetStarted: () => void;
}

export function Welcome({ onGetStarted }: WelcomeProps) {
  return (
    <div className="welcome-screen">
      <div className="signin-header">
        <Logo />
        <button type="button" className="icon-btn">⋮</button>
      </div>
      <div className="welcome-content">
        <h1 className="welcome-title">Welcome to FreeDrive!</h1>
        <p className="welcome-subtitle">
          Get the most out of FreeDrive, straight from your computer
        </p>
        <div className="feature-grid">
          <div className="feature-item">
            <div className="feature-icon">🛡️</div>
            <p className="feature-text">
              Safely store your files and folders in FreeDrive
            </p>
          </div>
          <div className="feature-item">
            <div className="feature-icon">🖥️</div>
            <p className="feature-text">
              Open Drive files with applications on your computer
            </p>
          </div>
          <div className="feature-item">
            <div className="feature-icon">🔄</div>
            <p className="feature-text">
              Automatically keep all your Drive files up to date
            </p>
          </div>
        </div>
      </div>
      <div className="welcome-footer">
        <button type="button" className="btn-primary" onClick={onGetStarted}>
          Get started
        </button>
      </div>
    </div>
  );
}
