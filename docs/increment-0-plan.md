# Garage Management System — Increment 0 Readiness Package

| Item | Value |
|---|---|
| Date | 15 October 2026 |
| Baseline | PRD v0.2 + v0.2.1 + Pre-Implementation Review + Final Consistency Review |
| Contents | Part A: Specification amendment v0.2.2 (P0 findings incorporated) · Part B: Repository assessment · Part C: Increment 0 implementation plan · Part D: Decisions needed before coding |
| Status | **For approval. No files in the repository have been created or changed.** |

---

## Part A — Specification Amendment v0.2.2

This amendment replaces only the clauses cited. Everything else in v0.2, v0.2.1 and the two reviews stands. Where two documents conflict, v0.2.2 wins.

### A.1 Rounding and pool rule (replaces Pre-Impl P0-07 rule 1, P0-08 rule 2, P0-09 rules 3–4; implements F-01, F-02)

While writing the formulas, I found that "recalculate the average from stock value ÷ qty" (P0-09 rule 4) contradicts the expected values in T-02. Recalculating the average after every issue gives 3.33, 3.34, 3.33, while T-02 expects 3.33, 3.33, 3.34. One rule now governs every place where an amount is split across quantities:

**Pool rule.** A *pool* holds a quantity and a value. Its **basis unit** is value ÷ quantity, held at full precision.
1. The basis unit is recalculated **only when units enter the pool** (inbound).
2. Units leaving the pool (outbound) take round-half-up(basis unit × qty) to 2 decimals.
3. The movement that takes the pool's quantity to zero takes the **entire remaining value**.
4. A pool's value can never be negative, and its quantity can never be negative.

| Pool | Inbound (recalculates basis) | Outbound |
|---|---|---|
| **Stock** (per part) | Goods receipt; return from job; credit-note return to stock | Issue to job; adjustment out |
| **Job-line WIP** (per part revision line) | Issue to the line | Billing (to COGS); return from job (to stock) |
| **Line COGS** (per part revision line) | Billing | Quantity credit (to stock if returned; otherwise back to line WIP) |
| **Invoice line amounts** (net and tax, per invoice line) | Invoice issue (fixed) | Credit-note lines. Basis = original line amount ÷ invoiced qty; final credit takes the remainder (P0-08) |

**Consequences:**
- Billing and every return use the same line cost (F-01, Option A). WIP cannot go negative.
- A credit-note return enters stock at the line's COGS basis, which is the cost recorded when those units were billed.
- A quantity credit without physical return moves value from line COGS back to line WIP. The close sweep (v0.2.1 §4.3) then classifies it.
- Costing method itself remains subject to [V] V-3.

**Corrected tests:**

| Test | Expected values |
|---|---|
| **AT-13 / T-01** | Issues 1 @ 8.00 and 1 @ 9.00 → line WIP 17.00, basis 8.50. Return 1 → 8.50 to stock; WIP 8.50. Bill 1 (exhausts WIP) → COGS 8.50; WIP 0.00 |
| **AT-17 / T-02** | Receive 3 for 10.00 (basis 3.333333). Issue 1 → 3.33; issue 1 → 3.33; issue 1 (exhausts) → 3.34. Stock 0 / 0.00. Σ issues = 10.00 |
| **AT-16 / T-03** | Line qty 3, net 10.00, tax 0.50. Credits of 1, 1, 1 → net 3.33, 3.33, 3.34; tax 0.17, 0.17, 0.16. Exact values only |

### A.2 Funds invariant (supersedes Pre-Impl P0-05 rule 1 and the v0.2.1 §4.2 guards where they differ; implements F-03, F-04)

For each invoice: *P* = payments − reversals · *R* = completed refunds · *O* = refunds in Requested or Approved · *A_in*, *A_out* = credit applied in/out, net of application reversals.

- **Funds F** = P + A_in − R − A_out
- **Balance B** = (T − C) − F
- **Available credit** = max(−B, 0) − O

**Invariant:** after every balance-changing command, for every invoice the command touches, **F ≥ O** and **available credit ≥ 0**. The check runs inside the command's transaction, after locks are taken in the standard order. If it fails, the command is rejected, nothing is saved, and the error names the blocking record (refund or credit application).

