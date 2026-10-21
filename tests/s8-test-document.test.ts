import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/server/command/runner";
import { ConflictError } from "../src/server/core/errors";
import { findNumberGaps } from "../src/server/numbering/numbering";
import {
  createTestDocument,
  issueTestDocument,
  updateTestDocumentDraft,
} from "../src/server/test-document/service";
import { createTestDatabase, sqlErrorAs, type TestDatabase } from "./helpers/db";
import { makeUser } from "./helpers/users";

describe("S8 — stub test document command (end to end)", () => {
  let db: TestDatabase;
  let actor: Actor;

  beforeAll(async () => {
    db = await createTestDatabase();
    actor = (await makeUser(db.app, ["service_advisor"])).actor;
  });
  afterAll(async () => {
    await db?.destroy();
  });

  const newDraft = async (amount = "525.00") =>
    (await createTestDocument(db.app, actor, { title: `doc-${randomUUID()}`, amount }, randomUUID())).result
      .documentId;

  const stateOf = async (documentId: string) => ({
    issues: await db.app
      .selectFrom("test_document_issue")
      .selectAll()
      .where("document_id", "=", documentId)
      .execute(),
    audits: await db.app
      .selectFrom("audit_event")
      .select("action")
      .where("entity_id", "=", documentId)
      .orderBy("seq")
      .execute(),
    outbox: await db.app
      .selectFrom("outbox_message")
      .select(["topic", "payload"])
      .where("topic", "=", "test_document.issued")
      .execute(),
  });

  it("AT-01: a failure before commit leaves no issue, number, audit event, outbox message or gap", async () => {
    const documentId = await newDraft();
    await expect(
      issueTestDocument(db.app, actor, documentId, randomUUID(), {
        beforeCommit: () => {
          throw new Error("fault injected before commit");
        },
      }),
    ).rejects.toThrow("fault injected before commit");

    const after = await stateOf(documentId);
    expect(after.issues).toHaveLength(0);
    expect(after.audits.map((a) => a.action)).toEqual(["test_document.created"]);
    expect(after.outbox).toHaveLength(0);
    const numbers = await db.app
      .selectFrom("issued_number")
      .select("value")
      .where("series", "=", "test_document")
      .execute();
    expect(numbers).toHaveLength(0);

    // The next successful issue receives the number the failed attempt would have used.
    const issued = await issueTestDocument(db.app, actor, documentId, randomUUID());
    expect(issued.result).toEqual({ documentId, number: "TD-000001", status: "issued" });
  });

  it("issues with a snapshot, audit events and an outbox message, all committed together (AT-02)", async () => {
    const documentId = await newDraft("99.90");
    const issued = await issueTestDocument(db.app, actor, documentId, randomUUID());
    const state = await stateOf(documentId);
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]!.snapshot).toEqual({
      documentId,
      title: expect.any(String),
      amount: "99.90",
      number: issued.result.number,
    });
    expect(state.audits.map((a) => a.action)).toEqual(["test_document.created", "test_document.issued"]);
    expect(state.outbox).toContainEqual({
      topic: "test_document.issued",
      payload: { documentId, number: issued.result.number },
    });
  });

  it("AT-03: three concurrent identical issue requests give one issue and the same number", async () => {
    const documentId = await newDraft();
    const key = randomUUID();
    const outcomes = await Promise.all(
      [1, 2, 3].map(() => issueTestDocument(db.app, actor, documentId, key)),
    );
    expect(new Set(outcomes.map((o) => o.result.number)).size).toBe(1);
    expect(outcomes.filter((o) => o.replayed)).toHaveLength(2);
    expect((await stateOf(documentId)).issues).toHaveLength(1);
  });

  it("AT-04 (part 2): pressing Issue twice consumes one number and both responses show it", async () => {
    const documentId = await newDraft();
    const before = await db.app
      .selectFrom("number_series")
      .select("next_value")
      .where("series", "=", "test_document")
      .executeTakeFirstOrThrow();

    const first = await issueTestDocument(db.app, actor, documentId, randomUUID());
    const second = await issueTestDocument(db.app, actor, documentId, randomUUID()); // e.g. another tab
    expect(second.result).toEqual({ documentId, number: first.result.number, status: "already_issued" });

    const sameKey = randomUUID();
    const third = await issueTestDocument(db.app, actor, documentId, sameKey);
    const fourth = await issueTestDocument(db.app, actor, documentId, sameKey); // double click
    expect(fourth.replayed).toBe(true);
    expect(fourth.result.number).toBe(third.result.number);

    const after = await db.app
      .selectFrom("number_series")
      .select("next_value")
      .where("series", "=", "test_document")
      .executeTakeFirstOrThrow();
    expect(BigInt(after.next_value) - BigInt(before.next_value)).toBe(1n);
    expect((await stateOf(documentId)).issues).toHaveLength(1);
  });

  it("concurrent issue requests with different keys still allocate exactly one number", async () => {
    const documentId = await newDraft();
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => issueTestDocument(db.app, actor, documentId, randomUUID())),
    );
    expect(outcomes.filter((o) => o.result.status === "issued")).toHaveLength(1);
    expect(new Set(outcomes.map((o) => o.result.number)).size).toBe(1);
    expect(await findNumberGaps(db.app, "test_document")).toEqual([]);
  });

  it("issued records cannot be changed by the application role", async () => {
    expect((await sqlErrorAs(db.appUrl, "UPDATE test_document_issue SET number_text = 'X'"))?.code).toBe(
      "42501",
    );
    expect((await sqlErrorAs(db.appUrl, "DELETE FROM test_document_issue"))?.code).toBe("42501");
    expect((await sqlErrorAs(db.appUrl, "DELETE FROM issued_number"))?.code).toBe("42501");
  });

  it("a draft can be edited before issue but not after", async () => {
    const documentId = await newDraft("10.00");
    await updateTestDocumentDraft(db.app, actor, documentId, { title: "edited", amount: "11.00" });
    await issueTestDocument(db.app, actor, documentId, randomUUID());
    const error = await updateTestDocumentDraft(db.app, actor, documentId, {
      title: "late",
      amount: "12.00",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe("document_already_issued");
    const issue = (await stateOf(documentId)).issues[0]!;
    expect(issue.snapshot).toMatchObject({ title: "edited", amount: "11.00" });
  });
});
