# Garage Management System — Pre-Implementation Review

| Item | Value |
|---|---|
| Date | 15 October 2026 |
| Baseline | PRD v0.2 (14 Oct 2026) + v0.2.1 Targeted Architecture and Business-Rule Review |
| Decision context | Custom build with Claude Code; owners hold source code and database |
| Scope of this review | Correctness, security, financial integrity, implementability. **No new features. No code, schemas, migrations or APIs.** |

**Priority:** **P0** = resolve before implementation starts · **P1** = resolve before production use · **P2** = can be deferred.

**Labels:** [R] technical recommendation · [Q] owner decision · [V] needs verification by a qualified UAE tax agent, accountant or lawyer. Amounts are illustrative arithmetic in AED; any tax figure uses an illustrative 5% rate only to show mechanics.

---

## A. Findings

### A.1 Summary

| ID | Finding | Area | Priority |
|---|---|---|---|
| P0-01 | No defined transaction boundary; side effects can occur outside the committed transaction | DB failure, audit | **P0** |
| P0-02 | Idempotency semantics undefined (key scope, payload mismatch, duplicate "Issue") | Duplicates | **P0** |
| P0-03 | Concurrent credit notes, payments, refunds and credit applications can exceed invoice limits; no lock ordering | Concurrency | **P0** |
| P0-04 | Refund lifecycle incomplete; auto-created refunds and credit applications can pay the same credit twice | Refunds | **P0** |
| P0-05 | Payment reversal after the payment's credit has been applied elsewhere leaves debt on the wrong invoice | Reversals | **P0** |
| P0-06 | A stock part can be invoiced without any stock having been issued | Parts cost | **P0** |
| P0-07 | Return cost basis is ambiguous for multiple issues; full return gives undefined unit cost; billed units can be returned outside a credit note | Parts returns | **P0** |
| P0-08 | Tax rounding on partial credits can credit more tax than was charged | Tax arithmetic | **P0** |
| P0-09 | Unit cost precision not defined; 2-decimal average cost drifts | Inventory | **P0** |
| P0-10 | Step-up verification can be bypassed by splitting approvals; "held" submissions have no defined state | Approvals, security | **P0** |
| P0-11 | Approval evidence hash input undefined (language, terms version) — evidence not reproducible | Approval evidence | **P0** |
| P1-01 | Backup restore can re-issue document numbers already given to customers | Restore | P1 |
| P1-02 | Audit-log integrity depends on whoever holds database superuser access | Audit, governance | P1 |
| P1-03 | Bootstrap of first partner/admin accounts and 2FA recovery undefined | Authorization | P1 |
| P1-04 | Physical return of a part after a quantity credit on a closed repair order has no path | Parts returns | P1 |
| P1-05 | Payment "received date" vs recording date and back-dating rules undefined | Cash reporting | P1 |
| P1-06 | Changing the authorized contact doesn't revoke links issued to the previous contact | Approvals, security | P1 |
| P1-07 | Business date at midnight boundary not tied to the transaction timestamp | Reporting | P1 |
| P1-08 | Requirements that cannot be tested objectively | Testability | P1 |
| P1-09 | Retention of approval evidence (IP, device, signature images, call notes) unverified | Privacy | P1 [V] |
| P2-01 | Quantity credits on labor lines have no cost meaning | Credit notes | P2 |
| P2-02 | Credit applications across repair orders of the same customer | Credits | P2 |
| P2-03 | Hash-chained audit log | Audit | P2 |
| P2-04 | Card chargebacks arriving weeks later (handled as reversal under P0-05 rules; reporting refinements later) | Payments | P2 |

### A.2 P0 findings

---

#### P0-01 — Transaction boundary and side effects

**Problem.** v0.2/v0.2.1 require "single transaction" per state transition but don't say what must be inside it or what must happen only after commit. If the audit entry, stock movements, number allocation or balance status are written separately, a crash leaves partial records. If a PDF is stored or a message is shared before commit, a rolled-back invoice may already exist in the customer's hands.

**Example.** The advisor issues INV-0101. The invoice row commits, but the server crashes before the audit row and the stock-cost snapshot are written. Or the message containing "INV-0101" is generated and shared, then the transaction rolls back on a lock timeout; the next invoice also gets 0101.

