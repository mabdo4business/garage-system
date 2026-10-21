# Garage Management System — Full Implementation Plan (Claude Code)

| Item | Value |
|---|---|
| Date | 15 October 2026 |
| Baseline | Specification amendment v0.2.2 and everything it amends (`docs/spec/`) |
| Status | Increment 0 complete on `feature/increment-0` (80 tests passing). This plan covers Increments 1–6 and the move to Claude Code. |
| Scope rule | Nothing here adds features beyond the PRD's launch scope (P0) and the first-month items (P1). |
| Progress | Tracked per story in `docs/roadmap.md`, which also holds the proposed customer tracks (website, portal, mobile app) |

Effort is relative (S / M / L) because budget and calendar are not set. Each increment ends with a working, tested
build; nothing is "half done" between increments.

---

## Part 1 — Moving to Claude Code

### 1.1 One-time setup on your Mac

1. Push the branch: `git push -u origin feature/increment-0`, open a PR to `qa`, review, merge.
2. Install Claude Code — follow the official guide: <https://code.claude.com/docs/en/overview>.
3. In the project folder:
   ```bash
   npm install                                  # installs the macOS builds of native packages
   npm run check                                # must end with "Tests 80 passed"
   bash tools/claude-code-setup/install.sh      # copies the files into .claude/ and .github/
   git add .claude .github && git commit -m "Add Claude Code project configuration and CI"
   claude                                       # start Claude Code in the repository
   ```
4. Inside Claude Code, run `/memory` once to confirm it has loaded `CLAUDE.md`, and `/hooks` to confirm the format hook.
5. Push; from then on every PR runs `npm run check` and a production build in GitHub Actions.

### 1.2 Claude Code files (in the repository after step 3)

| File | Purpose |
|---|---|
| `CLAUDE.md` | Project memory: stack, commands, folder map, the 12 non-negotiable rules, how to work on a story |
| `docs/implementation-plan.md` | This plan — story IDs, scope, acceptance tests, dependencies |
| `docs/decisions.md` | Decided and open owner decisions and professional verifications |
| `.claude/settings.json` | Allows the test/lint/build commands without prompting; blocks reading `.env`, `git push` and `npm publish`; runs Prettier after every edit |
| `.claude/hooks/format-file.mjs` | The formatting hook |
| `.claude/skills/start-story/` | `/start-story I1-05` — reads the story, checks decisions, plans, waits for approval, implements, tests, reviews, commits |
| `.claude/skills/add-migration/` | Checklist Claude follows for every schema change (grants, types, lock registration, tests) |
| `.claude/skills/add-command/` | Checklist for every state-changing command (locks, audit, outbox, idempotency, tests) |
| `.claude/agents/integrity-reviewer.md` | Independent reviewer subagent that checks the diff against the rules before each commit |
| `.github/workflows/ci.yml` | CI: `npm ci`, `npm run check`, `npm run build` |

References: memory files <https://code.claude.com/docs/en/memory>, skills <https://code.claude.com/docs/en/skills>,
subagents <https://code.claude.com/docs/en/sub-agents>, hooks <https://code.claude.com/docs/en/hooks-guide>,
settings <https://code.claude.com/docs/en/settings>.

### 1.3 Working rhythm — one story per session

```
/start-story I1-01
  → Claude reads the story + cited spec, checks docs/decisions.md
  → plan (schema, commands, locks, audit, permissions, UI, i18n, tests)      ← you approve or correct
  → implement: migration → server module → handlers → UI → tests
  → npm run check (real PostgreSQL)
  → integrity-reviewer subagent reviews the diff → fixes → npm run check
  → commit "I1-01: …" on story/I1-01-… branch                               ← you review and merge
```

Branches: `qa` ← `increment/N` ← `story/<ID>-<name>`. Merge stories into the increment branch; merge the increment
into `qa` when its exit criteria pass; `main` only after UAT.

### 1.4 Prompt templates

**Start a story** (preferred): `/start-story I2-03`

