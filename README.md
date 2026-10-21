# Garage Management System

Operations platform for an independent car repair garage in Sharjah, UAE.
Arabic and English, AED, Asia/Dubai.

The specification lives in [`docs/spec/`](docs/spec). Where documents disagree, the latest wins:
[`06-amendment-v0.2.2.md`](docs/spec/06-amendment-v0.2.2.md) amends everything before it.

## Status

**Increment 0 — engineering foundations.** No garage workflow yet. See
[`docs/increment-0-plan.md`](docs/increment-0-plan.md) for scope and acceptance criteria.

| Step | What                                           | Where                                            |
| ---- | ---------------------------------------------- | ------------------------------------------------ |
| S0   | Scaffold, migrations, test database            | `db/`, `src/server/db/`, `tests/setup/`          |
| S1   | Least-privilege database roles                 | `db/bootstrap.sql`, grants in migrations         |
| S2   | Money/quantity types, pool rule, business date | `src/server/core/money.ts`, `pool.ts`            |
| S3   | Append-only audit log                          | `audit_event` table, `CommandContext.audit`      |
| S4   | Command runner: transaction, lock order, retry | `src/server/command/`                            |
| S5   | Idempotency                                    | `src/server/command/runner.ts`, `idempotency.ts` |
| S6   | Document numbering                             | `src/server/numbering/`                          |
| S7   | Outbox (side effects after commit)             | `src/server/outbox/`                             |
| S8   | Stub "test document" command                   | `src/server/test-document/`                      |
| S9   | Staff login, roles, server-side authorization  | `src/server/auth/`, `src/server/http/`           |
| S10  | Arabic/English scaffolding, login page         | `src/i18n/`, `src/app/`                          |

## Stack

TypeScript (strict) · Node 22 · PostgreSQL 16+ · Kysely with plain SQL migrations · Next.js ·
Vitest against a real PostgreSQL.

## Getting started

```bash
npm install                 # on your Mac, installs the macOS binaries
npm test                    # starts an embedded PostgreSQL automatically; no Docker needed
npm run check               # typecheck + lint + format check + tests
npx playwright install chromium   # once, for the browser tests
npm run test:e2e            # browser tests: AR/EN flows at desktop and tablet widths
```

Run the app locally:

```bash
cp .env.example .env
npm run db:dev              # embedded PostgreSQL in .data/pg; prints DATABASE_URL lines for .env
npm run user:create -- --username partner.a --name "Partner A" --roles partner
npm run dev                 # http://localhost:5001
```

To run tests against your own PostgreSQL (for example Docker) instead of the embedded one, set
`TEST_DATABASE_ADMIN_URL` to a superuser URL. Tests create and drop databases named `garage_t_*`.

## Rules every change follows

1. **All state changes go through `runCommand`.** One transaction holds the writes, the audit
   events, the outbox messages, any number allocation and the idempotency record.
2. **Every command writes at least one audit event**, or it is rejected.
3. **External side effects only via the outbox**, never inside a command.
4. **Locks are taken through `ctx.locks` in canonical order**:
   repair order → invoices ↑ → revision lines ↑ → stock ↑ → number series.
5. **Money and quantities are never JavaScript numbers.** Use `Money` / `Qty`; split amounts
   with the pool rule (`src/server/core/pool.ts`).
6. **The application connects as `garage_app`**, which cannot create, alter or drop anything
   and cannot update or delete issued documents or the audit log. Migrations run as
   `garage_owner`. Applied migrations are never edited.
7. **Authorization is checked on the server** in every handler (`authorize`).

## Open items carried forward

- Owner decisions B-01, B-04, B-08, B-09, D-33 are needed before Increments 1–3
  (see `docs/spec/05-final-consistency-review.md`).
- Number format and reset rules, rounding method: UAE tax-agent verification (V-2).
- Inventory costing method: accountant verification (V-3).
- Arabic digits (D-28): Western digits are used until decided (`src/i18n/format.ts`).
- Quantity precision of 3 decimals is an assumption to confirm before stock work.
- Production bootstrap of partner accounts and 2FA (P1-03) — Increment 5.
- Backups, point-in-time recovery and audit export to the other partner — Increment 5.