**Smallest safe correction [R].**
1. Each financial command writes, in **one** database transaction: the document, its lines, the number allocation, related stock movements, derived balance/status records, and the audit event(s).
2. Anything external (PDF rendering/storage, message generation, audit export, notifications) happens **after commit**, driven by an outbox record written in the same transaction and processed with retries.
3. PDFs are rendered deterministically from the committed immutable snapshot; they can be regenerated at any time and are never the source of truth.
4. The UI shows a document number only after commit succeeds.

**Acceptance tests:** AT-01, AT-02.

---

#### P0-02 — Idempotency semantics

**Problem.** Idempotency keys are required (approvals, payments) but their behavior isn't defined: what scope they have, what happens if the same key arrives with different data, and how long keys are retained. Duplicate clicks on "Issue invoice", "Issue credit note", "Complete refund" and "Issue stock" aren't covered.

**Example.** An advisor enters a payment of 200.00, the network stalls, they correct it to 250.00 and press Save again. The browser re-sends the same key. A naive implementation returns the stored 200.00 result as "success" and the advisor believes 250.00 was recorded.

**Smallest safe correction [R].**
1. Every money, stock, numbering and approval command accepts an idempotency key generated per form instance.
2. The server stores key + command type + **hash of the request payload** + result.
3. Same key + same payload → return the original result. Same key + different payload → reject with a clear error.
4. Keys retained for a fixed period (e.g., 7 days [R]).
5. State-changing commands on a single record (issue invoice, issue credit note, complete refund) also check the record's current status under lock, so a second request after success returns "already issued" with the same number.
6. At most one **draft** invoice per repair order at a time (unique constraint), which removes most duplicate-draft scenarios.

**Acceptance tests:** AT-03, AT-04.

---

#### P0-03 — Invoice-level concurrency and lock ordering

**Problem.** v0.2.1 locks revision lines for the invoice cap and the source invoice for refunds and credit applications. It doesn't lock the invoice for **credit-note issue** or **payment recording** consistently, and defines no lock order. Two operations can each pass a limit check and together exceed it. Operations that take several locks in different orders can deadlock.

**Example.** Invoice total 525.00. Two staff draft credit notes of 300.00 each. Both checks see "credited so far: 0" and pass. Result: 600.00 credited on a 525.00 invoice.

**Smallest safe correction [R].**
1. Every operation that changes an invoice's balance (payment, reversal, credit note, refund request/completion, credit application in or out) **locks that invoice's balance record first** and re-reads totals inside the transaction.
2. Fixed lock order for all commands: repair order → invoice(s) in ascending ID → revision lines in ascending ID → stock balances in ascending part ID → number sequence last.
3. Deadlock or lock-timeout → the whole transaction rolls back and is retried once automatically with the same idempotency key; otherwise the user sees "try again" and nothing is saved.

**Acceptance tests:** AT-05, AT-06.

---

#### P0-04 — Refund lifecycle and credit reservation

**Problem.** v0.2 auto-creates a *Pending* refund when credit becomes due. v0.2.1 adds credit applications to replacement invoices. Nothing reserves the credit, so the same credit can be both refunded and applied. There is no state for a refund that fails (e.g., card refund declined), and no explicit approval on the refund payout itself.

**Example.** CN of 52.50 on a fully paid invoice. A pending refund of 52.50 is auto-created. The customer asks for the credit to go to the replacement invoice; the manager applies 52.50. The cashier, seeing the pending refund, also pays out 52.50. The customer receives 105.00 of value.

**Smallest safe correction [R].**
1. No auto-created refunds. A refund is **requested** explicitly.
2. Refund states: **Requested → Approved → Completed**, or **Failed** (returns credit to available), or **Cancelled** (from Requested/Approved).
3. **Available credit** on an invoice = credit due − Σ refunds in Requested or Approved state. Refund requests and credit applications are each limited to available credit, checked under the invoice lock (P0-03).
4. The billing formula's *R* counts **Completed** refunds only. Requested/Approved refunds are shown as "refund outstanding".
5. Approval rules for refunds are an owner decision (see B-01); the mechanism always enforces approver ≠ requester.
6. Completion records method, external reference and completion date; a Failed refund requires a reason.

**Acceptance tests:** AT-07, AT-08, AT-09.

---

#### P0-05 — Payment reversal after the credit was consumed

**Problem.** A payment can be reversed after the invoice was fully credited and its credit was applied to a replacement invoice (or refunded). The reversal then creates an outstanding balance on the **credited** invoice, while the replacement invoice still shows paid. Collection, reporting and customer statements point to the wrong document.

