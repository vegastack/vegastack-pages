import { Share2 } from "lucide-react";

export type ShareButtonProps = {
  workspaceId: string;
  resourceId: string;
  resourceSlugId: string;
  resourceType?: "page" | "folder";
};

export function ShareButton({
  workspaceId,
  resourceId,
  resourceSlugId,
  resourceType = "page",
}: ShareButtonProps) {
  const resourceName = resourceType === "folder" ? "folder" : "page";
  return (
    <button
      className="vpg-pheader-btn vpg-pheader-share"
      type="button"
      aria-label={`Share ${resourceName}`}
      title={`Share ${resourceName}`}
      data-vpg-share-trigger
      data-workspace-id={workspaceId}
      data-resource-id={resourceId}
      data-resource-slug-id={resourceSlugId}
      data-resource-type={resourceType}
    >
      <Share2 size={15} aria-hidden="true" />
    </button>
  );
}
