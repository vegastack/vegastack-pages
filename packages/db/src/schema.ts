import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
};

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    role: text("role", { enum: ["user", "instance_admin"] })
      .notNull()
      .default("user"),
    ...timestamps,
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const authIdentities = sqliteTable(
  "auth_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["email", "google"] }).notNull(),
    providerSubject: text("provider_subject").notNull(),
    email: text("email").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("auth_identities_provider_subject_unique").on(
      table.provider,
      table.providerSubject,
    ),
    index("auth_identities_user_idx").on(table.userId),
  ],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("auth_sessions_user_idx").on(table.userId)],
);

export const magicLinks = sqliteTable(
  "magic_links",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    redirectTo: text("redirect_to").notNull().default("/"),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("magic_links_token_hash_unique").on(table.tokenHash),
    index("magic_links_email_idx").on(table.email),
  ],
);

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    versionRetentionDays: integer("version_retention_days"),
    ...timestamps,
  },
  (table) => [uniqueIndex("workspaces_slug_unique").on(table.slug)],
);

export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", {
      enum: ["reader", "commenter", "editor", "admin"],
    }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("workspace_members_workspace_user_unique").on(
      table.workspaceId,
      table.userId,
    ),
    index("workspace_members_user_idx").on(table.userId),
  ],
);

export const permissions = sqliteTable(
  "permissions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subjectType: text("subject_type", { enum: ["user"] }).notNull(),
    subjectId: text("subject_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["workspace", "folder", "page"] }).notNull(),
    targetId: text("target_id").notNull(),
    level: text("level", {
      enum: ["none", "read", "comment", "write", "admin"],
    }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("permissions_subject_scope_unique").on(
      table.workspaceId,
      table.subjectType,
      table.subjectId,
      table.scope,
      table.targetId,
    ),
    index("permissions_workspace_subject_idx").on(
      table.workspaceId,
      table.subjectId,
    ),
  ],
);

export const folders = sqliteTable(
  "folders",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentFolderId: text("parent_folder_id"),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    slugId: text("slug_id").notNull(),
    path: text("path").notNull(),
    position: integer("position").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("folders_slug_id_unique").on(table.slugId),
    index("folders_workspace_parent_idx").on(
      table.workspaceId,
      table.parentFolderId,
    ),
  ],
);

export const pages = sqliteTable(
  "pages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    folderId: text("folder_id").references(() => folders.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    slugId: text("slug_id").notNull(),
    sourceType: text("source_type", {
      enum: ["markdown", "mdx", "html"],
    }).notNull(),
    objectKeyCurrent: text("object_key_current").notNull(),
    frontmatterJson: text("frontmatter_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    contentHash: text("content_hash").notNull(),
    versionId: text("version_id"),
    renderCacheKey: text("render_cache_key"),
    position: integer("position").notNull().default(1),
    deletedAt: text("deleted_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("pages_slug_id_unique").on(table.slugId),
    index("pages_workspace_folder_idx").on(table.workspaceId, table.folderId),
  ],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    pageId: text("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("attachments_page_idx").on(table.pageId),
    index("attachments_workspace_idx").on(table.workspaceId),
  ],
);

export const pageFavorites = sqliteTable(
  "page_favorites",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    pageId: text("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("page_favorites_user_page_unique").on(
      table.userId,
      table.pageId,
    ),
    index("page_favorites_user_workspace_idx").on(
      table.userId,
      table.workspaceId,
      table.createdAt,
    ),
    index("page_favorites_page_idx").on(table.pageId),
  ],
);

export const workspaceTemplates = sqliteTable(
  "workspace_templates",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull().default("general"),
    sourceType: text("source_type", {
      enum: ["markdown", "mdx"],
    })
      .notNull()
      .default("markdown"),
    objectKeyCurrent: text("object_key_current").notNull(),
    contentHash: text("content_hash").notNull(),
    versionId: text("version_id").notNull(),
    propertiesJson: text("properties_json", { mode: "json" })
      .$type<unknown[]>()
      .notNull()
      .default([]),
    isBuiltin: integer("is_builtin", { mode: "boolean" })
      .notNull()
      .default(false),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    deletedAt: text("deleted_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("workspace_templates_slug_unique").on(
      table.workspaceId,
      table.slug,
    ),
    index("workspace_templates_workspace_idx").on(table.workspaceId),
  ],
);

