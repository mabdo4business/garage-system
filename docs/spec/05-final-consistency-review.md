# Garage Management System — Final Consistency Review

| Item | Value |
|---|---|
| Date | 15 October 2026 |
| Baseline | PRD v0.2 + v0.2.1 addendum + Pre-Implementation Review (15 Oct 2026) |
| Scope | Five areas only: inventory costing, financial integrity, transaction/numbering integrity, approval integrity, acceptance-test consistency |
| Not included | Code, schemas, new features, restated findings |

**Approval column:** **Owner** = partners decide · **[V]** = qualified UAE professional must confirm · **None** = technical correction, safe to adopt.

---

## 1. Inventory Costing

### 1.1 The contradiction

| Rule | Source |
|---|---|
| COGS at billing = **line average** unit cost *u* × Δ billed qty | v0.2.1 §4.3 |
| Return from job uses the **specific issue movement's** cost (most recent first) | Pre-Impl P0-07, AT-13 |

These two rules disagree whenever a line has issues at different costs.

**Example.**
1. Line RL-2 has two issues: 1 unit at 8.00 and 1 unit at 9.00. Line average *u* = 8.50.
2. One unit is billed, so COGS = 8.50.
3. The remaining unit is returned "at the specific issue cost" of the most recent issue: 9.00.
4. WIP on the line = issued 17.00 − returned 9.00 − COGS 8.50 = **−0.50**.

The close sweep then books a **negative** unrecovered cost (a gain), so cost leaks out of the model.

### 1.2 Alternatives

| Option | Rule | Consequence |
|---|---|---|
| **A. Line average throughout** [R] | Issues leave stock at the current weighted average. On each job line, billing, return-from-job, and credit-note return all use the line's current *u*. Stock receives a return at that *u* and the stock average is recalculated. | Cost removed from the job always equals value added to stock or recognized as COGS. WIP can never go negative. Simple. Stock average is slightly influenced by returns, which is normal under weighted average. |
| B. Specific identification within the line | Billing and returns both pick specific issue movements (e.g., first issued, first billed). | Also internally consistent, but every billing event must pick movements. More complex logic and more tests for no practical benefit at this scale. |
| C. Return at the current stock average | Returns enter stock at today's average, not the cost they left at. | The difference between the cost leaving WIP and the value entering stock needs a separate revaluation bucket. Adds a reporting line and accountant judgment. Not recommended. |

### 1.3 Findings

| ID | Ref | Issue | Smallest correction | Pri | Approval |
|---|---|---|---|---|---|
| **F-01** | v0.2.1 §4.3; Pre-Impl P0-07, AT-13 | Mixed costing methods produce negative WIP (example above). | Adopt **Option A**. Replace "specific issue movement" in P0-07 rule 1 with "line's current unit cost *u*". Keep P0-07 rules 2–4 (no cost when net issued = 0; return-from-job ≤ net issued − net billed; billed units return only via a Quantity credit). A credit-note return enters stock at the **unit cost recorded on the COGS event being reversed**. | **P0** | None for internal consistency; method itself [V] V-3 |
| **F-02** | Pre-Impl P0-09, AT-17 | The remainder rule exists for credit-note tax but not for stock value. Issuing the last units one at a time leaves value with zero quantity (3 for 10.00, issued 1+1+1 → 3.33 × 3 = 9.99, leaving 0.01). | An issue that takes on-hand qty to 0 is valued at the **entire remaining stock value**. The same rule applies to the last unit leaving a job line. | **P0** | None |

### 1.4 Accounting decisions for the accountant [V] V-3

1. Is weighted average cost acceptable, or is FIFO required or preferred?
2. Option A for returns (cost the unit left with), and whether rounding residuals of a few fils go to COGS or inventory adjustments.
3. Whether non-recoverable VAT on purchases forms part of inventory cost (not-registered mode).
4. Classification of the close-sweep residual (unrecovered job cost vs. COGS).

---

## 2. Financial Integrity

### 2.1 One invariant replaces case-by-case rules

For each invoice, using v0.2.1 §4.1 symbols:

- *P* = payments − reversals
- *R* = **completed** refunds
- *O* = open refunds (Requested or Approved)
- **Funds F** = P + A_in − R − A_out (money and credit currently backing the invoice)
- **Balance B** = (T − C) − F
- **Available credit** = max(−B, 0) − O

**Invariant, checked under the invoice lock after every balance-changing operation:**

1. **F ≥ O** — funds are never negative and always cover open refund reservations.
2. **Available credit ≥ 0.**

Because B = (T − C) − F, rule 1 also guarantees that **outstanding never exceeds the invoice's net amount** (T − C). That is exactly the failure P0-05 described.

### 2.2 Findings

