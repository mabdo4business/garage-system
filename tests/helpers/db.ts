import { randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import pg from "pg";
import { inject } from "vitest";
import { bootstrapDatabase, withCredentials } from "../../src/server/db/bootstrap";
import { createDb } from "../../src/server/db/client";
import type { DB } from "../../src/server/db/schema";

export interface TestDatabase {
  name: string;
  /** Connected as garage_app — the role the application uses. */
  app: Kysely<DB>;
  /** Connected as garage_owner — for test setup that the application itself may not do. */
  owner: Kysely<DB>;
  appUrl: string;
  ownerUrl: string;
  adminUrl: string;
  destroy(): Promise<void>;
}

/** Creates a fresh, fully migrated database for one test file (cloned from the template). */
export async function createTestDatabase(): Promise<TestDatabase> {
  const baseAdmin = inject("pgAdminUrl");
  const template = inject("pgTemplate");
  const ownerPassword = inject("pgOwnerPassword");
  const appPassword = inject("pgAppPassword");
  const name = `garage_t_${randomBytes(6).toString("hex")}`;

  const admin = new pg.Client({ connectionString: baseAdmin });
  await admin.connect();
  for (let attempt = 1; ; attempt++) {
    try {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
      break;
    } catch (error) {
      // Another file may be cloning the template at the same moment (SQLSTATE 55006).
      if ((error as { code?: string }).code !== "55006" || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
  await admin.end();

  const adminUser = new URL(baseAdmin).username;
  const adminPassword = decodeURIComponent(new URL(baseAdmin).password);
  const adminUrl = withCredentials(baseAdmin, adminUser, adminPassword, name);
  await bootstrapDatabase({ adminUrl, database: name, ownerPassword, appPassword, roles: false });

  const appUrl = withCredentials(baseAdmin, "garage_app", appPassword, name);
  const ownerUrl = withCredentials(baseAdmin, "garage_owner", ownerPassword, name);
  const app = createDb({ connectionString: appUrl, maxConnections: 12 });
  const owner = createDb({ connectionString: ownerUrl, maxConnections: 4 });

  return {
    name,
    app,
    owner,
    appUrl,
    ownerUrl,
    adminUrl,
    async destroy() {
      await app.destroy();
      await owner.destroy();
      const cleanup = new pg.Client({ connectionString: baseAdmin });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/** Runs raw SQL as a given role on a dedicated connection and returns the error, if any. */
export async function sqlErrorAs(
  url: string,
  statement: string,
): Promise<{ code?: string; message: string } | null> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(statement);
    return null;
  } catch (error) {
    return { code: (error as { code?: string }).code, message: (error as Error).message };
  } finally {
    await client.end();
  }
}

/** Waits until at least `count` backends in this database are blocked on a lock. */
export async function waitForLockWaiters(db: TestDatabase, count: number, timeoutMs = 10_000): Promise<void> {
  const client = new pg.Client({ connectionString: db.adminUrl });
  await client.connect();
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'",
        [db.name],
      );
      if (Number(rows[0]!.n) >= count) return;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${count} lock waiter(s)`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await client.end();
  }
}

/** A promise that can be resolved from outside. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** All parties wait until `parties` callers have arrived. */
export function barrier(parties: number) {
  let arrived = 0;
  const gate = deferred();
  return async () => {
    arrived++;
    if (arrived >= parties) gate.resolve();
    await gate.promise;
  };
}