**Without the skill:**
> Read story I2-03 in docs/implementation-plan.md and the spec sections it cites. Check docs/decisions.md for the
> decisions it needs. Use plan mode: propose the migration, commands with lock order and audit actions, permissions,
> screens with Arabic and English keys, and a test for every acceptance criterion including negative, authorization and
> concurrency cases. Wait for my approval before writing code.

**Fix a failing test:**
> `npm run check` fails in tests/<file>. Read the failure, find the root cause, and fix the code — not the test —
> unless the test contradicts the spec. Explain which, with the spec reference.

**Review before merge:**
> Ask the integrity-reviewer subagent to review `git diff qa...HEAD`. Then list its findings and what you changed.

**Spec question:**
> The spec doesn't say what happens when <situation>. Don't decide it. Write the question, two options and their
> consequences, and add it to the Open table in docs/decisions.md.

### 1.5 Quality gates (apply to every story)

1. Acceptance tests exist for every criterion and run against a real PostgreSQL.
2. `npm run check` passes; the result is quoted from actual output.
3. `integrity-reviewer` has reviewed the diff; findings fixed or explained.
4. Screens work in Arabic (RTL) and English (LTR) on desktop and tablet widths.
5. No open decision was silently assumed.
6. You (an owner) review and merge — Claude never pushes or merges.

### 1.6 Guardrails specific to working with an AI coding agent

| Risk | Guardrail |
|---|---|
| Plausible but wrong business rules | Rule 12 in `CLAUDE.md`: never invent rules; open questions go to `docs/decisions.md` |
| Tests weakened to make them pass | "Fix the code, not the test" prompt; reviewer checks every test would fail without the rule |
| Scope creep inside a story | Story scope is listed below; reviewer flags anything outside it |
| Silent schema drift | Migrations append-only (runner rejects edited files); grants tested |
| Leaking secrets | `.env` reads denied in settings; logger redacts; no secrets in tests |
| Large unreviewable diffs | One story per branch; stories sized S–M; L stories split before starting |
| Context overload | `CLAUDE.md` points to sections, not whole specs; start a fresh session per story |

---

## Part 2 — Architecture for the remaining increments

### 2.1 Module map

```
src/server/
  command/  core/  db/  numbering/  outbox/  auth/  http/      ← Increment 0 (done)
  customer/        customers, vehicles, plates, ownership                     I1
  repair-order/    repair orders, check-in, media, findings, QC, delivery     I1–I2
  catalog/         labor rates, packages, parts catalogue, tax codes          I1
  estimate/        repair jobs, revisions, lines, versions, approvals         I1–I2
  workshop/        assignments, job execution, board                          I1
  inventory/       stock pools, movements, receipts, adjustments              I1, I4
  billing/         invoices, payments, credit notes, refunds, applications   I1, I3
  links/           customer link tokens, approval attempts                    I2
  documents/       print views, PDF rendering (outbox handler)               I1, I5
  admin/           toggles, dual control, settings, thresholds                I5
  reporting/       registers, exports, management reports                     I3, I6
src/app/[locale]/  staff screens (server components + small client islands)
src/app/c/[token]/ customer link pages (approval, status, invoice)           I2
```

### 2.2 UI implementation approach

- Server components for pages; small client components only where interaction needs them (estimate builder, photo
  capture, workshop board refresh). No client state library until one is clearly needed.
- Plain CSS with design tokens and logical properties (`docs/` UI/UX deck defines tokens); one shared component set:
  buttons, fields, status chips, money cell, plate badge, table, sheet/dialog, toast, empty state.
- Every form posts to a handler with an idempotency key generated when the form renders.
- Tablet-first for check-in and technician screens (48 px touch targets); desktop-first for the counter and reports.
- Customer pages: mobile-first, no login, minimal data, Arabic or English from the customer's preference.

### 2.3 Infrastructure decisions to make during the plan

