# Garage Management System — guidance for Claude Code

Operations platform for an independent car repair garage in Sharjah, UAE (two partners, single branch).
Arabic (RTL) and English, AED, Asia/Dubai.

## Read first

- Implementation plan and current increment: @docs/implementation-plan.md
- Specification (later documents win when they disagree): `docs/spec/` — newest is
  `docs/spec/06-amendment-v0.2.2.md`. Do not paste the specs into context wholesale; open the section you need.
- Decisions taken and still open: @docs/decisions.md

## Stack

TypeScript (strict) · Node 22 · PostgreSQL 16+ · Kysely with plain SQL migrations (`db/migrations`) · Next.js App Router
(`src/app`) · Vitest against a real PostgreSQL (embedded automatically; no Docker needed).

## Commands

- `npm run check` — typecheck + lint + format check + all tests. **Must pass before every commit.**
- `npm test` / `npx vitest run tests/<file>` — tests (starts an embedded PostgreSQL by itself)
- `npm run typecheck`, `npm run lint`, `npm run format`
- `npm run build` — Next.js production build
- `npm run db:dev` then `npm run dev` — run the app locally (see README)

## Where things live

- `src/server/command/` — `runCommand` (transaction, audit, outbox, idempotency, retry) and `LockSet`
- `src/server/core/` — `Money`, `Qty`, pool rounding rule, errors, logger, canonical JSON
- `src/server/numbering/` — document numbers; `src/server/outbox/` — after-commit side effects
- `src/server/auth/` — sessions, roles, permissions, `authorize`
- `src/server/http/handlers.ts` — HTTP handlers (Next route files only forward to these)
- `src/server/<module>/` — one folder per business module (e.g. `repair-order/`, `estimate/`, `billing/`)
- `src/i18n/` — catalogs `messages/{ar,en}.json`, `t()`, formatters
- `tests/sN-*.test.ts` — one file per step/story; helpers in `tests/helpers/`

## Non-negotiable rules

1. **Every state change goes through `runCommand`.** One transaction holds the writes, audit events, outbox messages,
   number allocation and the idempotency record. Never write to the database outside a command (reads are fine).
2. **Every command records at least one audit event** (`ctx.audit`). The runner rejects commands that don't.
3. **No external side effects inside a command** (PDFs, messages, HTTP calls). Use `ctx.enqueue` (outbox).
4. **Lock through `ctx.locks.acquire` in canonical order**: vehicle ↑ → repair order → invoice ↑ → revision line ↑ →
   stock ↑ → number series (vehicle first: decision T-04). Register new lock kinds in `LOCK_RANK`/`LOCK_TARGETS`; never take a lower rank after a higher one.
5. **Money and quantities are never JavaScript numbers.** Use `Money` / `Qty` and split amounts with the pool rule
   (`src/server/core/pool.ts`). Store money as `numeric(14,2)`, quantities as `numeric(18,3)`.
6. **Issued documents are immutable.** Corrections are new records (credit notes, reversals). The app role has no
   UPDATE/DELETE on issued tables or the audit log — keep it that way in every migration.
7. **Migrations are append-only.** Never edit a file in `db/migrations` that is committed; add a new one. Every new table
   needs explicit grants to `garage_app` (least privilege) in the same migration.
8. **Authorization is checked on the server** in every handler with `authorize`. UI hiding is not security.
9. **Customer-facing output never contains internal notes, costs or staff data.** Use separate fields.
10. **All user-visible text goes through `t()`** with keys in both `ar.json` and `en.json`. Use CSS logical properties
    (`margin-inline-start`, not `margin-left`).
11. **Money/stock/approval commands take an idempotency key** (UUID per form instance).
12. **Do not invent business rules, tax rules or legal wording.** If the spec does not decide something, stop and ask;
    record the answer in `docs/decisions.md`. Items marked [V] in the spec need a UAE tax agent, accountant or lawyer.

## How to work on a story

1. Start in plan mode. Read the story in `docs/implementation-plan.md` and the spec sections it cites.
2. Propose: schema changes, commands, lock order, audit events, permissions, i18n keys, and the tests that prove each
   acceptance criterion (including negative, authorization and concurrency cases).
3. Implement migration → server module → handlers → UI → tests. Keep changes inside the story's scope.
4. Run `npm run check`. Never claim a test passed without running it and reading the output.
5. Ask the `integrity-reviewer` subagent to review the diff; fix what it finds.
6. Commit on a feature branch with a message naming the story ID. Do not push or merge without the owner's say-so.

## Things to avoid

- Floats, `parseFloat`, `Number()` on money; `Date` arithmetic for business dates (use `business_date_of(now())`).
- `SELECT … FOR UPDATE` written by hand in commands — use `ctx.locks`.
- Catching and swallowing errors inside commands (the runner's rollback and retry depend on them propagating).
- Adding dependencies without saying why; ORMs; client-side state libraries before they are needed.
- Reading `.env` files or printing secrets, tokens or passwords in logs or test output.
