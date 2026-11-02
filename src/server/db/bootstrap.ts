import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export interface BootstrapOptions {
  /** Superuser connection to the target database. */
  adminUrl: string;
  database: string;
  ownerPassword: string;
  appPassword: string;
  /**
   * Create/update the cluster-level roles (db/bootstrap.sql). Default true.
   * Set false when the roles already exist and only a new database needs locking down —
   * concurrent ALTER ROLE statements conflict in PostgreSQL.
   */
  roles?: boolean;
}

function readSql(name: string): string {
  return readFileSync(join(process.cwd(), "db", name), "utf8");
}

/**
 * Creates (or updates) the garage_owner and garage_app roles and locks down the public schema
 * of one database. Idempotent. Values are escaped by the driver before substitution.
 */
export async function bootstrapDatabase(options: BootstrapOptions): Promise<void> {
  const client = new pg.Client({ connectionString: options.adminUrl });
  await client.connect();
  try {
    if (options.roles !== false) {
      await client.query(
        readSql("bootstrap.sql")
          .replaceAll(":owner_password", client.escapeLiteral(options.ownerPassword))
          .replaceAll(":app_password", client.escapeLiteral(options.appPassword)),
      );
    }
    await client.query(
      readSql("bootstrap-database.sql").replaceAll(":database", client.escapeIdentifier(options.database)),
    );
  } finally {
    await client.end();
  }
}

/** Replaces the user, password and database of a connection URL. */
export function withCredentials(baseUrl: string, user: string, password: string, database: string): string {
  const url = new URL(baseUrl);
  url.username = encodeURIComponent(user);
  url.password = encodeURIComponent(password);
  url.pathname = `/${database}`;
  return url.toString();
}