| Topic | Recommendation | Needed by |
|---|---|---|
| Photo storage | Storage adapter: local disk in development; S3-compatible private bucket with short-lived signed URLs in production; region per V-1 | I1-02 (adapter), I5 (production) |
| PDF generation | HTML print views first (I1); PDF via headless Chromium in an outbox worker (I5) — reliable Arabic shaping | I5 |
| Hosting | Managed PostgreSQL with point-in-time recovery + a Node host; region decided after V-1 | I5 |
| Background worker | Same codebase, separate process running `processOutbox` on an interval | I2 |
| Error monitoring | Structured logs (existing logger) shipped to a log service; no personal data in logs | I5 |

---

## Part 3 — Increment plan

Legend per story: **Scope** · **Spec** (sections to read) · **Tests** (must exist and pass) · **Needs** (dependencies
and decisions) · Size.

### Increment 1 — Walking skeleton: one repair order end to end

**Goal:** register → check in → inspect → estimate → in-person approval → work → QC → invoice → pay → deliver, in
Arabic and English, with correct money and audit.
**Decisions first:** B-08 (non-stock items). **Exit:** a full repair order runs through the UI; P0-06 guard active;
all I1 tests pass.

| ID | Story | Scope | Spec | Tests | Needs | Size |
|---|---|---|---|---|---|---|
| I1-01 | Customers & vehicles | Customer (AR/EN name, mobile, language, marketing consent), vehicle (emirate/code/number plate, VIN, make/model/year), plate history, ownership, search by plate/mobile/name/VIN, duplicate warning | v0.2 EP-02, §7.2 #8 | Duplicate mobile warns; search < 2 s with 10k vehicles (seeded); ownership change keeps history; technician cannot read phone numbers | — | M |
| I1-02 | Repair order & check-in | Walk-in repair order, authorized contact, odometer, fuel, concerns, belongings, keys, photos (≥ configured minimum or reason), storage adapter, photos locked after check-in | v0.2 EP-04, v0.2.1 §3.4 | Fewer photos requires reason; photos not deletable by advisor/technician; authorized contact recorded; audit events | I1-01 | M |
| I1-03 | Inspection findings | Findings with severity (OK/Soon/Urgent), fault codes, photos, internal vs customer notes; seeded checklist templates | v0.2 EP-05 | Internal note never in customer output (AC2-31 pattern); urgent finding pre-selected in estimate | I1-02 | S |
| I1-04 | Catalog & tax | Labor rates, packages, parts catalogue (stock-tracked flag, non-stock with cost per B-08), TaxProfile + TaxCode with effective dates, VAT mode | v0.2.1 §4.4, Pre-Impl P0-06 | Price change does not alter sent estimates (AC2-12); tax code history; both VAT modes | B-08 | M |
| I1-05 | Estimate (single version) | RepairJob → JobRevision → RevisionLine; line discounts within advisor limit; totals; canonical snapshot + hash; in-person approval (signature) → ApprovalEvent + RevisionDecision | v0.2.1 §2, Amendment A.4, Pre-Impl P0-11 | Totals to the fil; approval only per job; snapshot hash reproducible (AT-20 basic); unapproved work cannot start (AC2-01) | I1-03, I1-04 | L |
| I1-06 | Workshop execution | Board by status, technician assignment, My Jobs (no prices), start/pause/done on authorized lines only | v0.2 EP-07, v0.2.1 §3.3 | Technician sees only assigned jobs and no prices (AC2-30); cannot start unauthorized line | I1-05 | M |
| I1-07 | Parts for a job (simple) | Receive-and-issue special order to a revision line; issue from stock; line WIP pool (pool rule) | Amendment A.1, v0.2.1 §3.3 | Issue blocked for unauthorized/frozen line; no negative stock; concurrent last-unit issue (AC2-13) | I1-05, I1-04 | M |
| I1-08 | Quality check | QC checklist incl. road test and odometer out; QC fail returns job | v0.2.1 §5.G, Pre-Impl GAP-48 | Cannot reach Ready without QC pass; odometer out ≥ in or reason | I1-06 | S |
| I1-09 | Invoice | Draft from authorized + done lines; invoice cap (net billed ≤ authorized under lock); P0-06 guard; tax per line snapshot; numbering; bilingual HTML print view | v0.2.1 §3.9, §4, §5; Pre-Impl P0-06 | AC21-02, AC21-04 (concurrent invoices), AT-12, immutability (AC2-18), numbering (AC2-17) | I1-07, I1-08 | L |
| I1-10 | Payments & delivery | Cash/card (approval code), partial payments, no overpayment, idempotent; delivery with balance check; release override permission (partner) | v0.2 EP-10, v0.2.1 §3.8 | AC2-20, AC2-21, AC2-22, AC2-27; AT-03 for payments | I1-09 | M |
| I1-11 | Staff app shell | Navigation per role, Today screen, search bar, locale switch, empty states | UI/UX deck | Role menus match permissions; RTL/LTR snapshot tests | — (parallel) | M |