Balance-changing commands: payment, payment reversal, credit note issue, refund request / approval / completion / failure / cancellation, credit application, credit application reversal. Credit application reversal (Pre-Impl P0-05 rule 2) remains the mechanism for unwinding applications.

### A.3 Idempotency (amends Pre-Impl P0-02; implements F-07)

1. The idempotency record is the **first write** inside the command's transaction, with a unique constraint on (command type, key).
2. A concurrent request with the same key waits on that unique constraint.
   - If the first transaction commits: compare payload hashes. Same → return the stored result. Different → reject.
   - If the first transaction rolls back: the waiting request proceeds as a new command.
3. The command's result is stored on the idempotency record **in the same transaction**. A response lost after commit is recovered by retrying with the same key.
4. Keys are client-generated per form instance. Retention 7 days [R].

### A.4 Approval integrity (amends v0.2.1 §3.5, §3.7 and Pre-Impl P0-10, P1-06; implements F-10, F-11, F-12)

- **Contact change (F-10, now P0).** Changing a repair order's authorized contact, in the same transaction:
  - Revokes every open customer link for that repair order.
  - Voids every pending ApprovalAttempt.
  - Every ApprovalEvent stores a snapshot of the authorized contact (name, mobile) in effect when it was created.
- **Step-up race (F-11).** Every approval submission (link, phone, in person) locks the repair-order row first, per the standard lock order. The cumulative L1 total is computed under that lock.
- **Phone approval level (F-12).** Each phone approval records call direction and the number used.
  - **L2** only for an **outbound** call to the authorized contact's mobile on file.
  - Every other call is **L1**. It counts toward the cumulative threshold and follows the same step-up rules as links.
  - Atomic confirmation (v0.2.1 §3.5) still applies. Evidential value is subject to [V] V-4.

### A.5 Tests added or changed

AT-13, AT-16, AT-17 are corrected as in A.1. T-04, T-05, T-07, T-08, T-09, T-10 from the Final Consistency Review are adopted unchanged as acceptance tests.

---

## Part B — Repository Assessment

**Inspected:** `~/IdeaProjects/garage-system`, after you granted access to it.

| Area | Finding |
|---|---|
| Contents | **Empty.** No files and no subfolders. |
| Version control | Not a git repository. |
| Framework and dependencies | None. No `package.json` or any other manifest. |
| Application structure | None. |
| Database and migrations | None. No schema, migrations, or connection configuration. |
| Tests | None. |
| Configuration and security | Nothing to assess yet. Gaps to address in S0: `.gitignore` covering secrets, `.env.example` only (no real secrets committed), separate database roles. |
| Existing implementation to preserve | None. Nothing will be replaced. |

