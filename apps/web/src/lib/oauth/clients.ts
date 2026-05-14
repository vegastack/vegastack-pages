import { d1All, d1Run, ensureRuntimeReady, runtimeIsD1 } from "../runtime";

export type OAuthClientRow = {
  id: string;
  clientName: string;
  redirectUris: string[];
  softwareId: string | null;
  softwareVersion: string | null;
  tokenEndpointAuthMethod: string;
  registeredUserAgent: string | null;
  registeredIp: string | null;
  createdAt: string;
  updatedAt: string;
};

const fallbackClients = new Map<string, OAuthClientRow>();

// Well-known client_id used by the @vegastack/pages CLI ("vpg") for the
// RFC 8628 device-code login flow. It is shipped baked into the binary so
// `vpg login` works against any VegaStack Pages deployment without a
// dynamic-registration round-trip. Public client (no secret), no redirect
// URIs (device flow has no browser callback), token_endpoint_auth_method=none.
export const VPG_CLI_CLIENT_ID = "oac_vpg_cli";

const VPG_CLI_CLIENT: OAuthClientRow = {
  id: VPG_CLI_CLIENT_ID,
  clientName: "VegaStack Pages CLI (vpg)",
  redirectUris: [],
  softwareId: "vpg-cli",
  softwareVersion: null,
  tokenEndpointAuthMethod: "none",
  registeredUserAgent: null,
  registeredIp: null,
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
};

// Well-known client_id used by Anthropic's claude.ai / claude.com connector
// broker. claude.ai POSTs a DCR request with these exact redirect URIs every
// time a user adds the connector — short-circuiting to a stable, pre-baked
// client_id lets us answer in milliseconds instead of doing a D1 INSERT, which
// matters because the broker times out around 1.5s and our cold-start
// INSERT-plus-audit-log path was running ~2s.
export const ANTHROPIC_CONNECTOR_CLIENT_ID = "oac_anthropic_connector";

const ANTHROPIC_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
] as const;

const ANTHROPIC_CONNECTOR_CLIENT: OAuthClientRow = {
  id: ANTHROPIC_CONNECTOR_CLIENT_ID,
  clientName: "Claude",
  redirectUris: [...ANTHROPIC_REDIRECT_URIS],
  softwareId: "anthropic-claude-ai-connector",
  softwareVersion: null,
  tokenEndpointAuthMethod: "none",
  registeredUserAgent: null,
  registeredIp: null,
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
};

// True when the incoming DCR payload looks like Anthropic's connector broker
// (every redirect_uri is one of the known callback URLs). The check is
// signature-based rather than UA-based because the broker's UA isn't stable.
export function matchesAnthropicConnector(input: {
  redirectUris: string[];
}): boolean {
  if (!Array.isArray(input.redirectUris) || input.redirectUris.length === 0) {
    return false;
  }
  return input.redirectUris.every((uri) =>
    (ANTHROPIC_REDIRECT_URIS as readonly string[]).includes(uri),
  );
}

type StoredRow = Omit<OAuthClientRow, "redirectUris"> & {
  redirectUrisJson: string;
};