### Increment 2 — Approvals that hold up

**Goal:** every way work gets authorised is evidenced and race-free.
**Decisions first:** D-5, D-6, D-7, D-11, B-09, D-30. **Exit:** AT-18–AT-20, AC21-01–AC21-14, T-07–T-09 pass.

| ID | Story | Scope | Spec | Tests | Needs | Size |
|---|---|---|---|---|---|---|
| I2-01 | Estimate versions | Multiple versions, one Sent at a time, partial decisions, withdraw, expire (also at submission time), carry-forward as context | v0.2.1 §3.1–3.2 | AC21-05, AC21-06, AC21-07 | I1-05 | M |
| I2-02 | Amendments | Add scope, price change, reduction (garage), substitution, partial-work agreement; frozen superseded lines; QC guard | v0.2.1 §2.3, §3.3 | AC21-01, AC21-08, AC2-06, AC2-07 | I2-01 | L |
| I2-03 | Customer links | Token service (hashed, scoped, expiring, revocable, rate-limited); customer approval page AR/EN; typed name; minimal data | v0.2 §6.4, Pre-Impl P1-08 | AC2-02–AC2-05; generic invalid page; no internal data | I2-01 | M |
| I2-04 | Step-up verification | ApprovalAttempt; cumulative L1 total under repair-order lock; callback verification (L2); in-person (L3) | Amendment A.4, Pre-Impl P0-10 | AT-18, AT-19, T-07 (concurrent) | I2-03, B-09, D-30 | M |
| I2-05 | Phone approval | Atomic: call details + confirmation sent → ApprovalEvent; outbound to number on file = L2, otherwise L1 | v0.2.1 §3.5, Amendment A.4 | AC21-09, T-09 | I2-04, D-7 | S |
| I2-06 | Authorized contact change | Revoke links, void attempts, snapshot contact on events | Amendment A.4 (F-10) | T-08 | I2-03 | S |
| I2-07 | Diagnostic & declined path | Diagnostic job approved at check-in (v0); waiver by policy; release check; Release Note numbering; urgent-decline acknowledgment | v0.2.1 §3.4 | AC21-11–AC21-14, AC2-09 | I2-01, D-11 | M |
| I2-08 | Customer-supplied parts (if D-6 = yes) | Acceptance, inspection, versioned acknowledgment, warranty limitation | v0.2 EP-06 US-06.8 | AC2-11 | D-6 | S |
| I2-09 | Staff-initiated sharing + worker | Generate bilingual message + link; "shared" confirmation; outbox worker process | v0.2 §3A, Pre-Impl | AC2-28 | I2-03 | S |

### Increment 3 — Money corrections

**Goal:** every correction is a new document; balances, credit and cash always reconcile.
**Decisions first:** B-01, B-02, B-03, D-33, T-1/T-2. **Exit:** AT-05–AT-11, AT-16, T-03, T-05, T-06, T-10 pass.

