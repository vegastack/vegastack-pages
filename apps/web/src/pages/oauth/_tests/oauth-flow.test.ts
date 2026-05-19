import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth, users, workspaces } from "@vegastack/pages-services";
import { buildServiceContext } from "../../../lib/service-context";
import {
  createMcpSession,
  findMcpSessionByRefreshToken,
  getMcpSession,
} from "../../../lib/runtime";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-oauth-flow-"));
});
import { POST as registerPost } from "../register";
import { GET as authorizeGet } from "../authorize";
import { POST as consentPost } from "../authorize/consent";
import { POST as tokenPost } from "../token";
import { POST as revokePost } from "../revoke";
import { POST as devicePost } from "../device";
import { GET as deviceVerifyGet } from "../device/verify";
import { GET as protectedResourceGet } from "../../.well-known/oauth-protected-resource";
import { GET as authServerGet } from "../../.well-known/oauth-authorization-server";
import { GET as authServerPathGet } from "../../.well-known/oauth-authorization-server/[...slug]";
import { POST as mcpPost } from "../../mcp";
import { base64UrlEncode } from "../../../lib/oauth/codes";

function uniqueId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function cookiesFor(sessionId: string | null) {
  const store = new Map<string, string>();
  if (sessionId) store.set("vpg_session", sessionId);
  return {
    get(name: string) {
      const value = store.get(name);
      return value !== undefined ? { value } : undefined;
    },
    set(name: string, value: string) {
      store.set(name, value);
    },
    delete(name: string) {
      store.delete(name);
    },
  } as never;
}

async function makePkcePair() {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64UrlEncode(verifierBytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

function basicClient(clientId: string, secret = "") {
  return `Basic ${btoa(`${encodeURIComponent(clientId)}:${secret}`)}`;
}

async function seedWorkspaceAndUser() {
  const tag = crypto.randomUUID().slice(0, 8);
  const { ctx: seedCtx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
  });
  const user = await users.upsert(seedCtx, {
    id: uniqueId("usr"),
    email: `oauth-test-${crypto.randomUUID()}@example.com`,
    displayName: "OAuth User",
    role: "user",
  });
  const workspace = await workspaces.create(seedCtx, {
    id: uniqueId("wks"),
    name: `OAuth Test ${tag}`,
    slug: uniqueId("slug"),
    firstAdminUserId: user.id,
  });
  return { workspace, user, seedCtx };
}

async function createBrowserSession(userId: string) {
  const { ctx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
  });
  return auth.createSession(ctx, { userId });
}

async function registerLocalClient(redirectUris: string[]) {
  const response = await registerPost({
    request: new Request("https://pages.example.test/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Test MCP Client",
        redirect_uris: redirectUris,
      }),
    }),
  } as never);
  expect(response.status).toBe(201);
  return (await response.json()) as {
    client_id: string;
    client_name: string;
    redirect_uris: string[];
  };
}