**Example.** INV-1 525.00 paid by bank transfer → full credit note → 525.00 applied to INV-2. The transfer is returned by the bank; staff reverse the payment on INV-1. INV-1 now shows 525.00 outstanding although its net amount is 0.00; INV-2 shows paid.

**Smallest safe correction [R].**
1. A reversal may not exceed the invoice's **unconsumed payments** = P − completed refunds − credit applied out (and requested/approved refunds are cancelled first).
2. If the payment's value has been applied out, staff must first record a **credit application reversal** (new, simple record) which moves the debt back to the replacement invoice, then reverse the payment. If it has been refunded, the reversal is blocked and escalated to a manager (real-world recovery is outside the system).
3. Credit application reversals follow the same approval rule as credit applications.

**Acceptance tests:** AT-10, AT-11.

---

#### P0-06 — Invoicing stock parts without issued stock

**Problem.** Parts cost follows billed quantity × line unit cost, and unit cost comes from stock issues. If a part line is invoiced with no stock issued (technician took it from the shelf, forgot to record), the invoice shows revenue with **zero** parts cost. The missing unit appears later as a stock-count shrinkage, so job margins are overstated and adjustments overstated.

**Example.** Brake pads billed 300.00; nothing issued. Job margin shows 300.00 on pads. A month later a stock count finds one set missing and posts a 180.00 adjustment.

**Smallest safe correction [R].**
1. Each catalogue part is flagged **stock-tracked** or **non-stock**.
2. An invoice cannot be issued if, for any stock-tracked part line, **net issued qty < net billed qty after this invoice**. The error names the line and offers "Issue stock" or "Receive-and-issue".
3. Non-stock items (if allowed, e.g., sublet services) require a cost to be entered on the line before issue [Q] B-08.

**Acceptance test:** AT-12.

---

#### P0-07 — Partial and full returns: cost basis and guards

**Problem.** v0.2.1 defines line unit cost as (issued cost − returned cost) ÷ (issued qty − returned qty).
- With several issues at different costs, "return at original issue cost" doesn't say **which** issue.
- After a full return the denominator is zero.
- Nothing stops a technician returning units that have already been billed, which would leave revenue with no cost and an inflated stock balance.

**Example.** Line RL-2: issued 1 unit at 8.00 on Monday, 1 unit at 9.00 on Tuesday; one unit billed. Wednesday, one unit returned from the job. Is stock increased at 8.00, 9.00 or 8.50? The line then shows 1 issued, 1 billed — but which cost was billed?

**Smallest safe correction [R].**
1. Each return references the **specific issue movement** it reverses and uses that movement's unit cost. Returned qty ≤ remaining (issued − returned) on that movement. Default selection: most recent issue first [R].
2. Unit cost on a line is computed only when net issued qty > 0. When it is 0, the line has no cost and nothing to recognize.
3. **Return from job** is allowed only for qty ≤ net issued − net billed on that line. Billed units can return to stock **only** through a Quantity credit with "return to stock".
4. COGS amounts are recorded as fixed amounts at each invoice/credit event; later issues or returns don't revalue past events. The close sweep handles any residual (v0.2.1 §4.3, unchanged).

**Acceptance tests:** AT-13, AT-14, AT-15.

---

#### P0-08 — Tax rounding on partial credits

**Problem.** Credit-note tax is "pro rata of the original line snapshot", rounded per line. Repeated partial credits can round up each time, so total credited tax exceeds the tax originally charged, leaving a fils-level negative balance and a tax report that doesn't reconcile.

**Example.** Line: qty 3, net 10.00, tax 0.50. Credit 1 unit three times: net 3.33 / tax 0.17 each time → total tax credited 0.51 > 0.50; net 9.99 ≠ 10.00.

**Smallest safe correction [R].**
1. A credit that brings a line's cumulative credited qty to the full invoiced qty uses the **remainder**: credited net = line net − net already credited; credited tax = line tax − tax already credited.
2. Partial credits are rounded per line, and the cumulative credited net and tax per line can never exceed the original line's net and tax.
3. A full credit note copies every line's original net and tax exactly; it doesn't recompute.
4. The rounding method itself is [V] V-2.

**Acceptance test:** AT-16.

---

#### P0-09 — Unit cost precision

**Problem.** Amounts are specified as AED with 2 decimals. Applied to average unit cost and stock value, this drifts every time a receipt doesn't divide evenly.