| ID | Story | Scope | Spec | Tests | Needs | Size |
|---|---|---|---|---|---|---|
| I3-01 | Funds invariant | Shared check F ≥ O and available credit ≥ 0 on every balance-changing command; invoice balance records | Amendment A.2 | T-10 property test (random sequences) | I1-10 | M |
| I3-02 | Credit notes | Quantity/Amount credits; pool rule for net and tax; separate series; approval (not requester); return-to-stock flag | v0.2.1 §3.9, Amendment A.1 | AT-05, AT-16/T-03, AC2-23 | I3-01 | M |
| I3-03 | Refunds | Requested → Approved → Completed / Failed / Cancelled; reservation of credit | Pre-Impl P0-04, Final F-05 | AT-07, AT-08, AT-09, T-06 | I3-02, B-01, B-02 | M |
| I3-04 | Credit applications | Apply credit to replacement invoice; reversal; same-repair-order scope | v0.2.1 §4.2, Pre-Impl P0-05 | AC21-15, AT-10, AT-11, T-05 | I3-02, D-33, B-03 | M |
| I3-05 | Payment reversals | Reversal record; approver ≠ recorder; invariant enforced | v0.2.1 §3.8 | AC21-23, AT-06, T-05(a) | I3-01 | S |
| I3-06 | Discount approvals | Advisor limit, manager limit, partner above; no self-approval; shared-device approver re-auth | v0.2 §3.4, v0.2.1 §3.6 | AC2-07 (discount), AC21-22 | T-1/T-2 | M |
| I3-07 | Daily cash summary | By method and user; received date rules | Pre-Impl P1-05 | Cash = Σ(P − R) for the day (F-06) | I3-03 | S |

### Increment 4 — Stock correctness

**Goal:** parts cost is exact through receipts, issues, returns, credits and close.
**Decisions first:** B-06, B-07; accountant confirmation of costing (V-3) before acceptance. **Exit:** AT-12–AT-15,
AT-17, T-01, T-02, AC21-16, AC21-17 pass.

| ID | Story | Scope | Spec | Tests | Needs | Size |
|---|---|---|---|---|---|---|
| I4-01 | Stock ledger | Stock pool per part (pool rule), goods receipt with supplier reference, movement history | Amendment A.1, v0.2 EP-08 | T-02 / AT-17 on persisted ledger | I1-07 | M |
| I4-02 | Issue & return | Issue to line; return from job (≤ issued − billed); line pools | Amendment A.1 | T-01 / AT-13, AT-14, AT-15 | I4-01 | M |
| I4-03 | COGS & close sweep | COGS events on invoice/credit; WIP; close sweep to unrecovered / no-charge cost | v0.2.1 §4.3 | AC21-16, AC21-17, §4.6 scenarios 1–3, 6, 8 | I4-02, I3-02 | M |
| I4-04 | Adjustments & counts | Stock count, adjustment with reason (manager/partner), weekly exception report | v0.2 EP-08 | Adjustment value at pool basis; reason mandatory | I4-01 | S |
| I4-05 | Late return after credit | Return referencing a credit-note line on a closed order | Pre-Impl P1-04 | Reverses unrecovered cost in period of return | I4-03, B-06 | S |

### Increment 5 — Controls and production readiness (opening gate)

**Goal:** safe to open the garage.
**Decisions first:** B-04, B-10, D-4, D-8, D-32, D-28, D-29; V-1, V-2, V-4, V-5, V-7 complete.