describe("OAuth discovery metadata", () => {
  it("/.well-known/oauth-protected-resource points at /mcp on the request origin", async () => {
    const response = await protectedResourceGet({
      request: new Request(
        "https://pages.example.test/.well-known/oauth-protected-resource",
      ),
    } as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      resource: string;
      authorization_servers: string[];
      bearer_methods_supported: string[];
    };
    expect(body.resource).toBe("https://pages.example.test/mcp");
    expect(body.authorization_servers).toEqual(["https://pages.example.test"]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("/.well-known/oauth-authorization-server advertises the full endpoint set", async () => {
    const response = await authServerGet({
      request: new Request(
        "https://pages.example.test/.well-known/oauth-authorization-server",
      ),
    } as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      revocation_endpoint: string;
      device_authorization_endpoint: string;
      response_types_supported: string[];
      grant_types_supported: string[];
      code_challenge_methods_supported: string[];
      token_endpoint_auth_methods_supported: string[];
    };
    expect(body.issuer).toBe("https://pages.example.test");
    expect(body.authorization_endpoint).toBe(
      "https://pages.example.test/oauth/authorize",
    );
    expect(body.token_endpoint).toBe("https://pages.example.test/oauth/token");
    expect(body.registration_endpoint).toBe(
      "https://pages.example.test/oauth/register",
    );
    expect(body.revocation_endpoint).toBe(
      "https://pages.example.test/oauth/revoke",
    );
    expect(body.device_authorization_endpoint).toBe(
      "https://pages.example.test/oauth/device",
    );
    expect(body.response_types_supported).toContain("code");
    expect(body.grant_types_supported).toContain("authorization_code");
    expect(body.grant_types_supported).toContain("refresh_token");
    expect(body.grant_types_supported).toContain(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });

  it("serves authorization-server metadata from path-derived MCP well-known URLs", async () => {
    const response = await authServerPathGet({
      request: new Request(
        "https://pages.example.test/.well-known/oauth-authorization-server/mcp",
      ),
    } as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      issuer: string;
      token_endpoint: string;
    };
    expect(body.issuer).toBe("https://pages.example.test");
    expect(body.token_endpoint).toBe("https://pages.example.test/oauth/token");
  });

  it("derives metadata from X-Forwarded-Host for reverse-proxied self-hosters when allowlisted", async () => {
    const previousBase = process.env.VPG_BASE_URL;
    const previousMcp = process.env.VPG_MCP_ALLOWED_HOSTS;
    process.env.VPG_BASE_URL = "https://docs.acme.test";
    try {
      const response = await protectedResourceGet({
        request: new Request(
          "http://internal.lan/.well-known/oauth-protected-resource",
          {
            headers: {
              "x-forwarded-host": "docs.acme.test",
              "x-forwarded-proto": "https",
            },
          },
        ),
      } as never);
      const body = (await response.json()) as { resource: string };
      expect(body.resource).toBe("https://docs.acme.test/mcp");
    } finally {
      if (previousBase === undefined) delete process.env.VPG_BASE_URL;
      else process.env.VPG_BASE_URL = previousBase;
      if (previousMcp === undefined) delete process.env.VPG_MCP_ALLOWED_HOSTS;
      else process.env.VPG_MCP_ALLOWED_HOSTS = previousMcp;
    }
  });

  it("ignores X-Forwarded-Host that is not in the allowlist", async () => {
    const response = await protectedResourceGet({
      request: new Request(
        "http://internal.lan/.well-known/oauth-protected-resource",
        {
          headers: {
            "x-forwarded-host": "attacker.example",
            "x-forwarded-proto": "https",
          },
        },
      ),
    } as never);
    const body = (await response.json()) as { resource: string };
    expect(body.resource).toBe("http://internal.lan/mcp");
  });
});

describe("Dynamic client registration", () => {
  it("registers a public client and rejects client_secret", async () => {
    const success = await registerLocalClient([
      "https://claude.ai/api/oauth/callback",
    ]);
    expect(success.client_id).toMatch(/^oac_/);
    expect(success.client_name).toBe("Test MCP Client");

    const withSecret = await registerPost({
      request: new Request("https://pages.example.test/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Bad",
          redirect_uris: ["https://example.test/cb"],
          client_secret: "should-not-be-allowed",
        }),
      }),
    } as never);
    expect(withSecret.status).toBe(400);
    const errBody = (await withSecret.json()) as { error: string };
    expect(errBody.error).toBe("invalid_client_metadata");
  });

  it("rejects non-loopback http:// redirect URIs", async () => {
    const response = await registerPost({
      request: new Request("https://pages.example.test/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Bad",
          redirect_uris: ["http://attacker.test/cb"],
        }),
      }),
    } as never);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("accepts loopback http:// for native/CLI clients (RFC 8252)", async () => {
    const response = await registerPost({
      request: new Request("https://pages.example.test/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "vpg CLI",
          redirect_uris: ["http://127.0.0.1/callback"],
        }),
      }),
    } as never);
    expect(response.status).toBe(201);
  });

  it("rejects empty redirect_uris", async () => {
    const response = await registerPost({
      request: new Request("https://pages.example.test/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Bad",
          redirect_uris: [],
        }),
      }),
    } as never);
    expect(response.status).toBe(400);
  });

  it("rejects token_endpoint_auth_method != none (no confidential clients)", async () => {
    const response = await registerPost({
      request: new Request("https://pages.example.test/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Confidential",
          redirect_uris: ["https://example.test/cb"],
          token_endpoint_auth_method: "client_secret_basic",
        }),
      }),
    } as never);
    expect(response.status).toBe(400);
  });
});

