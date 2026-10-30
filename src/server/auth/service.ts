import { sql, type Kysely } from "kysely";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "../core/errors";
import { runCommand, type Actor } from "../command/runner";
import type { DB } from "../db/schema";
import { hashPassword, verifyDummy, verifyPassword } from "./password";
import { hasPermission, isRole, type Permission } from "./permissions";
import { createSession, hashToken, revokeSessionsForUser, type SessionUser } from "./session";

export function normaliseUsername(input: unknown): string {
  return typeof input === "string" ? input.trim().toLowerCase() : "";
}

export interface CreateUserInput {
  username: string;
  displayName: string;
  password: string;
  roles: string[];
}

/**
 * Creates a staff user. Increment 0 exposes this only through the development CLI
 * (scripts/create-user.ts). Production bootstrap of partner accounts is P1-03.
 */
export async function createUser(
  db: Kysely<DB>,
  actor: Actor,
  input: CreateUserInput,
): Promise<{ userId: string }> {
  const username = normaliseUsername(input.username);
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
    throw new ValidationError("Username must be 3–64 characters: letters, digits, dot, dash or underscore");
  }
  const displayName = input.displayName.trim();
  if (displayName.length < 1 || displayName.length > 200) {
    throw new ValidationError("Display name must be 1–200 characters");
  }
  const roles = [...new Set(input.roles)];
  if (roles.length === 0 || !roles.every(isRole)) {
    throw new ValidationError("At least one valid role is required");
  }
  const passwordHash = await hashPassword(input.password);

  const outcome = await runCommand(db, { name: "user.create", actor }, async (ctx) => {
    const existing = await ctx.tx
      .selectFrom("app_user")
      .select("id")
      .where("username", "=", username)
      .executeTakeFirst();
    if (existing) {
      throw new ConflictError("username_taken", `Username ${username} is already in use`);
    }
    const user = await ctx.tx
      .insertInto("app_user")
      .values({ username, display_name: displayName, password_hash: passwordHash })
      .returning("id")
      .executeTakeFirstOrThrow();
    await ctx.tx
      .insertInto("user_role")
      .values(roles.map((role) => ({ user_id: user.id, role })))
      .execute();
    await ctx.audit({
      action: "user.created",
      entityType: "app_user",
      entityId: user.id,
      after: { username, displayName, roles },
    });
    return { userId: user.id };
  });
  return outcome.result;
}

export type LoginResult = { ok: true; token: string; userId: string } | { ok: false };

/**
 * Signs a user in. Unknown username, wrong password and deactivated account all return the
 * same { ok: false } so the response does not reveal which one it was. Both outcomes are audited.
 */
export async function login(
  db: Kysely<DB>,
  usernameInput: unknown,
  passwordInput: unknown,
): Promise<LoginResult> {
  const username = normaliseUsername(usernameInput);
  const password = typeof passwordInput === "string" ? passwordInput : "";

  const user = username
    ? await db
        .selectFrom("app_user")
        .select(["id", "password_hash", "status"])
        .where("username", "=", username)
        .executeTakeFirst()
    : undefined;

  const passwordOk = user ? await verifyPassword(user.password_hash, password) : await verifyDummy(password);
  const success = Boolean(user && passwordOk && user.status === "active");

  const outcome = await runCommand(
    db,
    {
      name: "auth.login",
      actor: success && user ? { kind: "user", userId: user.id } : { kind: "anonymous" },
    },
    async (ctx): Promise<LoginResult> => {
      if (success && user) {
        const { token } = await createSession(ctx.tx, user.id);
        await ctx.audit({ action: "auth.login_succeeded", entityType: "app_user", entityId: user.id });
        return { ok: true as const, token, userId: user.id };
      }
      await ctx.audit({
        action: "auth.login_failed",
        entityType: "username",
        entityId: username.slice(0, 64) || "(empty)",
        details: { reason: !user ? "unknown_user" : !passwordOk ? "wrong_password" : "inactive_user" },
      });
      return { ok: false as const };
    },
  );
  return outcome.result;
}

