# Decision Log

Owner decisions, professional verifications and technical decisions, in one place.
Claude Code: read this before starting a story; never assume an open decision — ask, then record the answer here.

Status: ✅ decided · ⏳ open · 🔍 needs professional verification

## Decided

| ID | Decision | Date | Source |
|---|---|---|---|
| D-1 | Build in-house with Claude Code; owners hold code and database | 2026-10-15 | Owners |
| D-S1 | Stack: TypeScript, Node 22, PostgreSQL 16+, Kysely + SQL migrations, Next.js | 2026-10-15 | Owners |
| D-S2 | Tests on embedded PostgreSQL by default; `TEST_DATABASE_ADMIN_URL` for an external server | 2026-10-15 | Owners |
| D-S3 | Work on feature branches; Claude commits; owners push and merge | 2026-10-15 | Owners |
| D-S4 | Specification documents live in `docs/spec/` | 2026-10-15 | Owners |
| D-S5 | Specification amendment v0.2.2 approved (pool rule, funds invariant, idempotency, approval integrity) | 2026-10-15 | Owners |
| PD-1…PD-12 | Partner decisions from PRD v0.1 §1.2 (services, segments, governance principles, no credit terms, customer-supplied parts, pricing) | 2026-10-14 | Owners (provisional) |
| T-01 | Quantities use 3 decimals [assumption — confirm before Increment 4] | 2026-10-15 | Technical |
| T-02 | Arabic screens use Western digits until D-28 is decided | 2026-10-15 | Technical |
| T-03 | Increment 0 gives `user.deactivate` to partners only | 2026-10-15 | Technical |

## Open — needed before the increment shown

| ID | Question | Needed before | Recommended default |
|---|---|---|---|
| B-08 | Will the garage bill non-stock items (sublet work, outside machining)? | Increment 1 | Yes, with mandatory cost entry |
| D-18 (check-in photos) | Minimum number of required check-in photos, and what counts as a valid reason to go below it. Redefined in `docs/spec/02-prd-v0.2.md` §10.3 — later than the PRD v0.1 sense of D-18 below, so this is the live meaning; not previously logged here. | Increment 1 (I1-02) | 4 fixed exterior slots + odometer; fewer only with a mandatory reason, recorded on the repair order |
| D-6 | Accept customer-supplied parts at launch? | Increment 2 | Not at launch; enable later |
| D-7 | Allow phone approval at all? | Increment 2 | Yes; outbound call to number on file = verified |
| D-11 | Diagnostic fee: amount, when charged, when waived | Increment 2 | Pre-authorised at check-in; waive if repairs approved |
| B-09 | Step-up measured per repair order or per estimate version? | Increment 2 | Per repair order since last verification |
| D-30 | Step-up threshold (AED) | Increment 2 (value is configuration) | Start low; review after 60–90 days |
| D-5 | Accept link-possession (L1) risk below the threshold? | Increment 2 | Yes |
| B-01 | Refund approval rule; who may pay out refunds | Increment 3 | Every refund approved by someone other than the requester |
| B-02 | Refunds to a different payment method? | Increment 3 | Not without partner approval |
| B-03 | Customer agreement before applying credit to a replacement invoice? | Increment 3 | Yes, recorded by staff note |
| D-33 | Credit application scope | Increment 3 | Same repair order |
| T-1, T-2 | Discount limits for advisor and manager | Increment 3 (configuration) | Low at launch |
| B-06, B-07 | Parts returns after delivery; who records returns from jobs | Increment 4 | Sealed parts only; advisor or manager |
| B-04 | Who holds production database/server credentials; how the other partner oversees them | Increment 5 | Named accounts; audit export to storage the other partner controls |
| D-4 | Second-partner fallback for R2 admin changes | Increment 5 | No fallback at launch |
| D-8 | QC by a different person than the technician? | Increment 5 (configuration) | Yes when staffing allows |
| D-32 | Shared tablet idle lock and approval PIN | Increment 5 | 5 minutes; per-user PIN |
| B-10 | Backup recovery objectives | Increment 5 | Point-in-time recovery, ≤15 min data loss, restore same day |
| D-23 | Expenses and P&L in the platform or in accounting software | Increment 6 | Accounting software; platform exports |
| D-18 / D-3 (messaging provider) | WhatsApp vs SMS provider for automated messages — the PRD v0.1 sense of D-18; see D-18 (check-in photos) above for the v0.2 sense | Increment 6 | Staff-initiated sharing at launch |
| D-28 | Arabic-Indic or Western digits in Arabic | Before launch | Western |
| D-29 | Brand name, logo and colours | Before launch | — |
| D-12, D-13, D-14, D-15, D-21, D-22 | Cancellation rules, cash rounding, refund methods, warranty terms, opening hours, document wording | Before launch | See PRD v0.2 §11 |

## Professional verification

| ID | Who | Blocks |
|---|---|---|
| V-1 | UAE lawyer — data protection, retention of photos and approval evidence, hosting region | Production |
| V-2 | UAE tax agent — VAT registration, invoice/credit-note content, numbering, rounding, zero-value documents | Production (invoice templates) |
| V-3 | Accountant — weighted average costing, pool rule, WIP and close sweep, warranty cost timing | Acceptance of Increment 4 |
| V-4 | UAE lawyer — approval evidence (link, phone, callback), terms, warranty, storage charges | Production |
| V-5 | UAE lawyer — partnership agreement: signing authority, thresholds, deadlock | Increment 5 |
| V-6 | Bank / payment provider — card refunds, chargebacks, settlement reports | Increment 3 (procedures), production |
| V-7 | Sharjah authorities / PRO — licensing, waste and old-parts disposal | Opening |
