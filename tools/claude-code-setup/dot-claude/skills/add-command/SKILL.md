---
description: Checklist for adding a state-changing command (anything that writes to the database). Use for every new service function that changes data.
---

Adding a command (see `src/server/test-document/service.ts` for the reference pattern):

1. Validate input **before** the transaction (types, ranges, `Money.parse` / `Qty.parse`, UUIDs). Throw
   `ValidationError`.
2. Call `runCommand(db, { name: "<module>.<verb>", actor, idempotency? }, async (ctx) => { … })`.
   - Money, stock, numbering and approval commands: pass `idempotency: { key, payload }`; the payload is the
     validated request.
3. Inside the command, in this order:
   1. `ctx.locks.acquire(...)` for every row whose state or limit you check — canonical order only.
   2. Re-read state after locking; enforce the rule; throw `ConflictError` with a stable `code` when it fails.
   3. Write. Snapshot anything a document must remember (prices, tax, names) into the document row.
   4. `allocateNumber(ctx, series, …)` last if a number is needed.
   5. `ctx.audit({ action, entityType, entityId, before, after })` — at least once.
   6. `ctx.enqueue(topic, payload)` for PDFs, messages or anything external.
   7. Return a small JSON result (it is stored for idempotent replays).
4. Expose it through `src/server/http/handlers.ts` with `authorize(db, session, "<permission>")`, add the permission to
   `src/server/auth/permissions.ts`, and add a thin Next route file.
5. Tests (real database, `tests/helpers/db.ts`):
   - happy path with the audit event and outbox message asserted
   - every rule violated once (expect the error code and that nothing was written)
   - authorization: a role without the permission gets 403 and an `authz.denied` audit row
   - idempotency: same key twice → same result, one record
   - concurrency: two requests racing for the same limit → exactly one succeeds
   - fault injection with `hooks.beforeCommit` for anything that allocates numbers or moves money
6. Run `npm run check`.
