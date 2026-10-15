import { createHash, randomBytes } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "../db/schema";

/**
 * Server-side sessions. The browser holds a random token; the database stores only its
 * SHA-256 hash. Every request is checked against the database, so deactivating a user or
 * revoking a session takes effect on the very next request (AC2-29).
 */

export const SESSION_COOKIE = "gs_session";

export interface SessionPolicy {
  idleMinutes: number;
  absoluteHours: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function sessionPolicy(): SessionPolicy {
  return {
    idleMinutes: positiveInt(process.env.SESSION_IDLE_MINUTES, 30),
    absoluteHours: positiveInt(process.env.SESSION_ABSOLUTE_HOURS, 12),
  };
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export async function createSession(
  tx: Transaction<DB>,
  userId: string,
  policy: SessionPolicy = sessionPolicy(),
): Promise<{ token: string; sessionId: string }> {
  const token = randomBytes(32).toString("base64url");
  const row = await tx
    .insertInto("user_session")
    .values({
      token_hash: hashToken(token),
      user_id: userId,
      expires_at: sql<Date>`now() + make_interval(hours => ${policy.absoluteHours})`,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { token, sessionId: row.id };
}

export interface SessionUser {
  sessionId: string;
  userId: string;
  username: string;
  displayName: string;
  roles: string[];
}

/** Returns the signed-in user for a token, or null if the session is invalid in any way. */
export async function validateSession(
  db: Kysely<DB>,
  token: string | undefined | null,
  policy: SessionPolicy = sessionPolicy(),
): Promise<SessionUser | null> {
  if (!token || token.length > 200) {
    return null;
  }
  const row = await db
    .selectFrom("user_session as s")
    .innerJoin("app_user as u", "u.id", "s.user_id")
    .select(["s.id as session_id", "u.id as user_id", "u.username", "u.display_name"])
    .where("s.token_hash", "=", hashToken(token))
    .where("s.revoked_at", "is", null)
    .where("s.expires_at", ">", sql<Date>`now()`)
    .where("s.last_seen_at", ">", sql<Date>`now() - make_interval(mins => ${policy.idleMinutes})`)
    .where("u.status", "=", "active")
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  await db
    .updateTable("user_session")
    .set({ last_seen_at: sql<Date>`now()` })
    .where("id", "=", row.session_id)
    .execute();
  const roles = await db.selectFrom("user_role").select("role").where("user_id", "=", row.user_id).execute();
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    roles: roles.map((r) => r.role).sort(),
  };
}

export async function revokeSessionsForUser(tx: Transaction<DB>, userId: string): Promise<number> {
  const result = await tx
    .updateTable("user_session")
    .set({ revoked_at: sql<Date>`now()` })
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}
