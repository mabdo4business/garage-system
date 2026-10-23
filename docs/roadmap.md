# Roadmap and Progress Tracker

| Item | Value |
|---|---|
| Created | 21 October 2026 |
| Purpose | Single place to see what is done, in progress and next, across all four tracks |
| Story details | Track A stories: scope, spec references and acceptance tests are in `docs/implementation-plan.md`. Tracks B–D: scope below. |
| Decisions | `docs/decisions.md` — a story never starts while a decision it needs is open |
| Partner-facing version (Arabic) | Claude Doc "خطة تنفيذ نظام الكراج الكاملة" |

## How to keep this file current (Claude Code)

1. **Starting a story** (`/start-story <ID>`): set its Status to `in progress` and fill Branch.
2. **Committing a story**: set Status to `done (unmerged)` and Updated to the commit date. Commit this file in the same
   commit as the story.
3. **After the owner merges** the story into its increment branch / `qa`: set Status to `done`.
4. **Blocked** by an open decision or verification: set Status to `blocked` and name the ID in Notes.
5. Tracks B, C (phase C2) and D stay `proposed` until their decision (D-34, D-35, D-36) is recorded as decided in
   `docs/decisions.md`. Do not start a `proposed` story.
6. Update the "Current position" section whenever a status changes. Never mark anything done without the actual
   `npm run check` output (and `npm run test:e2e` where the story has screens).

Status values: `not started` · `in progress` · `done (unmerged)` · `done` · `blocked` · `proposed`

---

## Current position

