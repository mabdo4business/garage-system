# Specification Amendment v0.2.2

| Item | Value |
|---|---|
| Date | 15 October 2026 |
| Status | Approved by the owners on 15 October 2026 |
| Amends | PRD v0.2, v0.2.1 addendum, Pre-Implementation Review, Final Consistency Review |


This amendment replaces only the clauses cited. Everything else in v0.2, v0.2.1 and the two reviews stands. Where two documents conflict, v0.2.2 wins.

### A.1 Rounding and pool rule (replaces Pre-Impl P0-07 rule 1, P0-08 rule 2, P0-09 rules 3–4; implements F-01, F-02)

Clarification found while writing the formulas: "recalculate the average from stock value ÷ qty" (P0-09 rule 4) contradicts the expected values in T-02. Recalculating the average after every issue gives 3.33, 3.34, 3.33, while T-02 expects 3.33, 3.33, 3.34. One rule now governs every place where an amount is split across quantities:

**Pool rule.** A *pool* holds a quantity and a value. Its **basis unit** is value ÷ quantity, held at full precision.
1. The basis unit is recalculated **only when units enter the pool** (inbound).
2. Units leaving the pool (outbound) take round-half-up(basis unit × qty) to 2 decimals.
3. The movement that takes the pool's quantity to zero takes the **entire remaining value**.
4. A pool's value and quantity can never be negative: an outbound amount is capped at the value remaining. Quantities have 3 decimals [A].

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

