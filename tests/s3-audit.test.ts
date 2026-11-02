import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCommand } from "../src/server/command/runner";
import { createTestDatabase, sqlErrorAs, type TestDatabase } from "./helpers/db";
import { makeUser } from "./helpers/users";

describe("S3 — audit log", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it("records actor, command, business date and before/after state", async () => {
    const { userId, actor } = await makeUser(db.app, ["manager"]);
    const outcome = await runCommand(db.app, { name: "test.audit_fields", actor }, async (ctx) => {
      await ctx.audit({
        action: "test.changed",
        entityType: "widget",
        entityId: "w-1",
        before: { status: "a" },
        after: { status: "b" },
      });
      return { businessDate: ctx.businessDate };
    });
    const row = await db.app
      .selectFrom("audit_event")
      .selectAll()
      .where("command_id", "=", outcome.commandId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      command_name: "test.audit_fields",
      actor_user_id: userId,
      actor_label: "user",
      action: "test.changed",
      entity_type: "widget",
      entity_id: "w-1",
      business_date: outcome.result.businessDate,
      before_state: { status: "a" },
      after_state: { status: "b" },
    });
  });

  it("an audit event written in a transaction that rolls back does not exist", async () => {
    let commandId = "";
    await expect(
      runCommand(db.app, { name: "test.audit_rollback", actor: { kind: "anonymous" } }, async (ctx) => {
        commandId = ctx.commandId;
        await ctx.audit({ action: "test.rolled_back", entityType: "test", entityId: "1" });
        throw new Error("fail after audit");
      }),
    ).rejects.toThrow("fail after audit");
    const rows = await db.app
      .selectFrom("audit_event")
      .select("seq")
      .where("command_id", "=", commandId)
      .execute();
    expect(rows).toHaveLength(0);
  });

  it("the application role cannot UPDATE or DELETE audit events", async () => {
    expect((await sqlErrorAs(db.appUrl, "UPDATE audit_event SET action = 'tampered'"))?.code).toBe("42501");
    expect((await sqlErrorAs(db.appUrl, "DELETE FROM audit_event"))?.code).toBe("42501");
  });

  it("sequence numbers are unique and increasing across concurrent writers", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        runCommand(db.app, { name: "test.audit_concurrent", actor: { kind: "anonymous" } }, async (ctx) => {
          await ctx.audit({ action: "test.concurrent", entityType: "test", entityId: String(i) });
          await ctx.audit({ action: "test.concurrent_second", entityType: "test", entityId: String(i) });
          return { i };
        }),
      ),
    );
    const rows = await db.app
      .selectFrom("audit_event")
      .select(["seq", "command_id", "action"])
      .where("command_name", "=", "test.audit_concurrent")
      .orderBy("seq")
      .execute();
    expect(rows).toHaveLength(40);
    const seqs = rows.map((r) => BigInt(r.seq));
    expect(new Set(seqs).size).toBe(40);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]! > seqs[i - 1]!).toBe(true);
    // Within each command, the second event has a higher sequence than the first.
    for (const outcome of outcomes) {
      const own = rows.filter((r) => r.command_id === outcome.commandId);
      expect(own.map((r) => r.action)).toEqual(["test.concurrent", "test.concurrent_second"]);
    }
  });
});