| ID | Ref | Issue | Smallest correction | Pri | Approval |
|---|---|---|---|---|---|
| **F-03** | Pre-Impl P0-05 | Reversing a **credit application** has the same defect as reversing a payment, but no guard. Example: 525.00 is applied INV-1 → INV-2; INV-2 is then fully credited and its 525.00 refunded. Reversing the application leaves INV-2 with 525.00 outstanding on a fully credited invoice. | Enforce the §2.1 invariant on **both** invoices for every operation (payment, reversal, credit note, refund request/approval/completion/failure/cancellation, credit application, application reversal). This supersedes P0-05's specific rule. When an operation is rejected, the error names the blocking record (the refund or the application). | **P0** | None |
| **F-04** | Pre-Impl P0-04 | "Cancel requested/approved refunds first" (P0-05) vs. refund reservations (P0-04) is not stated as a rule. | Covered by invariant rule 1: a payment reversal is rejected while O > 0 would make F < O. | P0 (closed by F-03) | None |
| **F-05** | Pre-Impl P0-04 | A refund can be marked Completed before the bank or card processor confirms it. There is no state for a refund that fails after completion. | Completed is **terminal** and is recorded only with an external reference. Failure is possible only from Approved. A post-completion failure is handled outside the system and escalated to a manager. | P1 | Owner (B-05, already open) |
| **F-06** | v0.2.1 §4.2 | The cash-collected definition is consistent with the balance formula. Check: over all time, Σ(P − R) across invoices = cash collected. Credit applications and credit notes are excluded. | No change. Add the reconciliation as an automated test (§5, T-10). | — | — |

---

## 3. Transaction and Numbering Integrity

### 3.1 Confirmed consistent (no change)

- Number allocated inside the issuing transaction from a locked counter: a rollback consumes no number (AT-01).
- Document, lines, stock movements, average cost, balance records, and audit events are written in **one transaction** (P0-01).
- Side effects (PDFs, audit export) run only after commit via the outbox. PDFs regenerate from the immutable snapshot.
- A deadlock causes a full rollback and one retry (P0-03).
- Business date is taken from the transaction timestamp (P1-07).

### 3.2 Findings

| ID | Ref | Issue | Smallest correction | Pri | Approval |
|---|---|---|---|---|---|
| **F-07** | Pre-Impl P0-02, AT-03 | The idempotency record isn't required to be written in the **same transaction** as the command. A crash between commit and the key write lets a retry create a duplicate. Two concurrent identical requests can also both run. | Insert the idempotency key (unique) **first, inside the command's transaction**, and store the result in the same transaction. A concurrent duplicate blocks on the unique key; once the first commits, it receives the stored result. | **P0** | None |
| **F-08** | Pre-Impl P1-01 | After a restore, some lost numbers may not be recoverable from any evidence, leaving a permanent gap. The gap report will flag it with no explanation. | The restore runbook records each unrecoverable number as a "restore gap" event in the audit log, with the restore reference. | P1 | [V] V-2 |
| **F-09** | v0.2.1 §3.4 | Vehicle Release Notes and no-charge Service Records are numbered, but it's unstated whether they share a series with invoices. | Separate series for invoices, credit notes, release notes, and service records. Each allocated identically. | P1 | [V] V-2 |

### 3.3 Numbering points requiring UAE tax-agent verification [V] V-2

Not asserted as requirements. Each needs the tax agent's confirmation:

1. Is a sequential, gap-free series required for tax invoices and credit notes?
2. Is a separate series required for credit notes?
3. Number format, prefix, and whether series reset yearly (and by which date: business date in Asia/Dubai).
4. Do zero-value documents (release notes, warranty service records) need to be tax documents or numbered within the tax series?
5. How should numbers lost in a restore, or documents reconstructed after one, be treated?
6. Is a full credit note plus replacement invoice the correct correction method (carried from v0.2.1)?

---

## 4. Approval Integrity

**Confirmed:** work on a revision can start only if a RevisionDecision of *Approved* exists inside an ApprovalEvent. A Garage Reduction event can only lower an amount on the same item (v0.2.1 §2.3 guards). Partial-work agreements need a customer decision. A withdrawn or expired version lapses only pending revisions and voids open ApprovalAttempts (P0-10, AT-19).

| ID | Ref | Issue | Smallest correction | Pri | Approval |
|---|---|---|---|---|---|
| **F-10** | Pre-Impl P1-06 | Changing the authorized contact leaves the old contact's links and pending ApprovalAttempts usable. This lets someone **no longer authorized** create an L1 ApprovalEvent and start work, which is an approval-integrity defect, not just a P1 hardening item. | **Reclassify P1-06 as P0.** In the same transaction as the contact change: revoke every open link token for the repair order and void every pending ApprovalAttempt. Each ApprovalEvent also stores a snapshot of the authorized contact at that time. | **P0** | None |
| **F-11** | Pre-Impl P0-10, AT-18 | The cumulative step-up check can race: two link submissions at the same moment each see a cumulative total below the threshold and both are accepted. | Compute the cumulative L1 total **under the repair-order lock**, which is first in the lock order (P0-03). Add a concurrent test (T-07). | **P0** | None |
| **F-12** | v0.2.1 §3.5 / §3.7; AC21-09 | It's undefined whether a phone approval counts as L1 or L2. Treating an **inbound** call from an unverified number as L2 would bypass step-up. | Record call direction and number. **Outbound call to the number on file = L2.** Any other call = L1 and counts toward the cumulative threshold. Phone approval then follows the same step-up rules as links. | **P0** | [V] V-4 (evidential value); none for the mechanism |
| **F-13** | v0.2.1 §3.3 | A stock issue can race with approval of a revision that supersedes (freezes) the same line. | Stock issue locks the revision line, following the lock order. The frozen check is re-read under that lock. | P1 | None |

