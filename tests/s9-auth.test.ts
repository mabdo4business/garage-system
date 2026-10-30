import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, resetPassword } from "../src/server/auth/service";
import { NotFoundError } from "../src/server/core/errors";
import { hashToken, SESSION_COOKIE } from "../src/server/auth/session";
import { logger, REDACTED, setLogSink } from "../src/server/core/logger";
import { createHandlers } from "../src/server/http/handlers";
import { createTestDatabase, type TestDatabase } from "./helpers/db";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

const BASE = "http://localhost:3000";

function form(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
}

function jsonRequest(path: string, body: unknown, token?: string, headers: Record<string, string> = {}) {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(token ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } : {}),
      ...headers,
    },
  });
}

function tokenFrom(response: Response): string {
  const cookie = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(cookie);
  return decodeURIComponent(match?.[1] ?? "");
}

describe("S9 — authentication, roles and server-side authorization", () => {
  let db: TestDatabase;
  let handlers: ReturnType<typeof createHandlers>;
  let partner: { username: string; userId: string };
  let advisor: { username: string; userId: string };
  let technician: { username: string; userId: string };

  beforeAll(async () => {
    db = await createTestDatabase();
    handlers = createHandlers(db.app);
    partner = await makeUser(db.app, ["partner"], "partner");
    advisor = await makeUser(db.app, ["service_advisor"], "advisor");
    technician = await makeUser(db.app, ["technician"], "tech");
  });
  afterAll(async () => {
    await db?.destroy();
  });

  const signIn = async (username: string, password = TEST_PASSWORD) =>
    handlers.login(form("/api/auth/login", { username, password, locale: "en" }));

  it("signs in with a secure session cookie and redirects to the home page", async () => {
    const response = await signIn(partner.username);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/en");
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(tokenFrom(response)).toHaveLength(43);
  });

  it("gives the same response for an unknown user and a wrong password, and audits both", async () => {
    const unknown = await signIn("nobody.here");
    const wrong = await signIn(partner.username, "wrong-password-123");
    for (const response of [unknown, wrong]) {
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/en/login?error=1");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    const failures = await db.app
      .selectFrom("audit_event")
      .select(["entity_id", "details"])
      .where("action", "=", "auth.login_failed")
      .execute();
    expect(failures).toContainEqual({ entity_id: "nobody.here", details: { reason: "unknown_user" } });
    expect(failures).toContainEqual({ entity_id: partner.username, details: { reason: "wrong_password" } });
  });

  it("stores only a hash of the session token", async () => {
    const token = tokenFrom(await signIn(advisor.username));
    const rows = await db.app
      .selectFrom("user_session")
      .selectAll()
      .where("user_id", "=", advisor.userId)
      .execute();
    const row = rows.find((r) => r.token_hash.equals(hashToken(token)));
    expect(row).toBeDefined();
    for (const r of rows) {
      expect(JSON.stringify(r)).not.toContain(token);
    }
  });

  it("rejects requests without a session (401)", async () => {
    const response = await handlers.createTestDocument(
      jsonRequest("/api/test-documents", { title: "x", amount: "1.00", idempotencyKey: randomUUID() }),
    );
    expect(response.status).toBe(401);
  });

  it("denies a role without the permission at the server, even calling the endpoint directly, and audits it", async () => {
    const token = tokenFrom(await signIn(technician.username));
    const title = `tech-attempt-${randomUUID()}`;
    const response = await handlers.createTestDocument(
      jsonRequest("/api/test-documents", { title, amount: "1.00", idempotencyKey: randomUUID() }, token),
    );
    expect(response.status).toBe(403);
    const created = await db.app
      .selectFrom("test_document")
      .select("id")
      .where("title", "=", title)
      .execute();
    expect(created).toHaveLength(0);
    const denied = await db.app
      .selectFrom("audit_event")
      .select(["details", "actor_user_id"])
      .where("action", "=", "authz.denied")
      .where("actor_user_id", "=", technician.userId)
      .execute();
    expect(denied).toHaveLength(1);
    expect(denied[0]!.details).toMatchObject({ permission: "test_document.create" });
  });

  it("allows a permitted role to create and issue; a repeated key replays", async () => {
    const token = tokenFrom(await signIn(advisor.username));
    const key = randomUUID();
    const body = { title: `api-${key}`, amount: "525.00", idempotencyKey: key };
    const created = await handlers.createTestDocument(jsonRequest("/api/test-documents", body, token));
    expect(created.status).toBe(201);
    const { documentId } = (await created.json()) as { documentId: string };
    const replay = await handlers.createTestDocument(jsonRequest("/api/test-documents", body, token));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ documentId });

    const issued = await handlers.issueTestDocument(
      jsonRequest(`/api/test-documents/${documentId}/issue`, { idempotencyKey: randomUUID() }, token),
      documentId,
    );
    expect(issued.status).toBe(200);
    expect(await issued.json()).toMatchObject({ documentId, status: "issued" });
  });

  it("rejects a cross-site request (Origin does not match Host)", async () => {
    const token = tokenFrom(await signIn(advisor.username));
    const response = await handlers.createTestDocument(
      jsonRequest(
        "/api/test-documents",
        { title: "x", amount: "1.00", idempotencyKey: randomUUID() },
        token,
        {
          origin: "https://evil.example",
          host: "localhost:3000",
        },
      ),
    );
    expect(response.status).toBe(403);
  });

  it("AC2-29: a deactivated user's next request is rejected and they cannot sign in again", async () => {
    const victim = await makeUser(db.app, ["service_advisor"], "leaver");
    const victimToken = tokenFrom(await signIn(victim.username));
    const ok = await handlers.createTestDocument(
      jsonRequest(
        "/api/test-documents",
        { title: `before-${randomUUID()}`, amount: "1.00", idempotencyKey: randomUUID() },
        victimToken,
      ),
    );
    expect(ok.status).toBe(201);

    const partnerToken = tokenFrom(await signIn(partner.username));
    const deactivated = await handlers.deactivateUser(
      jsonRequest(`/api/users/${victim.userId}/deactivate`, {}, partnerToken),
      victim.userId,
    );
    expect(deactivated.status).toBe(200);

    const after = await handlers.createTestDocument(
      jsonRequest(
        "/api/test-documents",
        { title: `after-${randomUUID()}`, amount: "1.00", idempotencyKey: randomUUID() },
        victimToken,
      ),
    );
    expect(after.status).toBe(401);
    expect((await signIn(victim.username)).headers.get("location")).toBe("/en/login?error=1");
  });

  it("only partners may deactivate users in Increment 0", async () => {
    const advisorToken = tokenFrom(await signIn(advisor.username));
    const response = await handlers.deactivateUser(
      jsonRequest(`/api/users/${partner.userId}/deactivate`, {}, advisorToken),
      partner.userId,
    );
    expect(response.status).toBe(403);
  });

  it("logout revokes the session", async () => {
    const token = tokenFrom(await signIn(partner.username));
    const response = await handlers.logout(
      new Request(`${BASE}/api/auth/logout`, {
        method: "POST",
        body: new URLSearchParams({ locale: "ar" }),
        headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
      }),
    );
    expect(response.headers.get("location")).toBe("/ar/login");
    const check = await handlers.currentSession(jsonRequest("/", {}, token));
    expect(check).toBeNull();
  });

  it("requires passwords of at least 12 characters", async () => {
    await expect(
      createUser(
        db.app,
        { kind: "system", name: "test" },
        { username: "shortpw", displayName: "S", password: "short", roles: ["technician"] },
      ),
    ).rejects.toThrow(/at least 12/);
  });

  it("a password reset replaces the password, signs the user out everywhere and audits it without the hash", async () => {
    const forgetful = await makeUser(db.app, ["manager"], "forgetful");
    const oldToken = tokenFrom(await signIn(forgetful.username));
    const newPassword = "a-brand-new-password-42";

    const result = await resetPassword(
      db.app,
      { kind: "system", name: "test" },
      { username: ` ${forgetful.username.toUpperCase()} `, password: newPassword },
    );
    expect(result).toEqual({ userId: forgetful.userId, sessionsRevoked: 1 });

    expect(await handlers.currentSession(jsonRequest("/", {}, oldToken))).toBeNull();
    expect((await signIn(forgetful.username)).headers.get("location")).toBe("/en/login?error=1");
    expect((await signIn(forgetful.username, newPassword)).headers.get("location")).toBe("/en");

    const events = await db.app
      .selectFrom("audit_event")
      .selectAll()
      .where("action", "=", "user.password_reset")
      .where("entity_id", "=", forgetful.userId)
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]!.details).toEqual({ sessionsRevoked: 1 });
    const { password_hash } = await db.app
      .selectFrom("app_user")
      .select("password_hash")
      .where("id", "=", forgetful.userId)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(events)).not.toContain(password_hash);
    expect(JSON.stringify(events)).not.toContain(newPassword);
  });

  it("a password reset refuses an unknown user and a short password, changing nothing", async () => {
    const system = { kind: "system", name: "test" } as const;
    await expect(
      resetPassword(db.app, system, { username: "nobody.here", password: "long-enough-password" }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      resetPassword(db.app, system, { username: advisor.username, password: "short" }),
    ).rejects.toThrow(/at least 12/);
    expect((await signIn(advisor.username)).headers.get("location")).toBe("/en");
  });

  it("a password reset leaves a deactivated user deactivated", async () => {
    const leaver = await makeUser(db.app, ["technician"], "gone");
    const partnerToken = tokenFrom(await signIn(partner.username));
    await handlers.deactivateUser(
      jsonRequest(`/api/users/${leaver.userId}/deactivate`, {}, partnerToken),
      leaver.userId,
    );
    await resetPassword(
      db.app,
      { kind: "system", name: "test" },
      { username: leaver.username, password: "a-brand-new-password-42" },
    );
    expect((await signIn(leaver.username, "a-brand-new-password-42")).headers.get("location")).toBe(
      "/en/login?error=1",
    );
  });

  it("never writes passwords or session tokens to logs", async () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    let token = "";
    try {
      await signIn(partner.username, "wrong-password-xyz");
      token = tokenFrom(await signIn(partner.username));
      // A careless diagnostic log line: sensitive fields must still be redacted.
      logger.info("diagnostic", { password: TEST_PASSWORD, nested: { sessionToken: token, cookie: "a=b" } });
    } finally {
      restore();
    }
    const output = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(output).not.toContain(TEST_PASSWORD);
    expect(output).not.toContain("wrong-password-xyz");
    expect(output).not.toContain(token);
    expect(output).toContain(REDACTED);
  });
});