export async function logout(db: Kysely<DB>, token: string | undefined | null): Promise<void> {
  if (!token) return;
  const session = await db
    .selectFrom("user_session")
    .select(["id", "user_id"])
    .where("token_hash", "=", hashToken(token))
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  if (!session) return;
  await runCommand(
    db,
    { name: "auth.logout", actor: { kind: "user", userId: session.user_id } },
    async (ctx) => {
      await ctx.tx
        .updateTable("user_session")
        .set({ revoked_at: sql<Date>`now()` })
        .where("id", "=", session.id)
        .execute();
      await ctx.audit({ action: "auth.logout", entityType: "user_session", entityId: session.id });
      return { ok: true };
    },
  );
}

/**
 * Server-side authorization. Throws UnauthenticatedError without a session and ForbiddenError
 * when the role lacks the permission. A denial is written to the audit log.
 */
export async function authorize(
  db: Kysely<DB>,
  session: SessionUser | null,
  permission: Permission,
  target: { entityType: string; entityId: string } = { entityType: "endpoint", entityId: permission },
): Promise<SessionUser> {
  if (!session) {
    throw new UnauthenticatedError();
  }
  if (!hasPermission(session.roles, permission)) {
    await runCommand(
      db,
      { name: "authz.check", actor: { kind: "user", userId: session.userId } },
      async (ctx) => {
        await ctx.audit({
          action: "authz.denied",
          entityType: target.entityType,
          entityId: target.entityId,
          details: { permission, roles: session.roles },
        });
        return { denied: true };
      },
    );
    throw new ForbiddenError(permission);
  }
  return session;
}

/**
 * Sets a new password for an existing user and revokes all of their sessions in the same transaction, so
 * anyone signed in with the old password is signed out. Like createUser, exposed only through the development
 * CLI (scripts/reset-password.ts); staff-facing password management arrives with 2FA and bootstrap (I5-03).
 * The audit event records that the password changed, never the password or its hash. A deactivated user stays
 * deactivated.
 */
export async function resetPassword(
  db: Kysely<DB>,
  actor: Actor,
  input: { username: string; password: string },
): Promise<{ userId: string; sessionsRevoked: number }> {
  const username = normaliseUsername(input.username);
  const passwordHash = await hashPassword(input.password);

  const outcome = await runCommand(db, { name: "user.reset_password", actor }, async (ctx) => {
    const user = await ctx.tx
      .updateTable("app_user")
      .set({ password_hash: passwordHash })
      .where("username", "=", username)
      .returning("id")
      .executeTakeFirst();
    if (!user) {
      throw new NotFoundError("app_user", username);
    }
    const revoked = await revokeSessionsForUser(ctx.tx, user.id);
    await ctx.audit({
      action: "user.password_reset",
      entityType: "app_user",
      entityId: user.id,
      details: { sessionsRevoked: revoked },
    });
    return { userId: user.id, sessionsRevoked: revoked };
  });
  return outcome.result;
}

/** Deactivates a user and revokes all of their sessions in the same transaction (R0: immediate). */
export async function deactivateUser(db: Kysely<DB>, actor: SessionUser, userId: string): Promise<void> {
  await runCommand(
    db,
    { name: "user.deactivate", actor: { kind: "user", userId: actor.userId } },
    async (ctx) => {
      const user = await ctx.tx
        .selectFrom("app_user")
        .select(["id", "status"])
        .where("id", "=", userId)
        .forUpdate()
        .executeTakeFirst();
      if (!user) {
        throw new NotFoundError("app_user", userId);
      }
      if (user.status === "deactivated") {
        await ctx.audit({ action: "user.deactivate_repeated", entityType: "app_user", entityId: userId });
        return { ok: true };
      }
      await ctx.tx
        .updateTable("app_user")
        .set({ status: "deactivated", deactivated_at: sql<Date>`now()` })
        .where("id", "=", userId)
        .execute();
      const revoked = await revokeSessionsForUser(ctx.tx, userId);
      await ctx.audit({
        action: "user.deactivated",
        entityType: "app_user",
        entityId: userId,
        before: { status: "active" },
        after: { status: "deactivated" },
        details: { sessionsRevoked: revoked },
      });
      return { ok: true };
    },
  );
}
