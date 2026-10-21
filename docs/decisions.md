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
| OD-1 | Plate still active on another vehicle record (US-02.4 "warn"): the advisor is warned and shown that vehicle; on confirmation — which must name the warned plate (`confirmFor`), in the UI and the API alike — the plate moves: the old vehicle's plate row is closed (audited `vehicle.plate_retired`) and that vehicle has no current plate until one is entered. Without confirmation the command refuses. (OD = owner decision taken during the build, outside the spec's D-numbering.) | 2026-10-20 | Owners |
| T-04 | Lock kind `vehicle` ranks before `repair_order` (rank 5): a command may lock a vehicle and then its repair order, never the reverse. Two vehicles are locked together in ascending id order (plate move). | 2026-10-20 | Technical (I1-01 review) |
| T-05 | `customer.read_contact` (mobile, email — also searching by mobile): partner, manager, service advisor, accountant. The UI/UX deck excludes only the technician; excluding the store keeper and including the accountant are assumptions [confirm before UAT]. | 2026-10-20 | Technical (I1-01) |
| T-06 | Input formats not set by the spec [assumptions — confirm before UAT]: plate required at registration (no temporary/export/unplated vehicles yet); plate code 1–4 characters, number 1–5 digits; year 1960–2100; VIN optional, 5–32 characters (not strictly 17, for older/imported vehicles); mobile 6–15 digits after removing +971/00971/leading 0. | 2026-10-20 | Technical (I1-01) |
| D-18 (check-in photos) | Five fixed check-in photo slots: front, rear, left, right (exterior) and odometer. Fewer only with a mandatory free-text reason recorded on the repair order. Minimum held as configuration. (v0.2 sense of D-18, PRD v0.2 §10.3; the messaging-provider D-18 stays open.) | 2026-10-20 | Owners |
| OD-2 | Check-in is a draft (`check_in`) while details and photos are added; "Complete check-in" validates and creates the repair order in Checked-in in one transaction. Drafts can be abandoned, are never customer-visible and get no number. | 2026-10-21 | Owners |
| OD-3 | Repair orders get a reference number `RO-000123` from the numbering module (series `repair_order`) when check-in completes. Not a tax document. | 2026-10-21 | Owners |
| OD-4 | Fuel level is recorded in eighths: E, 1/8 … 7/8, F. | 2026-10-21 | Owners |
| OD-5 | Check-in also records dashboard warning lights (US-04.1) and an optional promised completion time (US-04.5); empty means "to be confirmed after inspection". | 2026-10-21 | Owners |
| T-07 | Photo limits where AC2-33 says `[TBD]` [assumptions — confirm before UAT]: largest upload 15 MB; shortest allowed long edge 1280 px; the tablet downscales to a 2560 px long edge (JPEG) before upload; JPEG, PNG and WebP only. Held as configuration (`app_setting`). Odometer in km. | 2026-10-21 | Technical (I1-02) |
| T-08 | Lock ranks added in I1-02: `check_in` 7 (after vehicle, before repair order), `repair_order` 10 as reserved. | 2026-10-21 | Technical (I1-02) |

## Open — needed before the increment shown

| ID | Question | Needed before | Recommended default |
|---|---|---|---|
| OQ-1 | May one vehicle have two open repair orders at the same time (e.g. a second check-in before the first is delivered)? The spec is silent; I1-02 does not prevent it. | Before I1-06 (workshop board) | Warn at check-in, do not block |
| B-08 | Will the garage bill non-stock items (sublet work, outside machining)? | Increment 1 | Yes, with mandatory cost entry |
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
| D-34 | Build the public website (Track B in `docs/roadmap.md`) now, and which pages? | Wave 3 (before opening) | Yes: W-01–W-05 and W-07 before opening, inside the same Next.js app; W-06 after I5-05 |
| D-35 | Bring the customer portal (Track C phase C2, was P2) forward to straight after opening? | After opening | Yes, as a PWA, after the lawyer's review V-1 |
| D-36 | Native mobile app (Track D): when and with what technology? | 60–90 days after opening | Only when the start conditions in `docs/roadmap.md` Track D are met; React Native with Expo |
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
