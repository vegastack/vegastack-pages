export const eventNames = [
  "page.created",
  "page.updated",
  "page.deleted",
  "page.version_created",
  "comment.created",
  "comment.replied",
  "comment.resolved",
  "comment.unresolved",
  "publication.updated",
  "publication.revoked",
  "review.condition_met",
] as const;

export type EventName = (typeof eventNames)[number];

export type DomainEvent<
  TData extends Record<string, unknown> = Record<string, unknown>,
> = {
  event: EventName;
  id: string;
  workspace_id: string;
  page_id?: string;
  actor: {
    type: "user" | "guest" | "agent" | "system";
    id?: string;
    display_name?: string;
  };
  created_at: string;
  data: TData;
};