**Example.** Receive 3 filters for 10.00 → average 3.33 → stock value 9.99. After many receipts and issues, stock value and the sum of movements diverge.

**Smallest safe correction [R].**
1. Document amounts (prices, line nets, tax, totals, payments): 2 decimals.
2. Unit cost and average cost: higher precision (e.g., 6 decimals [R]).
3. Movement value = qty × unit cost rounded to 2 decimals at the movement; stock value = Σ movement values (not qty × average).
4. Average cost recalculated from stock value ÷ qty at full precision.

**Acceptance test:** AT-17.

---

#### P0-10 — Step-up verification bypass and held submissions

**Problem.**
1. The step-up threshold (v0.2.1 §3.7) applies "per submission". A customer, or someone holding a forwarded link, can approve several revisions in separate submissions, each below the threshold, without any verified identity.
2. AC21-10 says decisions are "held as verification required", but no such state exists in the revision or version state machines.

**Example.** Threshold 1,000.00. Two jobs of 900.00 each are approved via link in two submissions one minute apart → 1,800.00 authorized at possession level only.

**Smallest safe correction [R].**
1. The threshold is evaluated on the **cumulative amount approved at L1 on the repair order** since the last L2/L3 verification, including the current submission.
2. A submission that requires step-up is stored as an **ApprovalAttempt** (not a decision). The revisions stay *Pending*. The attempt expires with the version and is lapsed by withdrawal like any pending item.
3. When callback or in-person verification is completed, an ApprovalEvent (L2/L3) is created from the attempt, re-validated against the current version and hash. If the version changed, the attempt is void.
4. Technicians see nothing new until the ApprovalEvent exists.

**Acceptance tests:** AT-18, AT-19.

---

#### P0-11 — Approval evidence must be reproducible

**Problem.** Approvals store a "content hash" of the version snapshot, but the hash input isn't defined. The customer may view Arabic or English, and terms text can change. If the hash covers one rendering and the customer saw another, the garage cannot prove what the customer agreed to.

**Example.** Customer disputes in Arabic that the estimate didn't mention a diagnostic fee condition. The stored hash covers an English HTML rendering produced months ago with a different template; nothing can be re-rendered to match.

**Smallest safe correction [R].**
1. The snapshot is a **canonical, language-neutral data document** (lines, quantities, prices, discounts, estimated tax, conditions, policy values) plus the **IDs and versions** of the terms/acknowledgment texts shown in each language.
2. The hash is computed over that canonical document with a fixed serialization.
3. The ApprovalEvent records which language was displayed and the terms text versions.
4. Terms and acknowledgment texts are versioned and never edited in place.
5. Any re-rendering for a dispute uses the snapshot plus the stored text versions.

**Acceptance test:** AT-20.

### A.3 P1 findings

| ID | Problem | Example | Smallest correction [R] |
|---|---|---|---|
| **P1-01** Restore re-issues numbers | Restoring a nightly backup loses documents issued since; number sequences restart from the backup | INV-0140 issued and paid at 17:00; database restored to 02:00; next invoice is again 0140 | Point-in-time recovery for the database. Written restore runbook: before reopening, set each number series above the highest number found in the off-site audit export, the PDF store and paper copies; re-enter lost documents from that evidence as "reconstructed" with their original numbers, and log the restore as an event. Quarterly restore test includes this step. PDFs/media backed up on the same schedule |
| **P1-02** Audit integrity vs. superuser access | Insert-only rights stop the application but not anyone with database superuser or server access. Whoever builds and operates the system holds that access, so the other partner's protection depends on it | A production database fix by the developer silently changes a credit note | Daily audit export with a checksum to storage the **other partner** controls; production access only via named accounts, logged; schema changes only through the reviewed deployment pipeline; any manual production data correction recorded as a documented change both partners approve. Ownership of credentials is an owner decision (B-04) |
| **P1-03** Bootstrap and 2FA recovery | The first partner accounts must be created before the R3 rules can work; a partner losing their 2FA device has no recovery path | — | Two partner accounts created once by the deployment configuration, both forced to enroll 2FA on first login; no UI path creates a partner thereafter except R3. 2FA reset is R3 (the other partner approves), with identity checked in person |
| **P1-04** Late physical return after a quantity credit | A part credited without return on a closed repair order is physically brought back a week later; "return from job" is unavailable on a closed order | — | Allow a stock return movement referencing the **credit-note line**, at the original cost, qty ≤ credited-without-return qty; it reverses the unrecovered job cost in the period of the return |
| **P1-05** Payment dates | Card terminal settlements and late recording make "received date" differ from the recording date; back-dating is unrestricted | Card payment taken Thursday evening, recorded Friday | Received date ≤ today, ≥ invoice issue date, within an open month; difference from recording date shown in the daily summary. Documents (invoices, credit notes, refunds) are never back-dated |
| **P1-06** Authorized contact change | Links already sent to the old contact remain valid | Vehicle owner replaces the driver as contact; the driver's link still approves | Changing the contact revokes all open links and pending attempts for the repair order; requires L2/L3 (already R-classified as sensitive in v0.2.1 §3.7) |
| **P1-07** Midnight boundary | Business date computed from the application server's clock or the request time can differ from the commit time | Invoice submitted 23:59:59, committed 00:00:01 | Business date = Asia/Dubai date of the database transaction timestamp |
| **P1-08** Untestable requirements | See list below | — | Replace or drop as indicated |
| **P1-09** Evidence retention | IP addresses, device data, signatures and call notes are personal data | — | Retention period per [V] V-1; until verified, store but don't purge |

