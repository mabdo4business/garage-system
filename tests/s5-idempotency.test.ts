import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purgeIdempotencyKeys } from "../src/server/command/idempotency";
import { runCommand, type Actor } from "../src/server/command/runner";
import { IdempotencyConflictError, ValidationError } from "../src/server/core/errors";
import { createTestDocument, issueTestDocument } from "../src/server/test-document/service";
import { createTestDatabase, deferred, waitForLockWaiters, type TestDatabase } from "./helpers/db";
import { makeUser } from "./helpers/users";

describe("S5 — idempotency (Amendment v0.2.2 §A.3)", () => {
  let db: TestDatabase;
  let actor: Actor;
  let otherActor: Actor;

  beforeAll(async () => {
    db = await createTestDatabase();
    actor = (await makeUser(db.app, ["service_advisor"])).actor;
    otherActor = (await makeUser(db.app, ["service_advisor"])).actor;
  });
  afterAll(async () => {
    await db?.destroy();
  });

  const countDocs = async (title: string) =>
    (await db.app.selectFrom("test_document").select("id").where("title", "=", title).execute()).length;

  it("AT-03: three concurrent identical requests create one record and return the same id", async () => {
    const key = randomUUID();
    const title = `at03-${key}`;
    const outcomes = await Promise.all(
      [1, 2, 3].map(() => createTestDocument(db.app, actor, { title, amount: "200.00" }, key)),
    );
    expect(new Set(outcomes.map((o) => o.result.documentId)).size).toBe(1);
    expect(outcomes.filter((o) => o.replayed)).toHaveLength(2);
    expect(await countDocs(title)).toBe(1);
  });

  it("AT-04 (part 1): the same key with a different payload is rejected and creates nothing", async () => {
    const key = randomUUID();
    const title = `at04-${key}`;
    await createTestDocument(db.app, actor, { title, amount: "200.00" }, key);
    await expect(createTestDocument(db.app, actor, { title, amount: "250.00" }, key)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    const rows = await db.app
      .selectFrom("test_document")
      .select("amount")
      .where("title", "=", title)
      .execute();
    expect(rows.map((r) => r.amount)).toEqual(["200.00"]);
  });

  it("the same key used by a different user is rejected", async () => {
    const key = randomUUID();
    await createTestDocument(db.app, actor, { title: `actor-${key}`, amount: "1.00" }, key);
    await expect(
      createTestDocument(db.app, otherActor, { title: `actor-${key}`, amount: "1.00" }, key),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("T-04: the command commits, the response is lost, and a retry returns the stored result", async () => {
    const created = await createTestDocument(
      db.app,
      actor,
      { title: `t04-${randomUUID()}`, amount: "10.00" },
      randomUUID(),
    );
    const documentId = created.result.documentId;
    const key = randomUUID();

    await expect(
      issueTestDocument(db.app, actor, documentId, key, {
        afterCommit: () => {
          throw new Error("simulated crash after commit");
        },
      }),
    ).rejects.toThrow("simulated crash after commit");

    const retry = await issueTestDocument(db.app, actor, documentId, key);
    expect(retry.replayed).toBe(true);
    expect(retry.result.status).toBe("issued");

    const issues = await db.app
      .selectFrom("test_document_issue")
      .select("number_text")
      .where("document_id", "=", documentId)
      .execute();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.number_text).toBe(retry.result.number);
  });

  it("if the first request rolls back, the waiting duplicate proceeds as a new command", async () => {
    const key = randomUUID();
    const payload = { value: 1 };
    const releaseFirst = deferred();
    let executions = 0;

    const first = runCommand(
      db.app,
      { name: "test.idem_rollback", actor, idempotency: { key, payload } },
      async () => {
        executions++;
        await releaseFirst.promise;
        throw new Error("first request fails");
      },
    );
    // The command body runs only after the key row was inserted; then start the duplicate,
    // which must block on that uncommitted row.
    await waitUntil(async () => executions >= 1);
    const second = runCommand(
      db.app,
      { name: "test.idem_rollback", actor, idempotency: { key, payload } },
      async (ctx) => {
        executions++;
        await ctx.audit({ action: "test.idem_second", entityType: "test", entityId: key });
        return { executedBy: "second" };
      },
    );
    await waitForLockWaiters(db, 1);
    releaseFirst.resolve();

    await expect(first).rejects.toThrow("first request fails");
    const outcome = await second;
    expect(outcome.replayed).toBe(false);
    expect(outcome.result).toEqual({ executedBy: "second" });
    expect(executions).toBe(2);
  });

  it("rejects keys that are not UUIDs", async () => {
    await expect(
      createTestDocument(db.app, actor, { title: "bad-key", amount: "1.00" }, "not-a-uuid"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("purges keys older than the retention period", async () => {
    const oldKey = randomUUID();
    const newKey = randomUUID();
    await createTestDocument(db.app, actor, { title: `old-${oldKey}`, amount: "1.00" }, oldKey);
    await createTestDocument(db.app, actor, { title: `new-${newKey}`, amount: "1.00" }, newKey);
    await sql`UPDATE idempotency_key SET created_at = now() - interval '8 days' WHERE key = ${oldKey}`.execute(
      db.owner,
    );

    const deleted = await purgeIdempotencyKeys(db.app);
    expect(deleted).toBe(1);
    const remaining = await db.app
      .selectFrom("idempotency_key")
      .select("key")
      .where("key", "in", [oldKey, newKey])
      .execute();
    expect(remaining.map((r) => r.key)).toEqual([newKey]);
  });
});

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
