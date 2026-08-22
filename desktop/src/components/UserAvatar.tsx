import type { User } from "../types";

interface UserAvatarProps {
  user: User | null;
  size?: "sm" | "lg";
  className?: string;
}

function displayInitial(user: User | null): string {
  return (
    user?.username?.[0]?.toUpperCase() ||
    user?.email?.[0]?.toUpperCase() ||
    "?"
  );
}

export function UserAvatar({ user, size = "sm", className }: UserAvatarProps) {
  const avatarUrl = user?.avatar_url;
  const sizeClass = size === "lg" ? "user-avatar-lg" : "user-avatar-sm";

  if (avatarUrl?.startsWith("data:image/")) {
    return (
      <img
        src={avatarUrl}
        alt=""
        className={`user-avatar ${sizeClass}${className ? ` ${className}` : ""}`}
      />
    );
  }

  return (
    <div
      className={`user-avatar user-avatar-fallback ${sizeClass}${className ? ` ${className}` : ""}`}
      aria-hidden
    >
      {displayInitial(user)}
    </div>
  );
}

export function displayName(user: User | null): string {
  if (!user) return "User";
  if (user.username?.trim()) return user.username.trim();
  const email = user.email || "";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email || "User";
}