**P1-08 — requirements that cannot be tested objectively (replace or drop):**

| Source | Wording | Replacement |
|---|---|---|
| v0.2 AC2-33 | Photo resolution "[TBD] pixels" | Owner sets a number (B-12) or drop the resolution requirement |
| v0.2 NFR-13 | Availability "[TBD]" | Owners set a target (B-11) or state "best effort during opening hours" |
| v0.2.1 §3.6 | "The customer is told the refund is being processed" | Not a system requirement; move to operating procedure |
| v0.2.1 §3.7 | "The customer can dispute within the working day" | Not a system requirement; move to terms [V] V-4 |
| v0.2 NFR-12 | "Under 2 seconds on a typical 4G connection" | Server response time for listed screens ≤ X ms at a defined data volume, measured in test |
| v0.2 §6.4 | "Rate limiting per token and IP" (no numbers) | Specific limits (e.g., N invalid attempts per IP per 10 minutes) set as configuration with defaults |

### A.4 P2 findings

| ID | Note |
|---|---|
| P2-01 | Quantity credits on labor lines: allowed, but they don't affect cost. Restrict the Quantity/Amount choice to part lines if simpler to explain |
| P2-02 | Credit applications across repair orders of the same customer: deferred per D-33 default |
| P2-03 | Hash-chained audit records: deferred; P1-02 daily checksummed export covers the startup need |
| P2-04 | Chargebacks weeks later: handled as reversals under P0-05; dedicated reporting later |

### A.5 Scenario coverage check

| Scenario requested | Covered by v0.2.1? | Finding |
|---|---|---|
| Partial payments and payment reversals | Partly (balance formula, no-overpay, reversal approver ≠ recorder) | P0-03, P0-05, P1-05 |
| Partial and full credit notes | Partly (Quantity/Amount, caps) | P0-03, P0-08 |
| Customer credit application to replacement invoices | Yes (record added) | P0-04 (reservation), P0-05 (reversal of application) |
| Refund requests, approvals and completed refunds | No (states incomplete) | P0-04 |
| Parts issued, partially returned, fully returned | Partly | P0-06, P0-07, P0-09 |
| Quantity credits without physical returns | Yes (close sweep) | P1-04 (late return) |
| Changes to approved repair work | Yes (revisions, supersession) | No new P0 |
| Customer approval verification and audit evidence | Partly | P0-10, P0-11, P1-06, P1-09 |
| Concurrent invoice creation and duplicate requests | Partly | P0-02, P0-03 |
| Database failure during financial transactions | No | P0-01 |
| Backup restoration and audit-log integrity | Partly | P1-01, P1-02 |

---

## B. Unresolved Decisions

### B.1 Business decisions requiring owner approval

Already open from earlier versions and still required: D-4 (fallback), D-5 (link residual risk), D-11 (diagnostic fee), D-23 (where expenses/P&L live), D-30 (step-up threshold), D-31 (refused partial work), D-32 (tablet lock/PIN), D-33 (credit application scope), D-34 (tax-change notice).

New from this review:

