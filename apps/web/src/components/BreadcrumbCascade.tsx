import { FileText, Folder } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export type BreadcrumbSibling = {
  id: string;
  name: string;
  href: string;
  isCurrent: boolean;
  isFolder: boolean;
  children?: BreadcrumbSibling[];
};

export type BreadcrumbSegment = {
  id: string;
  name: string;
  href: string;
  isCurrent: boolean;
  siblings: BreadcrumbSibling[];
  allChildrenHref?: string;
};

type Props = {
  workspaceName: string;
  workspaceHref: string;
  segments: BreadcrumbSegment[];
};

export function BreadcrumbCascade({
  workspaceName,
  workspaceHref,
  segments,
}: Props) {
  return (
    <nav className="vpg-breadcrumb" aria-label="Page breadcrumb">
      <a
        className="vpg-breadcrumb-segment"
        href={workspaceHref}
        aria-label={`Workspace ${workspaceName}`}
      >
        <span>{workspaceName}</span>
      </a>
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        return (
          <SegmentButton
            key={segment.id || `${index}-${segment.name}`}
            segment={segment}
            isLast={isLast}
          />
        );
      })}
    </nav>
  );
}

function SegmentButton({
  segment,
  isLast,
}: {
  segment: BreadcrumbSegment;
  isLast: boolean;
}) {
  const hasSiblings = segment.siblings.length > 0;
  const trigger = (
    <button
      type="button"
      className="vpg-breadcrumb-segment"
      data-current={segment.isCurrent ? "true" : undefined}
      aria-label={segment.name}
    >
      <span>{segment.name}</span>
    </button>
  );

  return (
    <>
      <span className="vpg-breadcrumb-sep" aria-hidden="true">
        /
      </span>
      {hasSiblings ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          <DropdownMenuContent
            className="vpg-breadcrumb-menu"
            align="start"
            sideOffset={6}
            collisionPadding={8}
          >
            {segment.siblings.map((sibling) => (
              <BreadcrumbMenuEntry key={sibling.id} item={sibling} />
            ))}
            {segment.allChildrenHref ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <a
                    href={segment.allChildrenHref}
                    className="vpg-breadcrumb-menu-all"
                  >
                    <Folder
                      className="vpg-breadcrumb-menu-icon"
                      size={14}
                      strokeWidth={1.9}
                      aria-hidden="true"
                    />
                    <span>Open {segment.name}</span>
                  </a>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <a
          className="vpg-breadcrumb-segment"
          href={segment.href}
          data-current={isLast ? "true" : undefined}
          aria-current={isLast ? "page" : undefined}
        >
          <span>{segment.name}</span>
        </a>
      )}
    </>
  );
}

function BreadcrumbMenuEntry({ item }: { item: BreadcrumbSibling }) {
  const children = item.children ?? [];
  const hasChildren = item.isFolder && children.length > 0;

  if (hasChildren) {
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger
          className="vpg-breadcrumb-menu-row"
          data-current={item.isCurrent ? "true" : undefined}
        >
          <BreadcrumbMenuIcon isFolder={item.isFolder} />
          <span className="vpg-breadcrumb-menu-label">{item.name}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          className="vpg-breadcrumb-menu vpg-breadcrumb-submenu"
          sideOffset={6}
          collisionPadding={8}
        >
          <DropdownMenuItem asChild>
            <a href={item.href} className="vpg-breadcrumb-menu-all">
              <BreadcrumbMenuIcon isFolder={item.isFolder} />
              <span>Open {item.name}</span>
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {children.map((child) => (
            <BreadcrumbMenuEntry key={child.id} item={child} />
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }

  return (
    <DropdownMenuItem
      asChild
      className="vpg-breadcrumb-menu-row"
      data-current={item.isCurrent ? "true" : undefined}
    >
      <a href={item.href}>
        <BreadcrumbMenuIcon isFolder={item.isFolder} />
        <span className="vpg-breadcrumb-menu-label">{item.name}</span>
      </a>
    </DropdownMenuItem>
  );
}

function BreadcrumbMenuIcon({ isFolder }: { isFolder: boolean }) {
  const Icon = isFolder ? Folder : FileText;
  return (
    <Icon
      className="vpg-breadcrumb-menu-icon"
      size={14}
      strokeWidth={1.9}
      aria-hidden="true"
    />
  );
}