---

## 5. Acceptance-Test Consistency

| ID | Test | Problem | Correction | Pri |
|---|---|---|---|---|
| T-01 | AT-13 | Contradicts F-01 (expects the specific 9.00 cost). | Rewrite: issues of 1 @ 8.00 and 1 @ 9.00, nothing billed. Return 1 → valued at line *u* = 8.50. Stock value +8.50. Line net issued cost 8.50. Then bill 1 → COGS 8.50, WIP 0.00. | P0 |
| T-02 | AT-17 | Doesn't test the remainder rule (F-02). | Add a case: receive 3 for 10.00; issue 1, 1, 1 → issue values 3.33, 3.33, 3.34; final stock value 0.00. | P0 |
| T-03 | AT-16 | "Or another split" lets an implementation without the remainder rule pass. | Fix the expected values: 3.33/0.17, 3.33/0.17, 3.34/0.16. | P0 |
| T-04 | AT-03 | Doesn't prove F-07 (crash after commit before key write). | Add fault injection: the command commits, the response is lost, the client retries with the same key → the original result is returned and no duplicate exists. | P0 |
| T-05 | AT-10 / AT-11 | Missing failure cases for refund-consumed credit and for application reversal. | Add: (a) payment reversal rejected while a refund is Requested; (b) the F-03 example — application reversal rejected because the target invoice's funds would go negative. | P0 |
| T-06 | AT-09 | Doesn't test that a Completed refund cannot be marked Failed. | Add a negative case (F-05). | P1 |
| T-07 | AT-18 | No concurrency case (F-11). | Add: two concurrent L1 submissions of 600.00 against a 1,000.00 threshold → exactly one is accepted as an ApprovalEvent; the other becomes an ApprovalAttempt. | P0 |
| T-08 | AT-19 | No contact-change case (F-10). | Add: contact changed while an attempt is pending and the old link is open → the attempt is void, the old link shows the invalid-link page, and no ApprovalEvent can be created from either. | P0 |
| T-09 | AC21-09 | Doesn't cover call direction (F-12). | Add: an inbound phone approval above the threshold is held as an ApprovalAttempt; an outbound call to the on-file number creates an L2 event. | P0 |
| T-10 | — | No end-to-end reconciliation proving F-06. | Add a property test: run a random sequence of payments, reversals, credit notes, refunds (all states), applications, and application reversals. After every step, the §2.1 invariant holds on every invoice, and Σ(P − R) equals the cash-collected report. | P0 |
| T-11 | AT-06 | Consistent (two serialized outcomes). | No change. | — |

---

## A. Remaining P0 Blockers

All are specification edits plus tests. None adds a feature.

1. **F-01** — Use line-average costing for billing and every return. Credit-note returns use the reversed COGS event's unit cost.
2. **F-02** — Remainder rule for the final unit leaving stock or a job line.
3. **F-03** — One funds invariant on every balance-changing operation (supersedes P0-05's specific rule).
4. **F-07** — Idempotency key written first, inside the command's transaction.
5. **F-10** — Authorized-contact change revokes links and voids attempts atomically (P1-06 → P0).
6. **F-11** — Cumulative step-up computed under the repair-order lock.
7. **F-12** — Phone approval is L2 only for an outbound call to the number on file.
8. **Tests T-01 to T-05 and T-07 to T-10** updated or added as above.

## B. Owner Decisions Still Required Before Implementation

Carried from the pre-implementation review; nothing new added:

| ID | Decision | Needed before |
|---|---|---|
| B-01 | Refund approval rule and who may complete refunds | Increment 3 |
| B-04 | Who holds production database and server credentials, and how the other partner oversees them | Production (decide early) |
| B-08 | Whether non-stock billable items exist | Increment 1 |
| B-09 | Step-up measured per repair order (recommended) or per estimate version | Increment 2 |
| D-33 | Credit application scope (same repair order recommended) | Increment 3 |
| D-23 | Expenses and P&L in the platform or in accounting software | Before reporting work (post-launch) |
| D-30 | Step-up threshold value (configurable, so it doesn't block coding) | Launch |

The accountant's answer on costing (§1.4) isn't needed to start. Option A is the default and is isolated to the stock-costing component. It's needed before Increment 4 is accepted.

## C. Implementation-Readiness Verdict

**Ready to start Increment 0 (foundations) and Increment 1 (happy path) once the seven P0 corrections in section A are written into the specification.** These are rule clarifications, not redesigns, and they mostly affect Increments 0, 2, 3 and 4.

- B-08 is needed during Increment 1.
- B-09, B-01 and D-33 are needed before Increments 2 and 3.
- The accountant's costing confirmation is needed before Increment 4 is accepted.
- Tax-agent answers on numbering (§3.3) are needed before production, not before coding, because series format and reset rules are configuration.