| ID | Decision | Why it matters | Suggested default |
|---|---|---|---|
| B-01 | Refund approval: does every refund need a second person, or only above a threshold? Who may complete (pay out) a refund? | Money leaving the business | Every refund approved by someone other than the requester; completion by manager or partner |
| B-02 | Refund to a method other than the original (e.g., card payment refunded in cash)? | Fraud and reconciliation risk | Not allowed without partner approval [V] V-6 |
| B-03 | Does the customer have to agree before their credit is applied to a replacement invoice? | Customer relationship, disputes | Yes, recorded by staff note |
| B-04 | Who holds production database and server credentials, and how is that access shared, logged and reviewed by the other partner? | Every software control can be bypassed with this access | Named accounts; checksummed audit export to the other partner; both approve manual data fixes |
| B-05 | What happens when a payment that funded a refund later fails (bounced transfer, chargeback)? | Loss recovery | Manager escalation; handled outside the system |
| B-06 | Return policy: will the garage accept parts back from customers after delivery? | Determines how often late returns (P1-04) occur | Only unused, sealed parts within a set period |
| B-07 | Who may record stock returns from jobs (technician, advisor, manager)? | Return is a cost-reducing action | Advisor or manager |
| B-08 | Will there be non-stock billable items (e.g., sublet work, outside machining)? If yes, cost must be entered manually | P0-06 guard | Allowed, with mandatory cost entry |
| B-09 | Should the step-up cumulative amount reset per repair order or per estimate version? | Security vs. friction | Per repair order since last L2/L3 verification |
| B-10 | Backup recovery objectives: maximum data loss and maximum restore time | Restore design and cost | Point-in-time recovery; ≤ 15 minutes data loss; restore within the same business day |
| B-11 | Availability target during opening hours, if any | Hosting choice | Best effort with documented paper fallback |
| B-12 | Minimum photo resolution, if any | Testability | Drop the requirement; rely on device camera defaults |

### B.2 Technical decisions safe to recommend without owner approval [R]

1. One database transaction per financial command, including audit; outbox for side effects (P0-01).
2. Idempotency key per form instance with payload hash and 7-day retention (P0-02).
3. Fixed lock order; automatic single retry on deadlock (P0-03).
4. Refund states and available-credit reservation mechanism (P0-04) — the approval **rule** is B-01.
5. Credit application reversal record (P0-05).
6. Stock-tracked flag and invoice guard (P0-06).
7. Returns referencing specific issue movements; most recent issue first (P0-07).
8. Remainder rule for final credits (P0-08) — the rounding **method** is [V] V-2.
9. Unit cost precision of 6 decimals; stock value as sum of movement values (P0-09).
10. ApprovalAttempt record and cumulative step-up calculation (P0-10) — the threshold value is D-30.
11. Canonical snapshot hashing and versioned terms texts (P0-11).
12. Point-in-time recovery and documented restore runbook (P1-01) — objectives are B-10.
13. Business date from transaction timestamp (P1-07).
14. Use a relational database that supports transactions, row locks and partial unique indexes [R]; v0.2.1's integrity matrix depends on all three.

---

## C. Recommended Implementation Sequence

Smallest sequence that yields a usable, correct end-to-end garage workflow. Each increment ends with a demonstrable journey and passing acceptance tests. No feature beyond PRD v0.2.1 P0 scope.

| # | Increment | Contents | Exit criterion |
|---|---|---|---|
| 0 | **Engineering foundations** | Transaction + audit + outbox convention; idempotency handling; lock-order convention; money/cost/date types (P0-09, P1-07); staff login and fixed roles (toggles later); Arabic/English scaffolding; numbering service | AT-01–AT-04 pass on a stub "test document" command |
| 1 | **Happy path (walking skeleton)** | Customer, vehicle, walk-in repair order, check-in with photos, findings, estimate (jobs/revisions/lines), approval in person, job execution, receive-and-issue of parts, QC, invoice, cash/card payment, delivery | One repair order runs end to end in Arabic and English; P0-06 guard active |
| 2 | **Approvals that hold up** | Versions, partial decisions, withdrawal/expiry, add scope/price change/substitution, phone approval (atomic), link approval at L1, ApprovalAttempt and callback step-up, canonical snapshot hashing, diagnostic authorization, declined path with Release Note | AT-18–AT-20 and v0.2.1 AC21-01–AC21-14 pass |
| 3 | **Money corrections** | Credit notes (Quantity/Amount, remainder rule), refunds with full lifecycle, credit applications and their reversal, payment reversals, invoice-level locking | AT-05–AT-11, AT-16 pass |
| 4 | **Stock correctness** | Stocked parts, goods receipt, average cost, issue/return by movement, adjustments, close sweep, quantity credits with/without return | AT-12–AT-15, AT-17 pass |
| 5 | **Controls and production readiness** | Toggles, dual control R0–R3 (no fallback), shared-device approval PIN, bootstrap and 2FA recovery, link revocation on contact change, daily cash summary, bilingual invoice/credit note/release note PDFs with verified legal text, backups with point-in-time recovery and a rehearsed restore, audit export to the other partner | Restore rehearsal succeeds; P1 items closed; opening-gate DoD from v0.2 met |