describe("Authorization code grant with PKCE", () => {
  it("issues an OAuth-kind session whose bearer authenticates against /mcp", async () => {
    const { workspace, user } = await seedWorkspaceAndUser();
    const client = await registerLocalClient([
      "https://claude.ai/oauth/callback",
    ]);
    const session = await createBrowserSession(user.id);
    const cookies = cookiesFor(session.id);
    const { verifier, challenge } = await makePkcePair();
    const state = "csrf-state-abc";

    const consentResponse = await consentPost({
      cookies,
      request: new Request(
        "https://pages.example.test/oauth/authorize/consent",
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            response_type: "code",
            client_id: client.client_id,
            redirect_uri: "https://claude.ai/oauth/callback",
            scope: "mcp",
            state,
            code_challenge: challenge,
            code_challenge_method: "S256",
            workspace_id: workspace.id,
            decision: "approve",
          }).toString(),
        },
      ),
    } as never);
    expect(consentResponse.status).toBe(303);
    const location = consentResponse.headers.get("location") ?? "";
    expect(location).toContain("https://claude.ai/oauth/callback");
    const callbackUrl = new URL(location);
    expect(callbackUrl.searchParams.get("state")).toBe(state);
    const code = callbackUrl.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResponse = await tokenPost({
      request: new Request("https://pages.example.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          redirect_uri: "https://claude.ai/oauth/callback",
          client_id: client.client_id,
          code_verifier: verifier,
        }).toString(),
      }),
    } as never);
    expect(tokenResponse.status).toBe(200);
    const tokenBody = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(tokenBody.token_type).toBe("Bearer");
    // access_token is the session id (mcs_*) — the bearer the client
    // returns on /mcp calls. refresh_token is a raw 64-char hex string
    // generated by the token endpoint; only its sha256 hash is stored.
    expect(tokenBody.access_token).toMatch(/^mcs_/);
    expect(tokenBody.refresh_token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenBody.expires_in).toBeGreaterThan(0);
    expect(tokenBody.scope).toBe("mcp");

    const issued = await getMcpSession(tokenBody.access_token);
    expect(issued).not.toBeNull();
    expect(issued?.kind).toBe("oauth");
    expect(issued?.workspaceId).toBe(workspace.id);
    expect(issued?.userId).toBe(user.id);

    // Use the access token at /mcp
    const initialize = await mcpPost({
      request: new Request("https://pages.example.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokenBody.access_token}`,
          host: "pages.example.test",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        }),
      }),
    } as never);
    expect(initialize.status).toBe(200);
    const initBody = (await initialize.json()) as {
      result?: { instructions?: string };
    };
    expect(initBody.result?.instructions).toMatch(/VegaStack Pages MCP/);
  });

  it("rejects a reused authorization code (single-use)", async () => {
    const { workspace, user } = await seedWorkspaceAndUser();
    const client = await registerLocalClient(["https://example.test/cb"]);
    const cookies = cookiesFor((await createBrowserSession(user.id)).id);
    const { verifier, challenge } = await makePkcePair();

    const consent = await consentPost({
      cookies,
      request: new Request(
        "https://pages.example.test/oauth/authorize/consent",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            response_type: "code",
            client_id: client.client_id,
            redirect_uri: "https://example.test/cb",
            scope: "mcp",
            state: "s1",
            code_challenge: challenge,
            code_challenge_method: "S256",
            workspace_id: workspace.id,
            decision: "approve",
          }).toString(),
        },
      ),
    } as never);
    const code = new URL(consent.headers.get("location")!).searchParams.get(
      "code",
    )!;

    const first = await tokenPost({
      request: new Request("https://pages.example.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://example.test/cb",
          client_id: client.client_id,
          code_verifier: verifier,
        }).toString(),
      }),
    } as never);
    expect(first.status).toBe(200);
    const reuse = await tokenPost({
      request: new Request("https://pages.example.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://example.test/cb",
          client_id: client.client_id,
          code_verifier: verifier,
        }).toString(),
      }),
    } as never);
    expect(reuse.status).toBe(400);
    const body = (await reuse.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("accepts public client_id from an empty-secret Basic auth header", async () => {
    const { workspace, user } = await seedWorkspaceAndUser();
    const client = await registerLocalClient(["https://example.test/cb"]);
    const cookies = cookiesFor((await createBrowserSession(user.id)).id);
    const { verifier, challenge } = await makePkcePair();

    const consent = await consentPost({
      cookies,
      request: new Request(
        "https://pages.example.test/oauth/authorize/consent",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            response_type: "code",
            client_id: client.client_id,
            redirect_uri: "https://example.test/cb",
            scope: "mcp",
            state: "basic-client",
            code_challenge: challenge,
            code_challenge_method: "S256",
            workspace_id: workspace.id,
            decision: "approve",
          }).toString(),
        },
      ),
    } as never);
    const code = new URL(consent.headers.get("location")!).searchParams.get(
      "code",
    )!;

    const exchange = await tokenPost({
      request: new Request("https://pages.example.test/oauth/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: basicClient(client.client_id),
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://example.test/cb",
          code_verifier: verifier,
        }).toString(),
      }),
    } as never);
    expect(exchange.status).toBe(200);
    const body = (await exchange.json()) as { access_token: string };
    expect(body.access_token).toMatch(/^mcs_/);
  });

  it("rejects a PKCE verifier that does not match the challenge", async () => {
    const { workspace, user } = await seedWorkspaceAndUser();
    const client = await registerLocalClient(["https://example.test/cb"]);
    const cookies = cookiesFor((await createBrowserSession(user.id)).id);
    const { challenge } = await makePkcePair();
    const wrongVerifier = "definitely-not-the-real-one";

    const consent = await consentPost({
      cookies,
      request: new Request(
        "https://pages.example.test/oauth/authorize/consent",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            response_type: "code",
            client_id: client.client_id,
            redirect_uri: "https://example.test/cb",
            scope: "mcp",
            state: "s2",
            code_challenge: challenge,
            code_challenge_method: "S256",
            workspace_id: workspace.id,
            decision: "approve",
          }).toString(),
        },
      ),
    } as never);
    const code = new URL(consent.headers.get("location")!).searchParams.get(
      "code",
    )!;

    const exchange = await tokenPost({
      request: new Request("https://pages.example.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://example.test/cb",
          client_id: client.client_id,
          code_verifier: wrongVerifier,
        }).toString(),
      }),
    } as never);
    expect(exchange.status).toBe(400);
    const body = (await exchange.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("rejects authorize/consent when the user denies", async () => {
    const { workspace, user } = await seedWorkspaceAndUser();
    const client = await registerLocalClient(["https://example.test/cb"]);
    const cookies = cookiesFor((await createBrowserSession(user.id)).id);
    const { challenge } = await makePkcePair();

    const denied = await consentPost({
      cookies,
      request: new Request(
        "https://pages.example.test/oauth/authorize/consent",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            response_type: "code",
            client_id: client.client_id,
            redirect_uri: "https://example.test/cb",
            scope: "mcp",
            state: "deny-state",
            code_challenge: challenge,
            code_challenge_method: "S256",
            workspace_id: workspace.id,
            decision: "deny",
          }).toString(),
        },
      ),
    } as never);
    expect(denied.status).toBe(303);
    const location = new URL(denied.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("deny-state");
  });

  it("requires an authenticated session at consent submission", async () => {
    const { workspace } = await seedWorkspaceAndUser();
    const client = await registerLocalClient(["https://example.test/cb"]);
    const { challenge } = await makePkcePair();

    const response = await consentPost({
      cookies: cookiesFor(null),
      request: new Request(
        "https://pages.example.test/oauth/authorize/consent",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            response_type: "code",
            client_id: client.client_id,
            redirect_uri: "https://example.test/cb",
            scope: "mcp",
            state: "no-sess",
            code_challenge: challenge,
            code_challenge_method: "S256",
            workspace_id: workspace.id,
            decision: "approve",
          }).toString(),
        },
      ),
    } as never);
    expect(response.status).toBe(401);
  });
});

