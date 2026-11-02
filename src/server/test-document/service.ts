import type { Kysely } from "kysely";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { DecimalInputError, Money } from "../core/money";
import { allocateNumber } from "../numbering/numbering";
import { runCommand, type Actor, type CommandOutcome, type RunCommandOptions } from "../command/runner";
import type { DB } from "../db/schema";

/**
 * Stub "test document" (S8). It has no business meaning; it exists so the command pattern —
 * transaction, locks, audit, idempotency, numbering, outbox, immutability — is built and
 * tested once before real documents (invoices, credit notes) reuse it.
 */

export interface TestDocumentInput {
  title: string;
  amount: string;
}

function validate(input: TestDocumentInput): { title: string; amount: Money } {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title.length < 1 || title.length > 200) {
    throw new ValidationError("Title must be 1–200 characters");
  }
  let amount: Money;
  try {
    amount = Money.parse(input.amount);
  } catch (error) {
    if (error instanceof DecimalInputError) throw new ValidationError(error.message);
    throw error;
  }
  if (amount.isNegative()) {
    throw new ValidationError("Amount cannot be negative");
  }
  return { title, amount };
}

export type CreateResult = { documentId: string };

export async function createTestDocument(
  db: Kysely<DB>,
  actor: Actor,
  input: TestDocumentInput,
  idempotencyKey: string,
): Promise<CommandOutcome<CreateResult>> {
  const { title, amount } = validate(input);
  return runCommand(
    db,
    {
      name: "test_document.create",
      actor,
      idempotency: { key: idempotencyKey, payload: { title, amount: amount.toString() } },
    },
    async (ctx) => {
      const row = await ctx.tx
        .insertInto("test_document")
        .values({
          title,
          amount: amount.toString(),
          created_by: actor.kind === "user" ? actor.userId : null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await ctx.audit({
        action: "test_document.created",
        entityType: "test_document",
        entityId: row.id,
        after: { title, amount: amount.toString() },
      });
      return { documentId: row.id };
    },
  );
}

export async function updateTestDocumentDraft(
  db: Kysely<DB>,
  actor: Actor,
  documentId: string,
  input: TestDocumentInput,
): Promise<CommandOutcome<{ documentId: string }>> {
  const { title, amount } = validate(input);
  return runCommand(db, { name: "test_document.update_draft", actor }, async (ctx) => {
    await ctx.locks.acquire("test_document", [documentId]);
    const issued = await ctx.tx
      .selectFrom("test_document_issue")
      .select("number_text")
      .where("document_id", "=", documentId)
      .executeTakeFirst();
    if (issued) {
      throw new ConflictError(
        "document_already_issued",
        `Document ${issued.number_text} is issued and cannot change`,
      );
    }
    const before = await ctx.tx
      .selectFrom("test_document")
      .select(["title", "amount"])
      .where("id", "=", documentId)
      .executeTakeFirstOrThrow();
    await ctx.tx
      .updateTable("test_document")
      .set({ title, amount: amount.toString() })
      .where("id", "=", documentId)
      .execute();
    await ctx.audit({
      action: "test_document.draft_updated",
      entityType: "test_document",
      entityId: documentId,
      before: { title: before.title, amount: before.amount },
      after: { title, amount: amount.toString() },
    });
    return { documentId };
  });
}

export type IssueResult = {
  documentId: string;
  number: string;
  status: "issued" | "already_issued";
};

export async function issueTestDocument(
  db: Kysely<DB>,
  actor: Actor,
  documentId: string,
  idempotencyKey: string,
  hooks?: RunCommandOptions["hooks"],
): Promise<CommandOutcome<IssueResult>> {
  return runCommand(
    db,
    {
      name: "test_document.issue",
      actor,
      idempotency: { key: idempotencyKey, payload: { documentId } },
      hooks,
    },
    async (ctx) => {
      await ctx.locks.acquire("test_document", [documentId]);

      // A second "Issue" with a different key (e.g. another browser tab) returns the same
      // number instead of allocating a new one (AT-04 part 2).
      const existing = await ctx.tx
        .selectFrom("test_document_issue")
        .select("number_text")
        .where("document_id", "=", documentId)
        .executeTakeFirst();
      if (existing) {
        await ctx.audit({
          action: "test_document.issue_repeated",
          entityType: "test_document",
          entityId: documentId,
          details: { number: existing.number_text },
        });
        return { documentId, number: existing.number_text, status: "already_issued" as const };
      }

      const draft = await ctx.tx
        .selectFrom("test_document")
        .select(["id", "title", "amount"])
        .where("id", "=", documentId)
        .executeTakeFirst();
      if (!draft) {
        throw new NotFoundError("test_document", documentId);
      }

      const number = await allocateNumber(ctx, "test_document", { type: "test_document", id: documentId });
      const snapshot = { documentId, title: draft.title, amount: draft.amount, number: number.text };
      await ctx.tx
        .insertInto("test_document_issue")
        .values({
          document_id: documentId,
          series: number.series,
          number_value: number.value,
          number_text: number.text,
          business_date: ctx.businessDate,
          issued_by: actor.kind === "user" ? actor.userId : null,
          snapshot: JSON.stringify(snapshot),
        })
        .execute();
      await ctx.audit({
        action: "test_document.issued",
        entityType: "test_document",
        entityId: documentId,
        after: snapshot,
      });
      // Rendering the PDF is an external side effect: it happens after commit, via the outbox.
      await ctx.enqueue("test_document.issued", { documentId, number: number.text });
      return { documentId, number: number.text, status: "issued" as const };
    },
  );
}
