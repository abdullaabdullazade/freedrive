import type { PreferencesTab } from "../types";

interface PreferencesSidebarProps {
  activeTab: PreferencesTab;
  onTabChange: (tab: PreferencesTab) => void;
}

const tabs: { id: PreferencesTab; label: string; subtitle: string }[] = [
  { id: "my-computer", label: "My computer", subtitle: "Folders from your computer" },
  { id: "freedrive", label: "FreeDrive", subtitle: "Folders from Drive" },
];

export function PreferencesSidebar({ activeTab, onTabChange }: PreferencesSidebarProps) {
  return (
    <nav className="preferences-sidebar" aria-label="Preferences sections">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`preferences-tab${activeTab === tab.id ? " active" : ""}`}
          onClick={() => onTabChange(tab.id)}
        >
          <span className="preferences-tab-label">{tab.label}</span>
          <span className="preferences-tab-subtitle">{tab.subtitle}</span>
        </button>
      ))}
    </nav>
  );
}