describe("Refresh token rotation and revoke", () => {
  it("rotates the access + refresh token and invalidates the old refresh", async () => {
    const { workspace, user } = await seedWorkspaceAndUser();
    const client = await registerLocalClient(["https://example.test/cb"]);
    const cookies = cookiesFor((await createBrowserSession(user.id)).id);
    const { verifier, challenge } = await makePkcePair();

    const consent = await consentPost({
      cookies,
      request: new Request(
        "https://pages.example.test/oauth/authorize/consent",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            response_type: "code",
            client_id: client.client_id,
            redirect_uri: "https://example.test/cb",
            scope: "mcp",
            state: "r1",
            code_challenge: challenge,
            code_challenge_method: "S256",
            workspace_id: workspace.id,
            decision: "approve",
          }).toString(),
        },
      ),
    } as never);
    const code = new URL(consent.headers.get("location")!).searchParams.get(
      "code",
    )!;

    const exchange = await tokenPost({
      request: new Request("https://pages.example.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://example.test/cb",
          client_id: client.client_id,
          code_verifier: verifier,
        }).toString(),
      }),
    } as never);
    const issued = (await exchange.json()) as {
      access_token: string;
      refresh_token: string;
    };

    const refreshed = await tokenPost({
      request: new Request("https://pages.example.test/oauth/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: basicClient(client.client_id),
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: issued.refresh_token,
        }).toString(),
      }),
    } as never);
    expect(refreshed.status).toBe(200);
    const rotated = (await refreshed.json()) as {
      access_token: string;
      refresh_token: string;
    };
    // The new rotateTokens contract keeps the session id (i.e. the
    // access_token) stable but rotates the refresh token. The session's
    // expires_at and refresh_token_hash both change atomically.
    expect(rotated.access_token).toBe(issued.access_token);
    expect(rotated.refresh_token).not.toBe(issued.refresh_token);

    // The new refresh token must resolve via the lookup helper. Verify
    // this BEFORE attempting replay — replay-detection (RFC 6749 §10.4)
    // revokes the entire session chain on a stale-token redemption, so
    // any post-replay lookup would correctly return null.
    const found = await findMcpSessionByRefreshToken(rotated.refresh_token);
    expect(found).not.toBeNull();

    // The old refresh token must no longer succeed. With replay
    // detection, this also revokes the session chain — the new token
    // becomes unusable afterward as well, which is the desired security
    // posture for a compromised token.
    const replay = await tokenPost({
      request: new Request("https://pages.example.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: issued.refresh_token,
          client_id: client.client_id,
        }).toString(),
      }),
    } as never);
    expect(replay.status).toBe(400);
    const replayBody = (await replay.json()) as { error: string };
    expect(replayBody.error).toBe("invalid_grant");

    // After replay detection fires, the session chain is revoked — the
    // new refresh token must now also be unusable.
    const postReplay = await findMcpSessionByRefreshToken(
      rotated.refresh_token,
    );
    expect(postReplay).toBeNull();
  });

  it("revokes a session by access token; subsequent /mcp calls return 401", async () => {
    const { workspace, user } = await seedWorkspaceAndUser();
    const created = await createMcpSession({
      workspaceId: workspace.id,
      userId: user.id,
      clientName: "revoke-test",
      kind: "manual",
    });

    const revoke = await revokePost({
      request: new Request("https://pages.example.test/oauth/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: created.rawToken,
        }).toString(),
      }),
    } as never);
    expect(revoke.status).toBe(200);

    const after = await getMcpSession(created.rawToken);
    expect(after).toBeNull();
  });
});