- **Wave:** 1 · **Increment:** 1 · **Active story:** none; I1-03, I1-04, I1-05a, I1-05b and I1-06 committed (unmerged). Push and merge into `qa` in order: I1-03, I1-04, I1-05a, I1-05b, I1-06
- **Next story:** I1-07 (parts for a job); I1-06 integrity review fixes follow on its branch
- **Next decision needed:** none for I1-06/I1-07 (OQ-1 decided 2026-10-23: warn, don't block)

### Housekeeping before more feature work

`qa` holds Increment 0, I1-01, I1-11 and I1-02 (PRs #1–#3); `main` is still at "Initial commit" (it moves only after UAT).

- [x] Finish I1-11: `npm run check` and `npm run test:e2e` pass, integrity review, commit (include `AGENTS.md`)
- [x] Push `feature/increment-0` and `story/I1-11-app-shell` (I1-01 reached GitHub inside the I1-11 branch)
- [x] PR `feature/increment-0` → `qa` and merge (PR #1)
- [x] Merge I1-01 and I1-11 into `qa` (PRs #1 and #2, merged straight to `qa` rather than through `increment/1`)
- [x] I1-02 merged into `qa` (PR #3); `qa` builds again
- [ ] Push `story/I1-03-inspection-findings` (again: GitHub has only the partial c8e5f8a), `story/I1-04-catalog-tax`, `story/I1-05a-estimate-draft`, `story/I1-05b-estimate-approval` and `story/I1-06-workshop`; merge in that order
- [ ] Before committing yourself: `git add -A` first. `git commit -a` and most IDE defaults skip new files (this broke `qa` twice)
- [ ] Rule from now on: every story branch is pushed the same day it is committed

---

## The four tracks

All tracks share one database and one codebase. The staff system is the only source of truth. Customer-facing output
never contains costs, internal notes, staff data or phone numbers (CLAUDE.md rule 9), enforced on the server.

| Track | For | Source | State |
|---|---|---|---|
| A — Staff system | Partners, manager, advisor, technician | `docs/implementation-plan.md` Increments 0–6 | Active |
| B — Public website | Anyone searching for a garage in Sharjah | This file | Proposed — needs D-34 |
| C — Customer links and portal (PWA) | Garage customers | C1 in the plan (I2, I5, I6); C2 was P2 | C1 planned; C2 proposed — needs D-35 |
| D — Native mobile app | Repeat customers | This file | Proposed, gated — needs D-36 |

## Waves

No dates: budget and calendar are not set. A wave ends when all its tests pass, not on a date.

| Wave | Track A | Track B | Track C | Track D | Gate at the end |
|---|---|---|---|---|---|
| 1 — now | Housekeeping + Increment 1 | — | — | — | Increment 1 exit criteria |
| 2 | Increments 2 + 3 | — | C1: I2-03, I2-09 | — | Increment 2 and 3 exit criteria |
| 3 — before opening | Increments 4 + 5 | W-01…W-05, W-07 | C1: I5-06 | — | **Opening gate** (implementation-plan.md Increment 5) |
| 4 — first month | Increment 6 | W-06 | C1: I6-06, I6-07 | — | Before the first month-end close |
| 5 — after opening | — | — | C2: P-01…P-07 | — | V-1 done before C2 starts; **Track D start conditions** |
| 6 — 60–90 days after opening | — | — | — | M-01…M-06 | — |

---

## Track A — Staff system

Scope, spec references and tests per story: `docs/implementation-plan.md` Part 3.

### Increment 0 — Engineering foundations · done

| ID | Story | Status | Branch | Updated | Notes |
|---|---|---|---|---|---|
| I0 | Foundations (roles, auth, audit, idempotency, numbering, outbox, i18n) | done | `feature/increment-0` | 2026-10-15 | 80 tests; merged to `qa` (PR #1) |

### Increment 1 — Walking skeleton · in progress

Decisions first: B-08. Exit: a full repair order runs through the UI in Arabic and English; P0-06 guard active; all I1
tests pass.

| ID | Story | Size | Needs | Status | Branch | Updated | Notes |
|---|---|---|---|---|---|---|---|
| I1-01 | Customers & vehicles | M | — | done | `story/I1-01-customers-vehicles` | 2026-10-20 | Migrations 0002–0004; decisions OD-1, T-04, T-05, T-06; in `qa` (PR #1) |
| I1-11 | Staff app shell | M | — | done | `story/I1-11-app-shell` | 2026-10-21 | Shell, nav per role, tokens/components CSS, UI kit, Playwright e2e; 124 tests + 8 e2e; in `qa` (PR #2) |
| I1-02 | Repair order & check-in | M | I1-01 | done | `story/I1-02-repair-order-check-in` | 2026-10-21 | Migrations 0005–0006; decisions OD-2–OD-7, B-12, T-07–T-09; 160 tests + 12 e2e; open question OQ-1. Follow-up: cleanup job for unreferenced photo files (only under `photos/`; signatures under `signatures/` are evidence referenced by `approval_event`, never cleaned) ; in `qa` (PR #3) |
| I1-03 | Inspection findings | S | I1-02 | done (unmerged) | `story/I1-03-inspection-findings` | 2026-10-22 | Migrations 0007–0008; inspection assignment (OD-8) and AC2-30 scoping; decisions OD-8–OD-11, T-10–T-13; 181 tests + 14 e2e; AC-05.2 test moves to I1-05; checklist content needs owner review (OD-9) |
| I1-04 | Catalog & tax | M | B-08 | done (unmerged) | `story/I1-04-catalog-tax` | 2026-10-22 | Migrations 0009–0010; price list (labor rates, packages, parts, non-stock items), dated tax profiles and codes; decisions OD-12–OD-17, T-14–T-17; 197 tests + 16 e2e; AC2-12 → I1-05, AC2-19 → I1-09 |
| I1-05 | Estimate (single version) | L | I1-03, I1-04 | done (unmerged) | | | Split before starting (L). Carries AC-05.2 (urgent finding pre-selected) and AC2-12 (price change leaves sent estimates alone); lines store the catalogue price row id and values (`priceAt` returns `priceId`), never just an instant; refuse estimating while no tax profile is in force; record the VAT-inclusive net/VAT method as an assumption for V-2 (OD-14) |
| I1-05a | Estimate draft: jobs, lines, totals | M | I1-03, I1-04 | done (unmerged) | `story/I1-05a-estimate-draft` | 2026-10-22 | Migration 0011; jobs, revisions, lines, totals (AC-06.1, OD-18), urgent findings pre-selected and exclusions (AC-05.2, OD-23), withdrawal guard (OD-24), whole quantities (OD-22), manager/partner discounts (OD-19), AC2-12 line keeps its price; decisions OD-18–OD-24, T-18–T-20; 218 tests + 18 e2e. For I1-05b: send must lock the repair order and refuse an "open" urgent finding |
| I1-05b | Estimate send & in-person approval | M | I1-05a | done (unmerged) | `story/I1-05b-estimate-approval` | 2026-10-22 | Migration 0012; present (canonical snapshot + SHA-256, AT-20 basic, T-21), in-person decision screen without the staff shell (signature, name, displayed language, contact snapshot, terms ids), whole-job decisions (T-22), urgent decline flagged (OD-25), AC2-01 enforced in the database, AC2-12 after sending; decisions OD-25, T-21, T-22; 236 tests + 20 e2e. Terms text has no editing screen yet (rows come from the owners, V-4); withdrawal/expiry transitions are I2-01 |
| I1-06 | Workshop execution | M | I1-05 | done (unmerged) | `story/I1-06-workshop` | 2026-10-23 | Migration 0013; workshop board, assignment with bay (OD-26), My jobs and job card without prices, start/pause (reason)/resume/done with line outcomes by the assignee only (OD-27), AC2-01 refusal logged, AC2-30 scoping, DB-written job history; OQ-1 check-in warning with recorded confirmation; 244 tests + 22 e2e. Integrity review fixes to follow in a separate commit |
| I1-07 | Parts for a job (simple) | M | I1-05, I1-04 | not started | | | Can run beside I1-06 |
| I1-08 | Quality check | S | I1-06 | not started | | | |
| I1-09 | Invoice | L | I1-07, I1-08 | not started | | | Split before starting (L). Carries AC2-19; snapshot tax code, category (treatment), rate, registration status and TRN per line (needs a code+category+rate lookup); refuse invoicing without a tax profile; registration evidence attachment (spec §4.4) still deferred |
| I1-10 | Payments & delivery | M | I1-09 | not started | | | |

### Increment 2 — Approvals that hold up

Decisions first: D-5, D-6, D-7, D-11, B-09, D-30.

| ID | Story | Size | Needs | Status | Branch | Updated | Notes |
|---|---|---|---|---|---|---|---|
| I2-01 | Estimate versions | M | I1-05 | not started | | | |
| I2-02 | Amendments | L | I2-01 | not started | | | Split before starting (L) |
| I2-03 | Customer links | M | I2-01 | not started | | | Track C1 |
| I2-04 | Step-up verification | M | I2-03, B-09, D-30 | not started | | | |
| I2-05 | Phone approval | S | I2-04, D-7 | not started | | | |
| I2-06 | Authorized contact change | S | I2-03 | not started | | | |
| I2-07 | Diagnostic & declined path | M | I2-01, D-11 | not started | | | |
| I2-08 | Customer-supplied parts | S | D-6 | not started | | | Only if D-6 = yes |
| I2-09 | Staff-initiated sharing + worker | S | I2-03 | not started | | | Track C1 |

### Increment 3 — Money corrections

Decisions first: B-01, B-02, B-03, D-33, T-1, T-2.

| ID | Story | Size | Needs | Status | Branch | Updated | Notes |
|---|---|---|---|---|---|---|---|
| I3-01 | Funds invariant | M | I1-10 | not started | | | |
| I3-02 | Credit notes | M | I3-01 | not started | | | |
| I3-03 | Refunds | M | I3-02, B-01, B-02 | not started | | | |
| I3-04 | Credit applications | M | I3-02, D-33, B-03 | not started | | | |
| I3-05 | Payment reversals | S | I3-01 | not started | | | |
| I3-06 | Discount approvals | M | T-1, T-2 | not started | | | |
| I3-07 | Daily cash summary | S | I3-03 | not started | | | |

### Increment 4 — Stock correctness

Decisions first: B-06, B-07; accountant confirmation V-3 before acceptance.

| ID | Story | Size | Needs | Status | Branch | Updated | Notes |
|---|---|---|---|---|---|---|---|
| I4-01 | Stock ledger | M | I1-07 | not started | | | |
| I4-02 | Issue & return | M | I4-01 | not started | | | |
| I4-03 | COGS & close sweep | M | I4-02, I3-02 | not started | | | |
| I4-04 | Adjustments & counts | S | I4-01 | not started | | | |
| I4-05 | Late return after credit | S | I4-03, B-06 | not started | | | |

### Increment 5 — Controls and production readiness (opening gate)

Decisions first: B-04, B-10, D-4, D-8, D-32, D-28, D-29; V-1, V-2, V-4, V-5, V-7 complete.

| ID | Story | Size | Needs | Status | Branch | Updated | Notes |
|---|---|---|---|---|---|---|---|
| I5-01 | Toggles T1–T5 | M | | not started | | | |
| I5-02 | Dual control R0–R3 | M | D-4 | not started | | | |
| I5-03 | 2FA & bootstrap | M | | not started | | | |
| I5-04 | Shared-device PIN | S | D-32 | not started | | | |
| I5-05 | Bookings (staff-entered) | M | | not started | | | Needed by W-06 |
| I5-06 | Documents & legal text | M | V-2, V-4 | not started | | | Track C1 |
| I5-07 | Backups & restore | M | B-10 | not started | | | |
| I5-08 | Audit export | S | B-04 | not started | | | |
| I5-09 | Hosting & deployment | M | V-1 | not started | | | Also hosts the public website (Track B) |
| I5-10 | Readiness | M | | not started | | | UAT sign-off by both partners |

### Increment 6 — First month (P1)

| ID | Story | Needs | Status | Branch | Updated | Notes |
|---|---|---|---|---|---|---|
| I6-01 | Registers and exports | | not started | | | |
| I6-02 | Expenses and management P&L | D-23 | not started | | | Only if D-23 = platform |
| I6-03 | Month lock | | not started | | | |
| I6-04 | Comeback / warranty repair orders | | not started | | | |
| I6-05 | Counted cash and variance | I3-07 | not started | | | |
| I6-06 | Automated WhatsApp/SMS | D-18 (messaging) | not started | | | Track C1 |
| I6-07 | Customer status page | I2-03 | not started | | | Track C1 |
| I6-08 | Online booking request | I5-05 | not started | | | Delivered as W-06 (same story) |
| I6-09 | Reservations, reorder list, supplier returns | | not started | | | |

---

## Track B — Public website (proposed — needs D-34)

A bilingual information website, live a few weeks before opening so the garage appears on Google Search and Maps.
First release: no login, no customer data, no online payment.

**Where:** inside the same Next.js app, as a `(public)` route group under `src/app/[locale]/` beside `(staff)`, using
the same design tokens. Public pages read nothing from the database until W-06. Deployed with I5-09.
**Rules:** all text through `t()` in both catalogues; logical CSS; no staff or customer data; no business rule, price
or legal wording invented (rule 12) — content comes from the owners.

| ID | Story | Scope | Needs | Size | Status | Branch | Updated |
|---|---|---|---|---|---|---|---|
| W-01 | Public layout & home page | Public layout, AR/EN switch, garage message, call and WhatsApp buttons | D-34, D-29 | S | proposed | | |
| W-02 | Services pages | Mechanical & maintenance, electrical, AC, diagnostics — no bodywork, paint, insurance or tyres | D-34 | S | proposed | | |
| W-03 | About & contact | Address and map, opening hours, WhatsApp, phone | D-34, D-21 | S | proposed | | |
| W-04 | Local SEO | Per-page titles/descriptions, sitemap, AutoRepair structured data; Google Business profile (owner task) | D-34, domain | S | proposed | | |
| W-05 | Indicative price guide | Fixed packages shown as "from" prices | D-34, owners' published prices | S | proposed | | |
| W-06 | Booking request | Simple form; advisor confirms in the staff system (same as I6-08) | I5-05 | M | proposed | | |
| W-07 | Privacy & terms pages | Privacy policy and site terms | V-1 (lawyer wording) | S | proposed | | |

Acceptance tests for each W story are written in plan mode when D-34 is decided (minimum: AR/EN render, RTL/LTR,
no staff routes reachable without login, no database reads on public pages before W-06).

---

## Track C — Customer links and portal (PWA)

### Phase C1 — already in Track A (no new decision)

| Story | What the customer gets | Increment |
|---|---|---|
| I2-03 | Secure link to approve the estimate per job, Arabic or English | 2 |
| I2-09 | Ready message with the link, sent by the advisor on WhatsApp | 2 |
| I5-06 | Invoice and estimate PDFs in Arabic and English | 5 |
| I6-06 | Automated WhatsApp/SMS status messages | 6 |
| I6-07 | Repair status page from the link | 6 |

### Phase C2 — customer portal (proposed — needs D-35; was P2)

Customer login by one-time code on the mobile number on file; installable as a PWA. Starts only after Increment 5 and
the lawyer's review V-1. Minimal data only (rule 9).

| ID | Story | Scope | Needs | Size | Status | Branch | Updated |
|---|---|---|---|---|---|---|---|
| P-01 | OTP sign-in | Code by WhatsApp or SMS, short session, link to the customer record | D-35, D-18 (messaging), V-1 | M | proposed | | |
| P-02 | My vehicles & service history | Vehicles and past repair orders, no costs or internal notes | P-01 | M | proposed | | |
| P-03 | My invoices & warranties | Invoices, credit notes, warranty per job | P-02, D-15 | S | proposed | | |
| P-04 | Maintenance reminders | By mileage or time | P-02 | M | proposed | | |
| P-05 | Install as app (PWA) & notifications | Home-screen install, status notifications | P-01 | M | proposed | | |
| P-06 | Rating after delivery | Simple rating and invitation to review on Google | P-02 | S | proposed | | |
| P-07 | Online payment & deposits | Payment gateway | V-6 | L | proposed | | |

---

## Track D — Native mobile app (proposed, gated — needs D-36)

Same features as the portal first, not new ones. Consistent with the owners' earlier decision: no native app in the
first release.

**Start conditions (all):**

- The garage has been open 60–90 days (the PRD's KPI window).
- The C2 portal is live and its use by repeat customers has reached a level the owners set.
- There is a clear need the PWA cannot meet (for example more reliable notifications on iPhone).

**Proposed technology:** React Native with Expo (TypeScript, one codebase for iOS and Android), calling a separate,
versioned customer API built on P-01's sign-in.

| ID | Story | Scope | Size | Status | Branch | Updated |
|---|---|---|---|---|---|---|
| M-01 | Customer API | `/api/customer/v1`: same rules as the portal, minimal data, authorization tests | M | proposed | | |
| M-02 | App skeleton | Expo, Arabic/English with RTL, OTP sign-in | M | proposed | | |
| M-03 | Vehicles, history, invoices | Same as P-02 and P-03 | M | proposed | | |
| M-04 | Approve estimate in the app | Same verification rules as I2-04, never weaker | M | proposed | | |
| M-05 | Notifications | Repair status, estimate ready, reminders | S | proposed | | |
| M-06 | Store release | Apple and Google accounts, store listings, privacy policy | S | proposed | | |

---

## Change log

| Date | Change |
|---|---|
| 2026-10-21 | Created from the full plan: Track A status taken from git history; Tracks B–D added as proposals (D-34, D-35, D-36) |
| 2026-10-21 | I1-11 committed (done, unmerged); I1-02 planning started |
| 2026-10-21 | I1-02 committed (done, unmerged); I0, I1-01 and I1-11 marked done (in `qa`); housekeeping updated |
| 2026-10-22 | B-08 decided (I1-04 unblocked); I1-03 committed (done, unmerged) |
| 2026-10-22 | I1-04 committed (done, unmerged); OD-16, OD-17 recorded |
| 2026-10-22 | I1-05 split into I1-05a and I1-05b; I1-05a committed (done, unmerged); OD-18–OD-24, T-18–T-20 recorded |
| 2026-10-22 | I1-05b committed (done, unmerged); I1-05 complete; OD-25, T-21, T-22 recorded |
| 2026-10-23 | OQ-1 decided; I1-06 committed (done, unmerged); OD-26, OD-27 recorded |