**Usable for real operations** = increments 0–5. Increments 0–2 already give a usable test workflow for UAT with real staff on dummy data.

---

## D. Acceptance Tests for P0 Findings

All tests run against a real database (not mocks) with concurrent clients where stated.

**AT-01 (P0-01) — Atomic financial command**
- Given a draft invoice ready to issue
- When the transaction is forced to fail after the invoice row is written but before commit (fault injection)
- Then no invoice, number, audit event, stock movement or outbox record exists, and the next successful issue receives the number that the failed attempt would have used.

**AT-02 (P0-01) — Side effects only after commit**
- Given an invoice issue that rolls back
- When the outbox processor runs
- Then no PDF is stored and no message is generated for it; and for a committed invoice, a PDF that fails to generate is retried and, once generated, matches the committed snapshot.

**AT-03 (P0-02) — Same key, same payload**
- Given a payment request with key K and amount 200.00
- When the identical request is sent three times concurrently
- Then exactly one payment exists and all three responses return the same payment ID.

**AT-04 (P0-02) — Same key, different payload; duplicate issue**
- Given a stored payment with key K and amount 200.00
- When a request arrives with key K and amount 250.00
- Then it is rejected with a payload-mismatch error and no new payment exists.
- And given a draft invoice, when "Issue" is pressed twice, then one number is consumed and both responses show the same invoice number.

**AT-05 (P0-03) — Concurrent credit notes**
- Given an issued invoice of 525.00 with no credits
- When two credit notes of 300.00 are issued concurrently
- Then exactly one is issued and the other is rejected with "exceeds remaining creditable amount (225.00)".

**AT-06 (P0-03) — Concurrent payment and credit note**
- Given an invoice of 525.00 with 300.00 paid
- When a payment of 225.00 and a credit note of 100.00 are submitted concurrently
- Then the operations are serialized by the invoice lock, giving one of two valid outcomes:
  - Payment first: payment accepted (P = 525.00), then the credit note is issued, leaving credit due 100.00.
  - Credit note first: outstanding becomes 125.00, and the 225.00 payment is rejected as exceeding the balance due.
- In no outcome do payments exceed what was due at the moment each was recorded.

**AT-07 (P0-04) — No auto refund; reservation**
- Given a paid invoice receives a credit note of 52.50
- Then no refund record exists automatically and available credit = 52.50.
- When a refund of 52.50 is requested
- Then available credit = 0.00, and a credit application of any amount from this invoice is rejected.

**AT-08 (P0-04) — Refund lifecycle**
- Given a requested refund of 52.50
- When the requester tries to approve it
- Then it is rejected.
- When another authorized user approves and the refund is completed with method and reference
- Then R = 52.50, balance = 0.00, cash collected for the day decreases by 52.50.

**AT-09 (P0-04) — Failed refund**
- Given an approved refund of 52.50
- When it is marked Failed with a reason
- Then available credit returns to 52.50, R is unchanged, and cash collected is unchanged.

**AT-10 (P0-05) — Reversal blocked when credit applied out**
- Given INV-1 paid 525.00, fully credited, and 525.00 applied to INV-2
- When a user reverses the INV-1 payment
- Then the reversal is rejected with "Reverse the credit application first".

**AT-11 (P0-05) — Reversal after application reversal**
- Given the state in AT-10
- When the credit application is reversed and then the payment is reversed
- Then INV-2 shows 525.00 outstanding, INV-1 shows 0.00, and cash collected decreases by 525.00 on the reversal date.

**AT-12 (P0-06) — No billing without issue**
- Given a stock-tracked part line with authorized qty 1 and net issued qty 0
- When the advisor tries to issue the invoice
- Then issue is rejected naming that line; after the part is issued, the invoice issues and COGS equals the issue cost.

