import { createId, idPrefixes } from "./ids";

export type ReviewEventType =
  | "comment.created"
  | "comment.replied"
  | "comment.resolved"
  | "comment.unresolved"
  | "page.created"
  | "page.updated"
  | "page.moved"
  | "page.version_created"
  | "publication.updated"
  | "publication.revoked"
  | "attachment.uploaded"
  | "review.condition_met";

export type ReviewEventRecord = {
  id: string;
  workspaceId: string;
  pageId: string | null;
  type: ReviewEventType;
  actorUserId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export class ReviewEventService {
  private readonly events: ReviewEventRecord[] = [];

  emit(input: Omit<ReviewEventRecord, "id" | "createdAt">): ReviewEventRecord {
    const event: ReviewEventRecord = {
      id: createId(idPrefixes.event),
      createdAt: new Date().toISOString(),
      ...input,
    };
    this.events.push(event);
    return event;
  }

  list(
    input: {
      workspaceId?: string;
      pageId?: string;
      afterId?: string | null;
      limit?: number;
    } = {},
  ): ReviewEventRecord[] {
    let events = this.events;
    if (input.workspaceId)
      events = events.filter(
        (event) => event.workspaceId === input.workspaceId,
      );
    if (input.pageId)
      events = events.filter((event) => event.pageId === input.pageId);
    if (input.afterId) {
      const index = events.findIndex((event) => event.id === input.afterId);
      events = index >= 0 ? events.slice(index + 1) : events;
    }
    return events.slice(-(input.limit ?? 50));
  }
}
