import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "./schema";

// Keep DATE columns as 'YYYY-MM-DD' strings. The default parser turns them into a
// JavaScript Date at local midnight, which shifts business dates across time zones.
const DATE_OID = 1082;
pg.types.setTypeParser(DATE_OID, (value: string) => value);

export interface CreateDbOptions {
  connectionString: string;
  maxConnections?: number;
}

export function createDb({ connectionString, maxConnections = 10 }: CreateDbOptions): Kysely<DB> {
  const pool = new pg.Pool({ connectionString, max: maxConnections });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

let appDb: Kysely<DB> | undefined;

/** Application database (least-privileged garage_app role). Created lazily on first use. */
export function getDb(): Kysely<DB> {
  if (!appDb) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    appDb = createDb({ connectionString });
  }
  return appDb;
}