**Environment observed** (the Linux shell I work in on your Mac, not your Mac's own toolchain):
- Node 22.23.2, npm 10.9.8, git 2.34.1 and Python 3.10 are available.
- Docker and PostgreSQL client are not available.
- The npm registry is reachable.

I can't see whether your Mac itself has Docker or PostgreSQL installed.

**Practical constraint.** Git in the connected folder needs permission to delete its own lock files. Without it, commits leave `.lock` files behind. Either grant deletion for this folder once, or run git commands yourself (D-S3).

---

## Part C — Increment 0 Implementation Plan

### C.1 Proposed stack (greenfield — needs your confirmation, D-S1)

| Layer | Recommendation | Reason |
|---|---|---|
| Database | **PostgreSQL 16+** | **Required by the spec, not a preference.** It provides row locks, partial unique indexes, per-table `GRANT`/`REVOKE` (insert-only audit), row `CHECK` constraints, transactional DDL and exact `numeric` |
| Language / runtime | TypeScript (strict), Node 22 LTS | Already present; matches the Prisma references in your earlier instructions |
| Data access | **Kysely + plain SQL migrations** (recommended) *or* Prisma | The integrity core is SQL-heavy: `SELECT … FOR UPDATE`, partial indexes, `REVOKE`, `CHECK`. Prisma supports these only through raw SQL, so the safety-critical code would mostly be raw strings outside its type checking. Kysely keeps that SQL typed and explicit. Prisma remains workable if you prefer it |
| Web | Next.js (App Router) | Only a login page is needed in Increment 0. Domain and infrastructure code live in framework-free modules, so the framework never touches transaction logic |
| Tests | Vitest against a **real PostgreSQL**, via `embedded-postgres` (no Docker needed) or a Docker database on your Mac through `DATABASE_URL` | The concurrency and rollback tests are meaningless against mocks |
| Passwords / sessions | Argon2id; server-side sessions stored hashed in the database | Immediate revocation on deactivation (AC2-29) |

### C.2 Scope

**In Increment 0:**
- Command framework (transaction, lock order, retry, audit, outbox)
- Idempotency
- Document numbering
- Money, cost and business-date primitives, including the pool rule
- Database roles and privileges
- Staff login with the six fixed roles and server-side authorization
- Arabic/English scaffolding with a bilingual login page
- One stub "test document" command that exercises all of the above

**Not in Increment 0:**
- Customers, vehicles, repair orders, estimates, invoices, payments, stock
- Toggles, 2FA, dual control
- PDFs
- Backups and audit export (Increment 5)

### C.3 Steps

Each step is small, testable on its own, and ends with tests I run and report from actual output.

**S0 — Project scaffold**
- `git init`; TypeScript strict; lint/format; Vitest; `.gitignore`; `.env.example`
- Test database bootstrap; migration runner; `docs/spec/` holding the spec documents including v0.2.2 (D-S4)
- **AC:** `npm test` runs a smoke test that connects to a real PostgreSQL and passes. Migrations apply to an empty database and re-running them is a no-op. No secrets are tracked.

**S1 — Database roles**
- Owner role (migrations only) and application role (least privilege)
- **AC:** the application role cannot `CREATE`, `ALTER` or `DROP` (test asserts the error). Migrations run only as the owner role.

**S2 — Primitives**
- Money (2 dp) and cost (6 dp) types with no floating point; round-half-up
- Pool rule (A.1)
- Business date = Asia/Dubai date of the database transaction timestamp (P1-07)
- **AC:**
  - A.1 table values reproduced exactly: T-01, T-02, T-03 arithmetic as unit tests.
  - Floats are rejected at the boundary.
  - A transaction committed at 19:59:59 UTC has business date D; one at 20:00:00 UTC has D+1.

**S3 — Audit log**
- Append-only table with a monotonically increasing sequence; application role granted `INSERT`/`SELECT` only
- **AC:**
  - `UPDATE`/`DELETE` as the application role fail.
  - An audit event written in a transaction that rolls back does not exist.
  - Sequence numbers strictly increase across concurrent writers.

**S4 — Command runner**
- One transaction per command; lock-order helper (repair order → invoices ↑ → revision lines ↑ → stock ↑ → number sequence)
- Single automatic retry on deadlock or serialization failure; audit event required for every command
- **AC:**
  - An induced deadlock is retried once and succeeds.
  - A second consecutive deadlock surfaces a "try again" error with nothing saved.
  - A command that writes no audit event fails its test.
  - The lock helper always acquires in canonical order regardless of input order.

**S5 — Idempotency (A.3)**
- **AC:**
  - AT-03: three concurrent identical requests produce one record, and all three responses carry the same ID.
  - AT-04 (part 1): same key with a different payload is rejected and nothing is created.
  - T-04: commit succeeds, the response is dropped (fault injection), and a retry with the same key returns the stored result with no duplicate.
  - First request rolls back → the waiting duplicate proceeds as new.
  - Keys older than the retention period are purged by a job and the purge is tested.

**S6 — Numbering**
- One locked counter row per series; allocated inside the issuing transaction
- Unique (series, number); separate series for invoice, credit note, release note and service record (F-09)
- Format and reset rules are configuration, pending [V] V-2
- **AC:**
  - AT-01: a rollback after allocation consumes no number, and the next issue receives it.
  - 50 concurrent issues on one series produce 1…50 with no gaps or duplicates.
  - Series are independent of each other.

**S7 — Outbox**
- Outbox row written in the command transaction; processor with retries and backoff; handlers idempotent
- **AC:**
  - AT-02: a rolled-back command leaves no outbox row and no side effect.
  - A failing handler is retried until it succeeds.
  - Re-delivering the same outbox item does not repeat its effect.

**S8 — Stub "test document" command**
- Draft → Issued using S3–S7; issued rows not updatable by the application role
- **AC:**
  - AT-01, AT-02, AT-03 and T-04 pass end to end.
  - AT-04 (part 2): pressing Issue twice consumes one number, and both responses show it.
  - An `UPDATE` to an issued row as the application role fails.

**S9 — Authentication and roles**
- Staff users; Argon2id; hashed server-side sessions
- Six fixed roles: Partner, Manager, Service advisor, Technician, Store keeper, Accountant
- Server-side permission guard; a development-only CLI to create the first user (production bootstrap stays P1-03)
- **AC:**
  - Login and logout work.
  - A wrong username or password gets the same generic error.
  - AC2-29: a deactivated user's next request is rejected.
  - A role lacking a permission is denied at the server even when calling the endpoint directly, and the attempt is audited.
  - Session tokens are stored only as hashes.
  - Passwords and tokens never appear in logs (test asserts against captured logs).

**S10 — Arabic/English scaffolding**
- Message catalogs; `dir="rtl"`/`"ltr"`; AED and Asia/Dubai formatters; bilingual login page
- **AC:**
  - A missing-key check fails the build for any untranslated key.
  - The login page renders RTL in Arabic and LTR in English.
  - Formatter tests cover AED amounts and Dubai dates.

**Exit criterion for Increment 0:** S0–S10 acceptance tests run against a real PostgreSQL. Results are reported from the actual test output, and anything not run is listed as not run.

### C.4 Mechanisms delivered and tested

| Mechanism | Type | Step | Tests |
|---|---|---|---|
| Single transaction per command incl. audit | Transaction | S4, S8 | AT-01 |
| Side effects only after commit | Outbox | S7 | AT-02 |
| Idempotency key first in transaction; payload hash | Unique constraint + transaction | S5 | AT-03, AT-04, T-04 |
| Canonical lock order; single retry | Row locks | S4 | Deadlock tests |
| Gap-free numbering per series | Locked counter row + unique (series, number) | S6 | AT-01, concurrency test |
| Issued records immutable | Privileges (no `UPDATE`/`DELETE` for app role) | S8 | Privilege test |
| Append-only audit with sequence | Privileges + sequence | S3 | Audit tests |
| Least-privilege database roles | `GRANT`/`REVOKE` | S1 | Role tests |
| Exact money/cost; pool rule | Types + pure functions | S2 | T-01, T-02, T-03 arithmetic |
| Business date from transaction time | Database timestamp | S2 | Midnight boundary test |
| Server-side authorization; immediate revocation | Session table + guard | S9 | AC2-29, denial tests |

**Deferred to the increments that use them:**
- Funds invariant (A.2): Increment 3
- Approval integrity (A.4): Increment 2
- Stock and line pools as persisted ledgers (A.1): Increments 1 and 4

The arithmetic for these is already tested in S2.

---

## Part D — Decisions Needed Before I Modify Files

| ID | Decision | Recommendation |
|---|---|---|
| **D-S1** | Confirm stack: TypeScript / Node 22 / PostgreSQL 16+ / Next.js. Data access: **Kysely + SQL migrations** or **Prisma** | Kysely + SQL migrations |
| **D-S2** | Test database: `embedded-postgres` (runs in my environment; no Docker), Docker on your Mac, or both via `DATABASE_URL` | Both; `embedded-postgres` as default |
| **D-S3** | Git: grant deletion permission for `garage-system` so git can manage its lock files, or you run git commands yourself | Grant deletion for this folder only |
| **D-S4** | Store the specification documents (v0.2, v0.2.1, both reviews, v0.2.2) in `docs/spec/` in the repository | Yes |
| **D-S5** | Approve the v0.2.2 amendment in Part A, including the pool-rule clarification | — |

No owner business decisions (B-01, B-08, B-09, D-33) are needed for Increment 0. B-04 (who holds production credentials) does not block Increment 0, because S1 creates the roles generically.
