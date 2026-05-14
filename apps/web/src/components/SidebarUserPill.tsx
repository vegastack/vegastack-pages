import {
  BookOpen,
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

type ThemeChoice = "system" | "light" | "dark";

const THEME_OPTIONS: Array<{
  value: ThemeChoice;
  label: string;
  icon: typeof Monitor;
}> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

type Props = {
  name: string;
  email: string;
  initials: string;
};

export function SidebarUserPill({ name, email, initials }: Props) {
  const [theme, setTheme] = useState<ThemeChoice>("system");

  useEffect(() => {
    const stored = window.localStorage.getItem("vpg-theme");
    const next =
      stored === "light" || stored === "dark" || stored === "system"
        ? stored
        : "system";
    setTheme(next);
    applyTheme(next);
  }, []);

  function chooseTheme(value: string) {
    const next = (
      value === "light" || value === "dark" || value === "system"
        ? value
        : "system"
    ) as ThemeChoice;
    setTheme(next);
    window.localStorage.setItem("vpg-theme", next);
    applyTheme(next);
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    window.location.href = "/app/login";
  }

  const active =
    THEME_OPTIONS.find((option) => option.value === theme) ?? THEME_OPTIONS[0];
  const ActiveIcon = active.icon;

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
        <DropdownMenuItem asChild>
          <a href="/app/settings/general">
            <Settings size={14} aria-hidden="true" />
            <span>Workspace settings</span>
          </a>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ActiveIcon size={14} aria-hidden="true" />
            <span>Theme</span>
            <span className="vpg-user-menu-meta">{active.label}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={chooseTheme}>
              {THEME_OPTIONS.map((option) => {
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
        <DropdownMenuItem asChild>
          <a href="/docs">
            <BookOpen size={14} aria-hidden="true" />
            <span>Help &amp; docs</span>
          </a>
        </DropdownMenuItem>
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

function applyTheme(theme: ThemeChoice) {
  if (document.documentElement.dataset.theme !== theme) {
    document.documentElement.dataset.theme = theme;
  }
}