function rowFromStored(row: StoredRow): OAuthClientRow {
  let redirectUris: string[] = [];
  try {
    const parsed = JSON.parse(row.redirectUrisJson);
    if (Array.isArray(parsed))
      redirectUris = parsed.filter((value) => typeof value === "string");
  } catch {
    redirectUris = [];
  }
  return {
    id: row.id,
    clientName: row.clientName,
    redirectUris,
    softwareId: row.softwareId,
    softwareVersion: row.softwareVersion,
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    registeredUserAgent: row.registeredUserAgent,
    registeredIp: row.registeredIp,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const SELECT = `SELECT
  id,
  client_name as clientName,
  redirect_uris_json as redirectUrisJson,
  software_id as softwareId,
  software_version as softwareVersion,
  token_endpoint_auth_method as tokenEndpointAuthMethod,
  registered_user_agent as registeredUserAgent,
  registered_ip as registeredIp,
  created_at as createdAt,
  updated_at as updatedAt
  FROM oauth_clients`;

function newClientId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `oac_${hex}`;
}

function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") {
      const host = url.hostname;
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host === "[::1]"
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export class OAuthClientRegistrationError extends Error {
  readonly oauthError: string;
  readonly status: number;
  constructor(
    message: string,
    oauthError = "invalid_redirect_uri",
    status = 400,
  ) {
    super(message);
    this.oauthError = oauthError;
    this.status = status;
  }
}

export async function registerOAuthClient(input: {
  clientName: string;
  redirectUris: string[];
  softwareId?: string | null;
  softwareVersion?: string | null;
  tokenEndpointAuthMethod?: string | null;
  registeredUserAgent?: string | null;
  registeredIp?: string | null;
}): Promise<OAuthClientRow> {
  await ensureRuntimeReady();
  const clientName = (input.clientName ?? "").trim();
  if (!clientName) {
    throw new OAuthClientRegistrationError(
      "client_name is required.",
      "invalid_client_metadata",
    );
  }
  if (!Array.isArray(input.redirectUris) || input.redirectUris.length === 0) {
    throw new OAuthClientRegistrationError(
      "redirect_uris must be a non-empty array.",
    );
  }
  for (const uri of input.redirectUris) {
    if (typeof uri !== "string" || !isAllowedRedirectUri(uri)) {
      throw new OAuthClientRegistrationError(
        `Invalid redirect_uri: ${uri}. Use https:// or http://127.0.0.1[:port] / http://localhost[:port].`,
      );
    }
  }
  const method = (input.tokenEndpointAuthMethod ?? "none").trim() || "none";
  if (method !== "none") {
    throw new OAuthClientRegistrationError(
      "Only token_endpoint_auth_method=none (public clients) is supported.",
      "invalid_client_metadata",
    );
  }
  const now = new Date().toISOString();
  const id = newClientId();
  const row: OAuthClientRow = {
    id,
    clientName,
    redirectUris: input.redirectUris,
    softwareId: input.softwareId ?? null,
    softwareVersion: input.softwareVersion ?? null,
    tokenEndpointAuthMethod: "none",
    registeredUserAgent: input.registeredUserAgent ?? null,
    registeredIp: input.registeredIp ?? null,
    createdAt: now,
    updatedAt: now,
  };
  fallbackClients.set(id, row);
  if (runtimeIsD1()) {
    await d1Run(
      "INSERT INTO oauth_clients (id, client_name, redirect_uris_json, software_id, software_version, token_endpoint_auth_method, registered_user_agent, registered_ip, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'none', ?, ?, ?, ?)",
      id,
      clientName,
      JSON.stringify(input.redirectUris),
      input.softwareId ?? null,
      input.softwareVersion ?? null,
      input.registeredUserAgent ?? null,
      input.registeredIp ?? null,
      now,
      now,
    );
  }
  return row;
}

export async function getOAuthClient(
  clientId: string,
): Promise<OAuthClientRow | null> {
  if (!clientId) return null;
  if (clientId === VPG_CLI_CLIENT_ID) return VPG_CLI_CLIENT;
  if (clientId === ANTHROPIC_CONNECTOR_CLIENT_ID)
    return ANTHROPIC_CONNECTOR_CLIENT;
  await ensureRuntimeReady();
  if (runtimeIsD1()) {
    const rows = await d1All<StoredRow>(
      `${SELECT} WHERE id = ? LIMIT 1`,
      clientId,
    );
    if (rows.length > 0) return rowFromStored(rows[0]!);
  }
  return fallbackClients.get(clientId) ?? null;
}

export function clientRedirectUriIsRegistered(
  client: OAuthClientRow,
  candidate: string,
): boolean {
  if (!client.redirectUris.includes(candidate)) {
    return loopbackRedirectIsRegistered(client, candidate);
  }
  return true;
}

function loopbackRedirectIsRegistered(
  client: OAuthClientRow,
  candidate: string,
): boolean {
  let candidateUrl: URL;
  try {
    candidateUrl = new URL(candidate);
  } catch {
    return false;
  }
  if (candidateUrl.protocol !== "http:") return false;
  const candidateHost = candidateUrl.hostname;
  const candidatePath = candidateUrl.pathname;
  if (
    candidateHost !== "127.0.0.1" &&
    candidateHost !== "localhost" &&
    candidateHost !== "::1" &&
    candidateHost !== "[::1]"
  ) {
    return false;
  }
  for (const registered of client.redirectUris) {
    try {
      const url = new URL(registered);
      if (url.protocol !== "http:") continue;
      if (url.hostname !== candidateHost) continue;
      if (url.pathname !== candidatePath) continue;
      return true;
    } catch {
      continue;
    }
  }
  return false;
}
