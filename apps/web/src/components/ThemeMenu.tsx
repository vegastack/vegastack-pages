import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

type ThemeChoice = "system" | "light" | "dark";

const themes: Array<{
  value: ThemeChoice;
  label: string;
  icon: typeof Monitor;
}> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export function ThemeMenu() {
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

  function chooseTheme(next: ThemeChoice) {
    setTheme(next);
    applyTheme(next);
    window.localStorage.setItem("vpg-theme", next);
  }

  const activeTheme = themes.find((item) => item.value === theme) ?? themes[0];
  const ActiveIcon = activeTheme.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`Theme: ${activeTheme.label}`}
          size="icon"
          type="button"
          variant="ghost"
        >
          <ActiveIcon size={15} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => chooseTheme(value as ThemeChoice)}
        >
          {themes.map((item) => {
            const Icon = item.icon;
            const active = item.value === theme;
            return (
              <DropdownMenuRadioItem key={item.value} value={item.value}>
                <Icon size={14} aria-hidden="true" />
                <span>{item.label}</span>
                {active ? (
                  <Check
                    className="vpg-dropdown-check"
                    size={14}
                    aria-hidden="true"
                  />
                ) : null}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function applyTheme(theme: ThemeChoice) {
  if (document.documentElement.dataset.theme !== theme) {
    document.documentElement.dataset.theme = theme;
  }
}
