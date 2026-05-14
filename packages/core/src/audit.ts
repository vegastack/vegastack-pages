import { createId, idPrefixes } from "./ids";

export type AuditLogRecord = {
  id: string;
  workspaceId: string | null;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export class AuditService {
  private readonly logs: AuditLogRecord[] = [];

  record(input: Omit<AuditLogRecord, "id" | "createdAt">): AuditLogRecord {
    const log: AuditLogRecord = {
      id: createId(idPrefixes.auditLog),
      createdAt: new Date().toISOString(),
      ...input,
    };
    this.logs.push(log);
    return log;
  }

  list(
    input: { workspaceId?: string; limit?: number; afterId?: string } = {},
  ): AuditLogRecord[] {
    const logs = input.workspaceId
      ? this.logs.filter((log) => log.workspaceId === input.workspaceId)
      : [...this.logs];
    const startIndex = input.afterId
      ? logs.findIndex((log) => log.id === input.afterId) + 1
      : 0;
    return logs.slice(
      Math.max(startIndex, 0),
      input.limit ? startIndex + input.limit : undefined,
    );
  }
}