export const workspaceTemplateVersions = sqliteTable(
  "workspace_template_versions",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id")
      .notNull()
      .references(() => workspaceTemplates.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull(),
    sourceHash: text("source_hash").notNull(),
    sourceType: text("source_type", {
      enum: ["markdown", "mdx"],
    }).notNull(),
    propertiesJson: text("properties_json", { mode: "json" })
      .$type<unknown[]>()
      .notNull()
      .default([]),
    label: text("label"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("workspace_template_versions_template_idx").on(table.templateId),
  ],
);

export const pageVersions = sqliteTable(
  "page_versions",
  {
    id: text("id").primaryKey(),
    pageId: text("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull(),
    sourceHash: text("source_hash").notNull(),
    sourceType: text("source_type", {
      enum: ["markdown", "mdx", "html"],
    }).notNull(),
    label: text("label"),
    createdReason: text("created_reason", {
      enum: ["manual", "time_checkpoint", "share_milestone", "system"],
    }).notNull(),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("page_versions_page_idx").on(table.pageId)],
);

export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    id: text("id").primaryKey(),
    clientName: text("client_name").notNull(),
    redirectUrisJson: text("redirect_uris_json").notNull(),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method")
      .notNull()
      .default("none"),
    registeredUserAgent: text("registered_user_agent"),
    registeredIp: text("registered_ip"),
    ...timestamps,
  },
  (table) => [index("oauth_clients_client_name_idx").on(table.clientName)],
);

export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientName: text("client_name").notNull(),
    clientVersion: text("client_version"),
    model: text("model"),
    lastSeenAt: text("last_seen_at").notNull(),
    kind: text("kind", { enum: ["manual", "cli", "oauth"] })
      .notNull()
      .default("manual"),
    userAgent: text("user_agent"),
    lastOrigin: text("last_origin"),
    oauthClientId: text("oauth_client_id").references(() => oauthClients.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    index("agent_sessions_workspace_user_idx").on(
      table.workspaceId,
      table.userId,
    ),
    index("agent_sessions_kind_idx").on(table.kind),
  ],
);

export const mcpSessions = sqliteTable(
  "mcp_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    agentSessionId: text("agent_session_id").references(
      () => agentSessions.id,
      { onDelete: "set null" },
    ),
    protocolVersion: text("protocol_version"),
    expiresAt: text("expires_at"),
    refreshTokenHash: text("refresh_token_hash"),
    refreshTokenExpiresAt: text("refresh_token_expires_at"),
    scope: text("scope"),
    ...timestamps,
  },
  (table) => [
    index("mcp_sessions_workspace_user_idx").on(
      table.workspaceId,
      table.userId,
    ),
    uniqueIndex("mcp_sessions_refresh_hash_unique").on(table.refreshTokenHash),
  ],
);