describe("/mcp 401 + CORS + Host validation", () => {
  it("returns RFC 9728 resource_metadata in WWW-Authenticate on 401", async () => {
    delete process.env.VPG_DEV_AUTO_LOGIN;
    process.env.VPG_MCP_AUTH_REQUIRED = "true";
    try {
      const response = await mcpPost({
        request: new Request("https://pages.example.test/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            host: "pages.example.test",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {},
          }),
        }),
      } as never);
      expect(response.status).toBe(401);
      const wwwAuth = response.headers.get("www-authenticate") ?? "";
      expect(wwwAuth).toContain(`resource_metadata="`);
      expect(wwwAuth).toContain(`/.well-known/oauth-protected-resource`);
      expect(wwwAuth).toContain(`error="invalid_token"`);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      delete process.env.VPG_MCP_AUTH_REQUIRED;
    }
  });

  it("rejects mismatched Host headers (DNS rebinding shape)", async () => {
    const response = await mcpPost({
      request: new Request("https://pages.example.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "attacker.test",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        }),
      }),
    } as never);
    expect(response.status).toBe(403);
  });

  it("accepts cross-origin requests (bearer-only, no CSRF surface)", async () => {
    const { workspace, user } = await seedWorkspaceAndUser();
    const created = await createMcpSession({
      workspaceId: workspace.id,
      userId: user.id,
      clientName: "cors-test",
      kind: "manual",
    });
    const response = await mcpPost({
      request: new Request("https://pages.example.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${created.rawToken}`,
          origin: "https://claude.ai",
          host: "pages.example.test",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        }),
      }),
    } as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("Device authorization grant", () => {
  it("redirects unauthenticated verification to an absolute login URL", async () => {
    const response = await deviceVerifyGet({
      cookies: cookiesFor(null),
      url: new URL(
        "https://pages.example.test/oauth/device/verify?user_code=ABCD-EFGH",
      ),
    } as never);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://pages.example.test/app/login?redirect_to=%2Foauth%2Fdevice%2Fverify%3Fuser_code%3DABCD-EFGH",
    );
  });

  it("issues a device_code + user_code; approval lets the CLI redeem", async () => {
    const { workspace, user } = await seedWorkspaceAndUser();
    const client = await registerLocalClient(["http://127.0.0.1/callback"]);
    const deviceResp = await devicePost({
      request: new Request("https://pages.example.test/oauth/device", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.client_id,
          scope: "mcp",
        }).toString(),
      }),
    } as never);
    if (deviceResp.status !== 200) {
      const errorBody = await deviceResp.clone().text();
      throw new Error(
        `Device request failed: ${deviceResp.status} ${errorBody}`,
      );
    }
    const device = (await deviceResp.json()) as {
      device_code: string;
      user_code: string;
      interval: number;
      verification_uri: string;
    };
    expect(device.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(device.interval).toBeGreaterThan(0);

    // Before approval: authorization_pending.
    const pending = await tokenPost({
      request: new Request("https://pages.example.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
          client_id: client.client_id,
        }).toString(),
      }),
    } as never);
    expect(pending.status).toBe(400);
    expect(((await pending.json()) as { error: string }).error).toBe(
      "authorization_pending",
    );

    // Approve via the helper directly (we don't render the HTML page in this test).
    const { approveDeviceCode } = await import("../../../lib/oauth/codes");
    expect(
      await approveDeviceCode({
        userCode: device.user_code,
        userId: user.id,
        workspaceId: workspace.id,
      }),
    ).toBe(true);

    // Wait past the polling interval before redeeming.
    await new Promise((resolve) =>
      setTimeout(resolve, (device.interval + 1) * 1000),
    );
    const granted = await tokenPost({
      request: new Request("https://pages.example.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
          client_id: client.client_id,
        }).toString(),
      }),
    } as never);
    expect(granted.status).toBe(200);
    const grantBody = (await granted.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(grantBody.access_token).toMatch(/^mcs_/);
    expect(grantBody.refresh_token).toMatch(/^[0-9a-f]{64}$/);

    // Re-redemption fails after consumption.
    const reuse = await tokenPost({
      request: new Request("https://pages.example.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
          client_id: client.client_id,
        }).toString(),
      }),
    } as never);
    expect(reuse.status).toBe(400);
  }, 15_000);

  it("accepts the well-known vpg-cli client_id without registration and returns workspace_id", async () => {
    const { workspace, user } = await seedWorkspaceAndUser();
    const deviceResp = await devicePost({
      request: new Request("https://pages.example.test/oauth/device", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "oac_vpg_cli",
          scope: "mcp",
        }).toString(),
      }),
    } as never);
    expect(deviceResp.status).toBe(200);
    const device = (await deviceResp.json()) as {
      device_code: string;
      user_code: string;
      interval: number;
    };

    const { approveDeviceCode } = await import("../../../lib/oauth/codes");
    expect(
      await approveDeviceCode({
        userCode: device.user_code,
        userId: user.id,
        workspaceId: workspace.id,
      }),
    ).toBe(true);

    await new Promise((resolve) =>
      setTimeout(resolve, (device.interval + 1) * 1000),
    );
    const granted = await tokenPost({
      request: new Request("https://pages.example.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
          client_id: "oac_vpg_cli",
        }).toString(),
      }),
    } as never);
    expect(granted.status).toBe(200);
    const body = (await granted.json()) as {
      access_token: string;
      refresh_token: string;
      workspace_id: string;
    };
    expect(body.access_token).toMatch(/^mcs_/);
    expect(body.workspace_id).toBe(workspace.id);
  }, 15_000);
});

