import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LockSet } from "../src/server/command/locks";
import { runCommand } from "../src/server/command/runner";
import { AuditMissingError, LockOrderViolationError, TryAgainError } from "../src/server/core/errors";
import { barrier, createTestDatabase, type TestDatabase } from "./helpers/db";

describe("S4 — command runner", () => {
  let db: TestDatabase;
  let docA: string;
  let docB: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    const rows = await db.app
      .insertInto("test_document")
      .values([
        { title: "A", amount: "1.00" },
        { title: "B", amount: "2.00" },
      ])
      .returning("id")
      .execute();
    [docA, docB] = rows.map((r) => r.id).sort() as [string, string];
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it("retries once after a real deadlock and both commands succeed", async () => {
    const meet = barrier(2);
    const lockInOrder = (first: string, second: string, name: string) =>
      runCommand(db.app, { name, actor: { kind: "anonymous" } }, async (ctx) => {
        // Deliberately bypasses LockSet to create a deadlock.
        await sql`SELECT 1 FROM test_document WHERE id = ${first} FOR UPDATE`.execute(ctx.tx);
        if (ctx.attempt === 1) await meet();
        await sql`SELECT 1 FROM test_document WHERE id = ${second} FOR UPDATE`.execute(ctx.tx);
        await ctx.audit({ action: "test.deadlock", entityType: "test", entityId: name });
        return { attempt: ctx.attempt };
      });

    const [one, two] = await Promise.all([
      lockInOrder(docA, docB, "test.deadlock_ab"),
      lockInOrder(docB, docA, "test.deadlock_ba"),
    ]);
    expect([one.attempts, two.attempts].sort()).toEqual([1, 2]);
    const audits = await db.app
      .selectFrom("audit_event")
      .select("command_name")
      .where("action", "=", "test.deadlock")
      .execute();
    expect(audits.map((a) => a.command_name).sort()).toEqual(["test.deadlock_ab", "test.deadlock_ba"]);
  }, 30_000);

  it("a second consecutive deadlock surfaces try_again and saves nothing", async () => {
    let calls = 0;
    const marker = `persistent-deadlock-${Date.now()}`;
    const error = await runCommand(
      db.app,
      { name: "test.persistent_deadlock", actor: { kind: "anonymous" } },
      async (ctx) => {
        calls++;
        await ctx.tx.insertInto("test_document").values({ title: marker, amount: "1.00" }).execute();
        await ctx.audit({ action: "test.should_not_exist", entityType: "test", entityId: marker });
        throw Object.assign(new Error("simulated deadlock"), { code: "40P01" });
      },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TryAgainError);
    expect((error as TryAgainError).code).toBe("try_again");
    expect(calls).toBe(2);
    const rows = await db.app.selectFrom("test_document").select("id").where("title", "=", marker).execute();
    expect(rows).toHaveLength(0);
  });

  it("does not retry non-transient errors", async () => {
    let calls = 0;
    await expect(
      runCommand(db.app, { name: "test.plain_error", actor: { kind: "anonymous" } }, async () => {
        calls++;
        throw new Error("business rule failed");
      }),
    ).rejects.toThrow("business rule failed");
    expect(calls).toBe(1);
  });

  it("rejects and rolls back a command that writes no audit event", async () => {
    const marker = `no-audit-${Date.now()}`;
    await expect(
      runCommand(db.app, { name: "test.no_audit", actor: { kind: "anonymous" } }, async (ctx) => {
        await ctx.tx.insertInto("test_document").values({ title: marker, amount: "1.00" }).execute();
        return { ok: true };
      }),
    ).rejects.toBeInstanceOf(AuditMissingError);
    const rows = await db.app.selectFrom("test_document").select("id").where("title", "=", marker).execute();
    expect(rows).toHaveLength(0);
  });

  describe("lock order", () => {
    async function inTransaction(fn: (locks: LockSet) => Promise<void>) {
      await db.app.transaction().execute(async (tx) => fn(new LockSet(tx)));
    }

    it("acquires ids of one kind in ascending order regardless of input order", async () => {
      await inTransaction(async (locks) => {
        const result = await locks.acquire("test_document", [docB, docA]);
        expect(result).toEqual([docA, docB]);
        expect(locks.acquired.map((l) => l.id)).toEqual([docA, docB]);
      });
    });

    it("rejects a lower-ranked lock after a higher-ranked one", async () => {
      await expect(
        inTransaction(async (locks) => {
          await locks.acquire("number_series", ["test_document"]);
          await locks.acquire("test_document", [docA]);
        }),
      ).rejects.toBeInstanceOf(LockOrderViolationError);
    });

    it("rejects a smaller id after a larger id of the same kind", async () => {
      await expect(
        inTransaction(async (locks) => {
          await locks.acquire("test_document", [docB]);
          await locks.acquire("test_document", [docA]);
        }),
      ).rejects.toBeInstanceOf(LockOrderViolationError);
    });

    it("rejects kinds whose table does not exist yet", async () => {
      await expect(
        inTransaction(async (locks) => {
          await locks.acquire("invoice", ["00000000-0000-4000-8000-000000000000"]);
        }),
      ).rejects.toBeInstanceOf(LockOrderViolationError);
    });
  });
});