export const oauthGrants = sqliteTable(
  "oauth_grants",
  {
    codeHash: text("code_hash").primaryKey(),
    kind: text("kind", { enum: ["auth_code", "device_code"] }).notNull(),
    status: text("status", {
      enum: ["pending", "approved", "denied", "consumed"],
    })
      .notNull()
      .default("pending"),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    scope: text("scope"),
    redirectUri: text("redirect_uri"),
    codeChallenge: text("code_challenge"),
    codeChallengeMethod: text("code_challenge_method"),
    userCode: text("user_code"),
    lastPolledAt: text("last_polled_at"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("oauth_grants_expires_idx").on(table.expiresAt),
    index("oauth_grants_kind_status_idx").on(table.kind, table.status),
    uniqueIndex("oauth_grants_user_code_unique").on(table.userCode),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    type: text("type").notNull(),
    status: text("status", {
      enum: ["queued", "running", "complete", "failed"],
    }).notNull(),
    payloadJson: text("payload_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    resultJson: text("result_json", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
    errorJson: text("error_json", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
    ...timestamps,
  },
  (table) => [
    index("jobs_workspace_status_idx").on(table.workspaceId, table.status),
  ],
);

export const commentThreads = sqliteTable(
  "comment_threads",
  {
    id: text("id").primaryKey(),
    pageId: text("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["open", "resolved"] })
      .notNull()
      .default("open"),
    selectedText: text("selected_text").notNull(),
    guestName: text("guest_name"),
    guestSessionId: text("guest_session_id"),
    publicationId: text("publication_id"),
    resolvedAt: text("resolved_at"),
    ...timestamps,
  },
  (table) => [
    index("comment_threads_page_status_idx").on(table.pageId, table.status),
  ],
);

export const commentAnchors = sqliteTable("comment_anchors", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => commentThreads.id, { onDelete: "cascade" }),
  sourceStart: integer("source_start"),
  sourceEnd: integer("source_end"),
  renderedDomPath: text("rendered_dom_path"),
  selectedText: text("selected_text").notNull(),
  prefixText: text("prefix_text").notNull(),
  suffixText: text("suffix_text").notNull(),
  contentHashAtCreation: text("content_hash_at_creation").notNull(),
  reanchorStatus: text("reanchor_status", {
    enum: ["active", "reanchored", "stale"],
  })
    .notNull()
    .default("active"),
  anchorKind: text("anchor_kind", { enum: ["text", "point"] })
    .notNull()
    .default("text"),
  surface: text("surface", { enum: ["prose", "html"] })
    .notNull()
    .default("prose"),
  selectorJson: text("selector_json"),
  confidence: text("confidence", {
    enum: ["active", "reanchored", "fuzzy", "manual", "stale"],
  })
    .notNull()
    .default("active"),
});

export const commentReplies = sqliteTable(
  "comment_replies",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => commentThreads.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    authorType: text("author_type", {
      enum: ["user", "guest", "agent"],
    }).notNull(),
    authorUserId: text("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    guestName: text("guest_name"),
    guestSessionId: text("guest_session_id"),
    publicationId: text("publication_id"),
    agentName: text("agent_name"),
    agentModel: text("agent_model"),
    agentSessionId: text("agent_session_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("comment_replies_thread_idx").on(table.threadId)],
);

export const publications = sqliteTable(
  "publications",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    resourceType: text("resource_type", { enum: ["page", "folder"] }).notNull(),
    resourceId: text("resource_id").notNull(),
    permission: text("permission", { enum: ["view", "comment", "edit"] })
      .notNull()
      .default("view"),
    expiresAt: text("expires_at"),
    passwordHash: text("password_hash"),
    indexingEnabled: integer("indexing_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    revokedAt: text("revoked_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("publications_resource_unique").on(
      table.workspaceId,
      table.resourceType,
      table.resourceId,
    ),
    index("publications_workspace_idx").on(table.workspaceId),
  ],
);

export const searchDocuments = sqliteTable(
  "search_documents",
  {
    resourceType: text("resource_type", {
      enum: ["page", "folder", "comment_thread"],
    }).notNull(),
    resourceId: text("resource_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    pageId: text("page_id").references(() => pages.id, { onDelete: "cascade" }),
    folderId: text("folder_id").references(() => folders.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    path: text("path").notNull(),
    headingsText: text("headings_text").notNull().default(""),
    frontmatterText: text("frontmatter_text").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    commentText: text("comment_text").notNull().default(""),
    tags: text("tags").notNull().default(""),
    url: text("url").notNull().default(""),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.resourceType, table.resourceId] }),
    index("search_documents_workspace_idx").on(
      table.workspaceId,
      table.resourceType,
      table.updatedAt,
    ),
  ],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    metadataJson: text("metadata_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("audit_logs_workspace_idx").on(table.workspaceId)],
);

export const reviewEvents = sqliteTable(
  "review_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    pageId: text("page_id").references(() => pages.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    payloadJson: text("payload_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("review_events_workspace_idx").on(table.workspaceId),
    index("review_events_page_idx").on(table.pageId),
  ],
);

export const setupState = sqliteTable("setup_state", {
  key: text("key").primaryKey(),
  setupComplete: integer("setup_complete", { mode: "boolean" })
    .notNull()
    .default(false),
  firstAdminUserId: text("first_admin_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  firstWorkspaceId: text("first_workspace_id").references(() => workspaces.id, {
    onDelete: "set null",
  }),
  updatedAt: text("updated_at").notNull(),
});

export const rateLimits = sqliteTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    resetAt: text("reset_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("rate_limits_reset_idx").on(table.resetAt)],
);

export const runtimeLocks = sqliteTable("runtime_locks", {
  key: text("key").primaryKey(),
  owner: text("owner").notNull(),
  expiresAt: text("expires_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const githubSyncConnections = sqliteTable(
  "github_sync_connections",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    installationId: integer("installation_id").notNull(),
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    repoId: integer("repo_id"),
    branch: text("branch"),
    rootPath: text("root_path").notNull().default("docs"),
    includeAssets: integer("include_assets", { mode: "boolean" })
      .notNull()
      .default(false),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    lastStatus: text("last_status", {
      enum: ["pending", "success", "failed", "idle"],
    })
      .notNull()
      .default("idle"),
    lastSyncedAt: text("last_synced_at"),
    lastCommitSha: text("last_commit_sha"),
    lastError: text("last_error"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("github_sync_connections_workspace_unique").on(
      table.workspaceId,
    ),
    index("github_sync_connections_installation_idx").on(table.installationId),
  ],
);

export const githubSyncRuns = sqliteTable(
  "github_sync_runs",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => githubSyncConnections.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["running", "success", "failed"],
    }).notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    baseCommitSha: text("base_commit_sha"),
    headCommitSha: text("head_commit_sha"),
    pagesWritten: integer("pages_written").notNull().default(0),
    templatesWritten: integer("templates_written").notNull().default(0),
    assetsWritten: integer("assets_written").notNull().default(0),
    filesDeleted: integer("files_deleted").notNull().default(0),
    errorJson: text("error_json"),
  },
  (table) => [
    index("github_sync_runs_connection_idx").on(
      table.connectionId,
      table.startedAt,
    ),
    index("github_sync_runs_workspace_idx").on(table.workspaceId),
  ],
);
