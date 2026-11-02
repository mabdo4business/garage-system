import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, runMigrations } from "../src/server/db/migrate";
import { createTestDatabase, type TestDatabase } from "./helpers/db";

describe("S0 — project scaffold", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it("connects to a real PostgreSQL as the application role", async () => {
    const { rows } = await sql<{ who: string; version: string }>`
      SELECT current_user AS who, version() AS version`.execute(db.app);
    expect(rows[0]!.who).toBe("garage_app");
    expect(rows[0]!.version).toMatch(/^PostgreSQL 1[6-9]/);
  });

  it("records applied migrations, and re-running them is a no-op", async () => {
    const result = await runMigrations(db.ownerUrl);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toContain("0001_foundation");
  });

  it("refuses to run when an applied migration file was edited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "garage-migrations-"));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const first = readdirSync(dir).find((f) => f.startsWith("0001_"))!;
    writeFileSync(join(dir, first), "-- edited after being applied\nSELECT 1;");
    await expect(runMigrations(db.ownerUrl, dir)).rejects.toThrow(/was changed after it was applied/);
  });

  it("tracks no secrets: .env files are ignored and .env.example is not", () => {
    const ignored = (path: string) => {
      try {
        execFileSync("git", ["check-ignore", "-q", path], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    };
    expect(ignored(".env")).toBe(true);
    expect(ignored(".env.local")).toBe(true);
    expect(ignored(".env.example")).toBe(false);
    expect(ignored(".idea/workspace.xml")).toBe(true);
  });
});
