import {
  FileText,
  Folder,
  Keyboard,
  LogOut,
  MessageSquare,
  Plus,
  SearchX,
  Settings,
  User,
} from "lucide-react";
import React from "react";
import { useEffect, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "./ui/command";

type SearchResult = {
  type: "page" | "folder" | "comment_thread";
  id: string;
  pageId: string | null;
  folderId: string | null;
  title: string;
  url: string;
  path: string;
  subtitle: string;
  snippet: string;
  updatedAt: string;
  icon: "file-text" | "folder" | "message-square";
  matchedField: "title" | "path" | "content" | "comment";
};

type CommandPaletteProps = {
  workspaceId: string;
  openIntent?: number;
};

export function CommandPaletteDialog({
  workspaceId,
  openIntent = 0,
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [favorites, setFavorites] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (openIntent > 0) setOpen(true);
  }, [openIntent]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setFavorites([]);
      return;
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      setResults([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/search?workspace_id=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(query)}&limit=8&include=favorites,recents`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          setResults([]);
          return;
        }
        const payload = (await response.json()) as {
          results: SearchResult[];
          favorites?: SearchResult[];
        };
        setResults(payload.results);
        setFavorites(!query.trim() ? (payload.favorites ?? []) : []);
      } catch {
        // aborted or network error; results stay as-is
      } finally {
        setLoading(false);
      }
    }, 120);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
      setLoading(false);
    };
  }, [open, query, workspaceId]);

  function go(href: string) {
    setOpen(false);
    window.location.href = href;
  }

  function openResult(result: SearchResult) {
    void fetch(`/api/search?workspace_id=${encodeURIComponent(workspaceId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: result.type, id: result.id }),
    }).catch(() => null);
    go(result.url);
  }

  async function logout() {
    setOpen(false);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    window.location.href = "/app/login";
  }

  function settingsHref(section: string, extra?: string) {
    // Active workspace is sticky via cookie; no need to carry workspace_id
    // in command-palette navigations.
    const params = new URLSearchParams();
    if (extra) {
      for (const [key, value] of new URLSearchParams(extra))
        params.set(key, value);
    }
    const query = params.toString();
    return query
      ? `/app/settings/${section}?${query}`
      : `/app/settings/${section}`;
  }

  const trimmed = query.trim();
  const showResults = trimmed.length > 0;
  const showingRecents = trimmed.length === 0 && results.length > 0;
  const showingFavorites = trimmed.length === 0 && favorites.length > 0;
  const showTypedEmptyState = showResults && !loading && results.length === 0;
  const showUtilityGroups = !showResults || results.length > 0;

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search and run commands"
        shouldFilter={!showResults}
      >
        <CommandInput
          placeholder="Search pages or run a command..."
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>
            {showTypedEmptyState ? (
              <div className="vpg-command-empty-state">
                <SearchX size={20} aria-hidden="true" />
                <span>No results found</span>
                <small>Try a page title, folder name, or comment text.</small>
              </div>
            ) : loading ? (
              "Searching..."
            ) : trimmed.length === 0 ? (
              "No recent pages, folders, or comments yet."
            ) : (
              "No results found."
            )}
          </CommandEmpty>

          {(showResults || showingRecents) && results.length > 0 && (
            <CommandGroup heading={showingRecents ? "Recent" : "Results"}>
              {results.map((result) => (
                <CommandItem
                  key={`${result.type}:${result.id}`}
                  value={`${result.type}:${result.id} ${result.title} ${result.path} ${result.snippet}`}
                  onSelect={() => openResult(result)}
                >
                  <ResultIcon icon={result.icon} />
                  <div className="vpg-command-item-text">
                    <span>{result.title}</span>
                    <small>
                      {result.subtitle || result.path || "/"}
                      {result.updatedAt
                        ? ` · ${relativeTime(result.updatedAt)}`
                        : ""}
                    </small>
                    {result.snippet && showResults && <em>{result.snippet}</em>}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {showingFavorites && (
            <CommandGroup heading="Favorites">
              {favorites.map((result) => (
                <CommandItem
                  key={`favorite:${result.id}`}
                  value={`favorite:${result.id} ${result.title}`}
                  onSelect={() => openResult(result)}
                >
                  <ResultIcon icon={result.icon} />
                  <div className="vpg-command-item-text">
                    <span>{result.title}</span>
                    <small>{result.subtitle}</small>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {showUtilityGroups && (
            <CommandGroup heading="Quick actions">
              <CommandItem
                value="create page new"
                onSelect={() => go(settingsHref("folders", "focus=create"))}
              >
                <Plus size={14} aria-hidden="true" />
                <span>New folder</span>
              </CommandItem>
              <CommandItem
                value="invite member team"
                onSelect={() => go(settingsHref("members", "focus=invite"))}
              >
                <User size={14} aria-hidden="true" />
                <span>Invite member</span>
              </CommandItem>
            </CommandGroup>
          )}

          {showUtilityGroups && <CommandSeparator />}

          {showUtilityGroups && (
            <CommandGroup heading="Settings">
              <CommandItem
                value="settings general workspace"
                onSelect={() => go(settingsHref("general"))}
              >
                <Settings size={14} aria-hidden="true" />
                <span>Settings</span>
                <CommandShortcut>⌘,</CommandShortcut>
              </CommandItem>
              <CommandItem
                value="folders sidebar"
                onSelect={() => go(settingsHref("folders"))}
              >
                <Folder size={14} aria-hidden="true" />
                <span>Manage folders</span>
              </CommandItem>
              <CommandItem
                value="shortcuts keyboard help"
                onSelect={() => go(settingsHref("general") + "#shortcuts")}
              >
                <Keyboard size={14} aria-hidden="true" />
                <span>Keyboard shortcuts</span>
              </CommandItem>
            </CommandGroup>
          )}

          {showUtilityGroups && <CommandSeparator />}

          {showUtilityGroups && (
            <CommandGroup heading="Account">
              <CommandItem
                value="profile account user"
                onSelect={() => go("/app/profile")}
              >
                <User size={14} aria-hidden="true" />
                <span>View profile</span>
              </CommandItem>
              <CommandItem
                value="logout sign out"
                onSelect={() => void logout()}
              >
                <LogOut size={14} aria-hidden="true" />
                <span>Log out</span>
              </CommandItem>
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}

function ResultIcon({ icon }: { icon: SearchResult["icon"] }) {
  if (icon === "folder") return <Folder size={14} aria-hidden="true" />;
  if (icon === "message-square")
    return <MessageSquare size={14} aria-hidden="true" />;
  return <FileText size={14} aria-hidden="true" />;
}

function relativeTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const divisions: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, {
    numeric: "auto",
  });
  for (const [unit, amount] of divisions) {
    if (Math.abs(seconds) >= amount) {
      return formatter.format(Math.round(seconds / amount), unit);
    }
  }
  return "just now";
}
