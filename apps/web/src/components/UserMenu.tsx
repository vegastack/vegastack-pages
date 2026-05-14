import {
  ChevronsUpDown,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Sun,
  User as UserIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  applyTheme,
  persistTheme,
  readStoredTheme,
  type ThemeChoice,
} from "../lib/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

const themeOptions: Array<{
  value: ThemeChoice;
  label: string;
  icon: typeof Monitor;
}> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

type UserMenuProps = {
  name: string;
  email: string;
  initials: string;
  showWorkspaceSettings: boolean;
};

export function UserMenu({
  name,
  email,
  initials,
  showWorkspaceSettings,
}: UserMenuProps) {
  const [theme, setTheme] = useState<ThemeChoice>("system");

  useEffect(() => {
    const next = readStoredTheme();
    setTheme(next);
    applyTheme(next);
    // Backfill cookie for legacy localStorage-only clients so SSR can render
    // the right data-theme on the next navigation and avoid a theme flash.
    persistTheme(next);
  }, []);

  function chooseTheme(value: string) {
    const next: ThemeChoice =
      value === "light" || value === "dark" || value === "system"
        ? value
        : "system";
    setTheme(next);
    persistTheme(next);
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    window.location.href = "/app/login";
  }

  const activeTheme =
    themeOptions.find((option) => option.value === theme) ?? themeOptions[0];
  const ActiveIcon = activeTheme.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="vpg-user-trigger"
        aria-label={`Account menu for ${name}`}
      >
        <span className="vpg-user-avatar" aria-hidden="true">
          {initials}
        </span>
        <span className="vpg-user-text">
          <span className="vpg-user-name">{name}</span>
          <span className="vpg-user-email">{email}</span>
        </span>
        <ChevronsUpDown
          className="vpg-user-caret"
          size={14}
          aria-hidden="true"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="vpg-user-menu"
        align="start"
        side="top"
        sideOffset={6}
      >
        <DropdownMenuLabel>
          <span className="vpg-user-menu-label-name">{name}</span>
          <span className="vpg-user-menu-label-email">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href="/app/profile">
            <UserIcon size={14} aria-hidden="true" />
            <span>Profile</span>
          </a>
        </DropdownMenuItem>
        {showWorkspaceSettings && (
          <DropdownMenuItem asChild>
            <a href="/app/settings/general">
              <Settings size={14} aria-hidden="true" />
              <span>Settings</span>
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ActiveIcon size={14} aria-hidden="true" />
            <span>Theme</span>
            <span className="vpg-user-menu-meta">{activeTheme.label}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={chooseTheme}>
              {themeOptions.map((option) => {
                const Icon = option.icon;
                return (
                  <DropdownMenuRadioItem
                    key={option.value}
                    value={option.value}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <span>{option.label}</span>
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <button type="button" onClick={() => void logout()}>
            <LogOut size={14} aria-hidden="true" />
            <span>Log out</span>
          </button>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
