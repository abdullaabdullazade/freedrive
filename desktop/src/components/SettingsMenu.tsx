import { useEffect, useRef } from "react";

export type SettingsMenuAction =
  | "preferences"
  | "error-list"
  | "about"
  | "help"
  | "quit";

interface SettingsMenuProps {
  anchorRect: DOMRect | null;
  onClose: () => void;
  onAction: (action: SettingsMenuAction) => void;
}

const items: { id: SettingsMenuAction; label: string; danger?: boolean }[] = [
  { id: "preferences", label: "Preferences" },
  { id: "error-list", label: "Error list" },
  { id: "about", label: "About" },
  { id: "help", label: "Help" },
  { id: "quit", label: "Quit", danger: true },
];

export function SettingsMenu({ anchorRect, onClose, onAction }: SettingsMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!anchorRect) return null;

  const top = anchorRect.bottom + 8;
  const right = Math.max(16, window.innerWidth - anchorRect.right);

  return (
    <div
      ref={menuRef}
      className="settings-gear-menu"
      style={{ top, right }}
      role="menu"
      aria-label="Settings menu"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={`settings-gear-item${item.danger ? " settings-gear-item-danger" : ""}`}
          onClick={() => {
            onClose();
            onAction(item.id);
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