| ID | Story | Scope | Spec | Tests | Size |
|---|---|---|---|---|---|
| I5-01 | Toggles T1–T5 | Per-user sensitive toggles; field-level filtering (costs, reports) | v0.2 §6.1 | Report endpoints 403 without T1; costs absent without T2 | M |
| I5-02 | Dual control R0–R3 | Admin change requests; R0 immediate; R2/R3 second partner; no self-grant; grantor holds privilege | v0.2.1 §3.6 | AC21-20, AC21-21 | M |
| I5-03 | 2FA & bootstrap | TOTP for partners and T1–T5 holders; production partner bootstrap; 2FA reset as R3 | Pre-Impl P1-03 | Login requires second factor; reset needs other partner | M |
| I5-04 | Shared-device PIN | Idle lock; approver PIN at the moment of approval | v0.2.1 §3.6 | AC21-22 | S |
| I5-05 | Bookings (staff-entered) | Day list, no-show, late arrival, reschedule | v0.2 §5.A | Booking state machine tests | M |
| I5-06 | Documents & legal text | Bilingual PDFs (invoice, credit note, release note, estimate) via outbox; versioned terms and acknowledgments | v0.2.1 §6, Pre-Impl P0-11 | PDF matches snapshot; Arabic renders; AT-20 full | M |
| I5-07 | Backups & restore | Point-in-time recovery; restore runbook incl. number-series reset and restore-gap events | Pre-Impl P1-01, Final F-08 | Restore rehearsal performed and recorded | M |
| I5-08 | Audit export | Daily checksummed export to storage the other partner controls | Pre-Impl P1-02 | Export verifies; tamper detected | S |
| I5-09 | Hosting & deployment | Production environment, secrets, migrations in pipeline, monitoring | §2.3 | Smoke test in production | M |
| I5-10 | Readiness | Master data load, staff training, paper fallback forms, security review, UAT of all exception scenarios | v0.2 §10.3 | UAT sign-off by both partners | M |

**Opening gate:** all P0 stories done; no mocks; V-1/V-2/V-4/V-5/V-7 complete; launch configuration set; restore
rehearsed; UAT signed by both partners.

### Increment 6 — First month (P1, before the first month-end close)

| ID | Story | Notes |
|---|---|---|
| I6-01 | Registers and exports | Invoices, credit notes, payments, VAT summary (registered mode), CSV for the accountant |
| I6-02 | Expenses and management P&L | Only if D-23 = platform; otherwise exports only |
| I6-03 | Month lock | Dual control to reopen |
| I6-04 | Comeback / warranty repair orders | Warranty/Goodwill charge type; manager decision; supplier recovery |
| I6-05 | Counted cash and variance | Extends I3-07 |
| I6-06 | Automated WhatsApp/SMS | Provider per D-18; templates; delivery status; OTP option for L2 |
| I6-07 | Customer status page | Token link; customer-visible status only |
| I6-08 | Online booking request | Advisor confirms |
| I6-09 | Reservations, reorder list, supplier returns | Inventory P1 items |

**Later (P2):** OTP customer portal, maintenance reminders, ratings, KPI dashboard, capacity engine, online payments and
deposits, technician time tracking, purchase orders.

---

## Part 4 — Testing strategy

| Layer | What | Where |
|---|---|---|
| Pure rules | Money, pool rule, tax, state transitions | `tests/*` unit tests, no database |
| Commands | Every rule, permission, idempotency, concurrency, fault injection | Real PostgreSQL per test file |
| Invariants | Funds invariant and cash reconciliation under random operation sequences | Property test (T-10) |
| HTTP | Handlers called directly with `Request` objects (authorization, origin, status codes) | `tests/*` |
| UI | Server-rendered markup in AR/EN; key flows end-to-end in a browser from Increment 1 | Add Playwright in I1-11 |
| Acceptance | Every AT-/AC- ID in the spec mapped to a named test | Test names include the ID |
| UAT | Real staff, dummy data, every exception scenario EX-01–EX-24 | Increment 5 |

---

## Part 5 — Delivery risks

| Risk | Mitigation |
|---|---|
| Open owner decisions block a story mid-way | Decisions table lists what each increment needs; resolve before `/start-story` |
| Professional verification arrives late (tax, legal) | Rules are configuration where possible (tax codes, numbering format, terms text versions) |
| Accountant rejects the costing method | Costing isolated in the pool rule and inventory module; ledger keeps quantities and costs to recompute |
| UI work outgrows the plan | Deck defines screens per increment; anything new goes to P2 unless it protects money, data or safety |
| Single maintainer knowledge | `CLAUDE.md`, skills and the decision log keep context in the repository, not in someone's head |
| Production access concentration (B-04) | Decide before Increment 5; audit export to the other partner |