**AT-13 (P0-07) — Return uses specific issue cost**
- Given a line with issues of 1 @ 8.00 and 1 @ 9.00 and nothing billed
- When one unit is returned referencing the 9.00 issue
- Then the return is valued at 9.00, line net issued cost = 8.00, and stock value increases by 9.00.

**AT-14 (P0-07) — Full return**
- Given a line with 1 unit issued @ 8.00, not billed
- When the unit is returned
- Then net issued qty = 0, the line has no unit cost, WIP for the line = 0.00, and invoicing the line is blocked by AT-12's guard.

**AT-15 (P0-07) — Billed units cannot be returned from job**
- Given a line with 1 unit issued and 1 unit billed
- When a user records a return from job
- Then it is rejected; returning the unit is possible only via a Quantity credit with "return to stock".

**AT-16 (P0-08) — Credit rounding**
- Given an invoice line qty 3, net 10.00, tax 0.50
- When three credit notes each credit 1 unit
- Then the credited nets are 3.33, 3.33, 3.34 and taxes 0.17, 0.17, 0.16 (or another split whose totals equal exactly 10.00 and 0.50), and the invoice balance after full payment and refunds is exactly 0.00.

**AT-17 (P0-09) — No cost drift**
- Given a part with 0 stock
- When 3 units are received for 10.00, then 1 issued, then 2 issued
- Then the stock value is 0.00 after the last issue, and the sum of issue values equals 10.00.

**AT-18 (P0-10) — Cumulative step-up**
- Given a step-up threshold of 1,000.00 and two pending revisions of 900.00 each
- When the first is approved by link (L1) and the second is submitted by link
- Then the first is approved; the second is stored as an ApprovalAttempt, its revision stays Pending, and the technician cannot start it until an L2 or L3 ApprovalEvent exists.

**AT-19 (P0-10) — Attempt voided by version change**
- Given an ApprovalAttempt awaiting callback
- When the advisor withdraws the version before verification
- Then the attempt is void, the revision is Lapsed, and completing the callback creates no ApprovalEvent.

**AT-20 (P0-11) — Reproducible evidence**
- Given a version approved by a customer viewing Arabic
- When the terms text is later updated to a new version and the template changes
- Then re-rendering the approval from the stored snapshot and recorded text versions reproduces the same canonical hash, displays the Arabic terms version the customer saw, and the stored language = Arabic.

---

## E. Owner Decisions Required — Concise List

**Before implementation starts:**
1. **B-01** Refund approval rule and who may pay out refunds.
2. **B-04** Who holds production database/server credentials, and how the other partner oversees that access.
3. **B-08** Whether non-stock billable items exist.
4. **B-09** Step-up measured per repair order (recommended) or per estimate version.
5. **D-23** Whether expenses and the P&L live in the platform or accounting software.
6. **D-30** Step-up threshold amount.
7. **D-33** Credit application scope (same repair order recommended).

**Before production use:**
8. **B-02** Refunds to a different payment method.
9. **B-03** Customer agreement before applying credit to a replacement invoice.
10. **B-05** Handling of failed payments that funded refunds.
11. **B-06 / B-07** Parts return policy and who records returns.
12. **B-10 / B-11 / B-12** Recovery objectives, availability target, photo resolution.
13. **D-4, D-5, D-11, D-31, D-32, D-34** (carried forward).

**Professional verification still required [V] (no legal requirement is asserted here):**

| ID | Professional | Questions affected by this review |
|---|---|---|
| V-1 | UAE lawyer (data protection) | Retention of approval evidence: IP, device data, signature images, call notes (P1-09); restoring and reconstructing documents after data loss |
| V-2 | UAE tax agent | Rounding method for tax on invoices and partial credits (P0-08); whether reconstructed documents after a restore keep their original numbers (P1-01); refunds to a different method; tax treatment of credit applications (none expected, to confirm) |
| V-3 | Accountant | Unrecovered job cost when parts are returned late (P1-04); specific-issue cost for returns under weighted average (P0-07); stock value as sum of movement values (P0-09); payment received date vs. recorded date for reporting (P1-05) |
| V-4 | UAE lawyer (consumer/contract) | Cumulative step-up and attempt-based approvals as evidence (P0-10); evidential value of canonical snapshot + versioned terms (P0-11); customer consent to credit applications (B-03) |
| V-6 | Bank / payment provider | Refund to a different method; card refund failure and chargeback procedures (B-02, B-05) |

Earlier verification items V-5, V-7, V-8 and V-9 are unchanged and still outstanding.
