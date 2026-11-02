import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCommand } from "../src/server/command/runner";
import { processOutbox, type OutboxMessage } from "../src/server/outbox/outbox";
import { createTestDatabase, type TestDatabase } from "./helpers/db";

describe("S7 — outbox", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  const enqueue = (topic: string, payload: Record<string, string>, fail = false) =>
    runCommand(db.app, { name: "test.enqueue", actor: { kind: "anonymous" } }, async (ctx) => {
      await ctx.enqueue(topic, payload);
      await ctx.audit({ action: "test.enqueued", entityType: "outbox", entityId: topic });
      if (fail) throw new Error("command failed after enqueue");
      return { ok: true };
    });

  it("AT-02: a rolled-back command leaves no outbox message and no side effect", async () => {
    await expect(enqueue("rollback.topic", { a: "1" }, true)).rejects.toThrow("command failed after enqueue");
    const rows = await db.app
      .selectFrom("outbox_message")
      .select("id")
      .where("topic", "=", "rollback.topic")
      .execute();
    expect(rows).toHaveLength(0);
    let called = 0;
    await processOutbox(db.app, { handlers: { "rollback.topic": async () => void called++ } });
    expect(called).toBe(0);
  });

  it("processes a committed message once and marks it processed", async () => {
    await enqueue("ok.topic", { doc: "D1" });
    const seen: unknown[] = [];
    const first = await processOutbox(db.app, {
      handlers: { "ok.topic": async (m) => void seen.push(m.payload) },
    });
    const second = await processOutbox(db.app, {
      handlers: { "ok.topic": async (m) => void seen.push(m.payload) },
    });
    expect(first.processed).toBe(1);
    expect(second.processed).toBe(0);
    expect(seen).toEqual([{ doc: "D1" }]);
  });

  it("retries a failing handler until it succeeds", async () => {
    await enqueue("flaky.topic", { doc: "D2" });
    let calls = 0;
    const handlers = {
      "flaky.topic": async () => {
        calls++;
        if (calls <= 2) throw new Error(`transient failure ${calls}`);
      },
    };
    const options = { handlers, backoffSeconds: () => 0 };
    expect(await processOutbox(db.app, options)).toEqual({ processed: 0, failed: 1 });
    expect(await processOutbox(db.app, options)).toEqual({ processed: 0, failed: 1 });
    expect(await processOutbox(db.app, options)).toEqual({ processed: 1, failed: 0 });
    const row = await db.app
      .selectFrom("outbox_message")
      .select(["attempts", "last_error", "processed_at"])
      .where("topic", "=", "flaky.topic")
      .executeTakeFirstOrThrow();
    expect(row.attempts).toBe(2);
    expect(row.last_error).toBe("transient failure 2");
    expect(row.processed_at).not.toBeNull();
  });

  it("redelivers after a crash between handler and acknowledgement; an idempotent handler applies once", async () => {
    await enqueue("crash.topic", { doc: "D3" });
    const effects = new Map<string, unknown>(); // keyed by message id, as handlers must be
    let handlerCalls = 0;
    const handler = async (message: OutboxMessage) => {
      handlerCalls++;
      if (!effects.has(message.id)) effects.set(message.id, message.payload);
    };

    await expect(
      processOutbox(db.app, {
        handlers: { "crash.topic": handler },
        afterHandler: () => {
          throw new Error("process stopped before acknowledging");
        },
      }),
    ).rejects.toThrow("process stopped before acknowledging");
    const pending = await db.app
      .selectFrom("outbox_message")
      .select("processed_at")
      .where("topic", "=", "crash.topic")
      .executeTakeFirstOrThrow();
    expect(pending.processed_at).toBeNull();

    expect(await processOutbox(db.app, { handlers: { "crash.topic": handler } })).toEqual({
      processed: 1,
      failed: 0,
    });
    expect(handlerCalls).toBe(2);
    expect(effects.size).toBe(1);
  });

  it("a message with no handler is retried later, not lost", async () => {
    await enqueue("unknown.topic", { doc: "D4" });
    expect(await processOutbox(db.app, { handlers: {}, backoffSeconds: () => 3600 })).toEqual({
      processed: 0,
      failed: 1,
    });
    const row = await db.app
      .selectFrom("outbox_message")
      .select(["processed_at", "last_error"])
      .where("topic", "=", "unknown.topic")
      .executeTakeFirstOrThrow();
    expect(row.processed_at).toBeNull();
    expect(row.last_error).toMatch(/No outbox handler/);
  });
});
