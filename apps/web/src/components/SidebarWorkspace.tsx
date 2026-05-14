import { Check, ChevronsUpDown, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { VegaStackMark } from "./VegaStackMark";

type Workspace = { id: string; name: string; slug: string };

type Props = {
  current: Workspace;
  workspaces: Workspace[];
};

function initialsOf(name: string) {
  return (
    name
      .split(/\s+/)
      .map((p) => p[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase() || "WS"
  );
}

/**
 * Compact workspace switcher for the sidebar head. Shows the VegaStack
 * brand mark + workspace name on a single line; opens a dropdown when
 * there are multiple workspaces so the user can switch. Per-workspace
 * initials still appear inside the dropdown so workspaces remain
 * distinguishable; the trigger uses the brand so the app shell carries a
 * consistent VegaStack identity.
 */
export function SidebarWorkspace({ current, workspaces }: Props) {
  const hasOthers = workspaces.length > 1;

  const Inner = (
    <>
      <VegaStackMark className="vpg-sidebar-workspace-mark" />
      <span className="vpg-sidebar-workspace-name">{current.name}</span>
      {hasOthers ? (
        <ChevronsUpDown
          className="vpg-sidebar-workspace-caret"
          aria-hidden="true"
        />
      ) : null}
    </>
  );

  if (!hasOthers) {
    return (
      <div
        className="vpg-sidebar-workspace"
        aria-label={`Current workspace ${current.name}`}
        style={{ cursor: "default" }}
      >
        {Inner}
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="vpg-sidebar-workspace"
        aria-label={`Switch workspace, current ${current.name}`}
      >
        {Inner}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="vpg-workspace-menu"
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
                  {initialsOf(workspace.name)}
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
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href="/app/signup">
            <Plus size={14} aria-hidden="true" />
            <span>New workspace</span>
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
