import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");

export interface MigrationFile {
  version: string;
  checksum: string;
  sql: string;
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), "utf8");
      return {
        version: name.replace(/\.sql$/, ""),
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    });
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Applies pending migrations in order, each in its own transaction.
 * Must run as the owner role. A previously applied file whose content changed is an error:
 * migrations are append-only once applied.
 */
export async function runMigrations(
  ownerUrl: string,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    // Serialise concurrent migration runs.
    await client.query("SELECT pg_advisory_lock(hashtext('garage_schema_migration'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        version    text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migration",
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    const result: MigrationResult = { applied: [], alreadyApplied: [] };

    for (const migration of loadMigrations(dir)) {
      const existing = applied.get(migration.version);
      if (existing !== undefined) {
        if (existing !== migration.checksum) {
          throw new Error(
            `Migration ${migration.version} was changed after it was applied. ` +
              "Applied migrations must not be edited; add a new migration instead.",
          );
        }
        result.alreadyApplied.push(migration.version);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migration (version, checksum) VALUES ($1, $2)", [
          migration.version,
          migration.checksum,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${migration.version} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
      result.applied.push(migration.version);
    }
    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('garage_schema_migration'))").catch(() => {});
    await client.end();
  }
}
