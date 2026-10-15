import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/server/db/migrate";
import { createTestDatabase, sqlErrorAs, type TestDatabase } from "./helpers/db";

const INSUFFICIENT_PRIVILEGE = "42501";

describe("S1 — database roles", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it.each([
    ["CREATE a table", "CREATE TABLE intruder (id int)"],
    ["ALTER a table", "ALTER TABLE test_document ADD COLUMN extra int"],
    ["DROP a table", "DROP TABLE audit_event"],
    ["TRUNCATE the audit log", "TRUNCATE audit_event"],
    ["CREATE a function", "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'SELECT 1'"],
  ])("the application role cannot %s", async (_label, statement) => {
    const error = await sqlErrorAs(db.appUrl, statement);
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("the application role cannot run migrations", async () => {
    await expect(runMigrations(db.appUrl)).rejects.toThrow(/permission denied/);
  });

  it("the owner role can run migrations", async () => {
    await expect(runMigrations(db.ownerUrl)).resolves.toMatchObject({ applied: [] });
  });

  it("the application role cannot change a column it was not granted", async () => {
    const error = await sqlErrorAs(db.appUrl, "UPDATE number_series SET prefix = 'X-'");
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});
