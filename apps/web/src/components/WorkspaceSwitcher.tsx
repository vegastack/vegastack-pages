import { Check, ChevronsUpDown, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

type Workspace = {
  id: string;
  name: string;
  slug: string;
};

type WorkspaceSwitcherProps = {
  current: Workspace;
  workspaces: Workspace[];
  pageCount: number;
  canCreate?: boolean;
  /**
   * Suppress the workspace name in the pill (only show meta).
   * Used when the workspace name matches the product name to avoid redundancy.
   */
  suppressName?: boolean;
};

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function WorkspaceSwitcher({
  current,
  workspaces,
  pageCount,
  canCreate = false,
  suppressName = false,
}: WorkspaceSwitcherProps) {
  const initials = initialsOf(current.name) || "WS";
  const meta = `${pageCount} ${pageCount === 1 ? "page" : "pages"}`;
  const primary = suppressName ? "Workspace" : current.name;
  const secondary = suppressName ? `${current.slug} · ${meta}` : meta;
  const hasOthers = workspaces.length > 1;

  if (!hasOthers && !canCreate) {
    return (
      <div
        className="vpg-workspace-pill"
        aria-label={`Current workspace ${current.name}`}
      >
        <span className="vpg-workspace-mark" aria-hidden="true">
          {initials}
        </span>
        <span className="vpg-workspace-text">
          <span className="vpg-workspace-name">{primary}</span>
          <span className="vpg-workspace-meta">{secondary}</span>
        </span>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="vpg-workspace-pill vpg-workspace-pill-button"
        aria-label={`Switch workspace, current ${current.name}`}
      >
        <span className="vpg-workspace-mark" aria-hidden="true">
          {initials}
        </span>
        <span className="vpg-workspace-text">
          <span className="vpg-workspace-name">{primary}</span>
          <span className="vpg-workspace-meta">{secondary}</span>
        </span>
        <ChevronsUpDown
          className="vpg-workspace-caret"
          size={14}
          aria-hidden="true"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="vpg-workspace-menu"
        align="start"
        side="bottom"
        sideOffset={6}
      >
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {workspaces.map((workspace) => {
          const isCurrent = workspace.id === current.id;
          return (
            <DropdownMenuItem key={workspace.id} asChild>
              <a
                href={`/app/settings/general?workspace_id=${encodeURIComponent(workspace.id)}`}
              >
                <span
                  className="vpg-workspace-mark vpg-workspace-mark-sm"
                  aria-hidden="true"
                >
                  {initialsOf(workspace.name) || "WS"}
                </span>
                <span className="vpg-workspace-menu-name">
                  {workspace.name}
                </span>
                {isCurrent && (
                  <Check
                    className="vpg-workspace-menu-check"
                    size={14}
                    aria-hidden="true"
                  />
                )}
              </a>
            </DropdownMenuItem>
          );
        })}
        {canCreate && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href="/app/signup">
                <Plus size={14} aria-hidden="true" />
                <span>New workspace</span>
              </a>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