describe("Authorize GET flow", () => {
  beforeEach(() => {
    delete process.env.VPG_DEV_AUTO_LOGIN;
  });

  it("renders a consent page with the chosen vendor label and workspace picker", async () => {
    const { workspace, user } = await seedWorkspaceAndUser();
    const client = await registerLocalClient([
      "https://claude.ai/oauth/callback",
    ]);
    const session = await createBrowserSession(user.id);
    const { challenge } = await makePkcePair();
    const url = new URL(
      `https://pages.example.test/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("https://claude.ai/oauth/callback")}&scope=mcp&state=xyz&code_challenge=${challenge}&code_challenge_method=S256`,
    );
    const response = await authorizeGet({
      cookies: cookiesFor(session.id),
      url,
      request: new Request(url.toString()),
    } as never);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Claude wants to access VegaStack Pages");
    expect(html).toContain(workspace.name);
    expect(html).toContain("Allow Claude");
  });

  it("redirects to login when no session cookie is present", async () => {
    const client = await registerLocalClient([
      "https://claude.ai/oauth/callback",
    ]);
    const { challenge } = await makePkcePair();
    const url = new URL(
      `https://pages.example.test/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("https://claude.ai/oauth/callback")}&scope=mcp&state=xyz&code_challenge=${challenge}&code_challenge_method=S256`,
    );
    const response = await authorizeGet({
      cookies: cookiesFor(null),
      url,
      request: new Request(url.toString()),
    } as never);
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("redirect_to=");
    expect(decodeURIComponent(location)).toContain(
      "/oauth/authorize?response_type=code",
    );
  });

  it("rejects unknown client_id with an HTML error", async () => {
    const { challenge } = await makePkcePair();
    const url = new URL(
      `https://pages.example.test/oauth/authorize?response_type=code&client_id=oac_does_not_exist&redirect_uri=${encodeURIComponent("https://claude.ai/oauth/callback")}&scope=mcp&state=xyz&code_challenge=${challenge}&code_challenge_method=S256`,
    );
    const response = await authorizeGet({
      cookies: cookiesFor(null),
      url,
      request: new Request(url.toString()),
    } as never);
    expect(response.status).toBe(400);
    expect((await response.text()).toLowerCase()).toContain("unknown client");
  });

  it("rejects an unregistered redirect_uri (open-redirect guard)", async () => {
    const { user } = await seedWorkspaceAndUser();
    const client = await registerLocalClient([
      "https://claude.ai/oauth/callback",
    ]);
    const session = await createBrowserSession(user.id);
    const { challenge } = await makePkcePair();
    const url = new URL(
      `https://pages.example.test/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("https://attacker.test/cb")}&scope=mcp&state=xyz&code_challenge=${challenge}&code_challenge_method=S256`,
    );
    const response = await authorizeGet({
      cookies: cookiesFor(session.id),
      url,
      request: new Request(url.toString()),
    } as never);
    expect(response.status).toBe(400);
    expect((await response.text()).toLowerCase()).toContain(
      "invalid redirect_uri",
    );
  });
});
