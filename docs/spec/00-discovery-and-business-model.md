# Independent Car Repair Garage — Sharjah, UAE
## Discovery Questions & Proposed Business Model (Stage 1 — For Review)

**Date:** 14 October 2026
**Status:** Draft for partner review. All assumptions are labeled (A#) and must be confirmed. No market prices, licensing facts, or financial projections are asserted.
**Next step:** Once discovery questions are answered, the full PRD (journeys, workflows, backlog, Definition of Done) will be produced.

---

## 1. Proposed Business Model

### A1 — Positioning (assumption)
An independent general-repair garage for passenger cars and light SUVs. Its edge over dealers is price and speed; its edge over roadside workshops is transparency: photo check-in, digital estimates, approval before any work starts, and warranty on repairs.

### A2 — Revenue streams (assumption)
- Labor, priced either per flat-rate job or hourly (decision needed — Q8).
- Parts resale at a markup over supplier cost.
- Packaged services (e.g., oil change, periodic service, AC service).
- Diagnostics fee, possibly waived if the customer approves the repair.
- **Future:** fleet and corporate contracts, maintenance plans, pickup/drop-off service.

### A3 — Cost structure (assumption)
Rent, technician and front-desk salaries, visas and labor costs, equipment and lifts, parts inventory, utilities, insurance, licensing, software, and marketing.
*No figures are attached. Actual quotes will drive the platform's profit reporting.*

### A4 — Operating model (assumption)
Every job follows one controlled path:

```
Booking → Check-in (photos + mileage + customer concerns) → Inspection
→ Estimate → Customer approval → Repair order → Parts → Work
→ Quality check → Invoice → Payment → Delivery → Warranty & reminders
```

Each step has a status, an owner, and an audit trail. **No work is performed and no parts are issued without a recorded customer approval** — this applies to additional repairs found mid-job as well.

### A5 — Platform approach (assumption)
- **MVP:** web app for staff (desktop for front desk; tablet/phone for technicians).
- **Customers:** WhatsApp/SMS notifications plus a mobile web link for approvals and status tracking.
- **Later:** native customer app.
- **Localization:** Arabic (RTL) and English on all screens; amounts in AED; times in Asia/Dubai.

### A6 — Partner access model (proposal)
Role-based permissions rather than "owner = everything":

| Capability | Partner A | Partner B | Manager | Advisor | Technician |
|---|---|---|---|---|---|
| View financial reports | ✔ | Configurable | Limited | ✗ | ✗ |
| Approve refunds above threshold | ✔ | Dual approval? | ✗ | ✗ | ✗ |
| Edit prices / discounts above limit | ✔ | Configurable | Up to limit | Up to small limit | ✗ |
| Manage users and permissions | ✔ | Configurable | ✗ | ✗ | ✗ |
| Delete or void records | Nobody — void with reason only, fully logged | | | | |

**Principle:** sensitive actions require dual approval or are subject to AED thresholds. Final configuration depends on the partnership agreement (Q3–Q5).

---

## 2. Discovery Questions

### Critical — these shape the MVP
1. What services will you offer on day one: mechanical, electrical, AC, diagnostics, tyres, bodywork/paint, detailing? *(Bodywork changes the workflow significantly because of insurance claims.)*
2. What vehicle segments will you serve (economy, luxury/European, Japanese, 4x4, commercial), and roughly how many service bays?
3. How do you and your partner split decision rights? Is one partner operational and the other a silent investor?
4. Should either partner be able to act alone on refunds, large discounts, supplier payments, or removing staff? If not, at what AED thresholds should a second approval apply?
5. Will a hired manager run day-to-day operations? Which financials should they see?
6. Who are your customers: walk-in individuals, fleets/corporates, insurance referrals, or a mix? Do any get credit terms instead of paying on delivery?
7. Will you accept customer-supplied parts? If yes, what warranty policy applies to them?
8. Will you price labor by flat-rate job times, hourly, or both? Will you offer fixed-price service packages?

### Operations
9. What are your expected opening hours and shift pattern? Will you open on Fridays or weekends?
10. Will you accept walk-ins alongside bookings? How much buffer capacity do you want to keep?
11. Will you offer vehicle pickup/drop-off or courtesy cars?
12. Will you stock parts on-site or order per job from suppliers? Roughly how many suppliers do you plan to use?
13. Will you use OEM parts, aftermarket parts, or let the customer choose?
14. Are technicians paid salary only, or salary plus commission/incentives? *(Determines whether the system tracks per-technician productivity.)*
15. Who performs quality checks before delivery?

### Policies
16. What happens to the diagnostic fee if the customer rejects the estimate?
17. What are your cancellation and no-show rules? Will you take deposits?
18. What warranty will you give on labor and on parts (duration and/or km)? Who absorbs comeback costs?
19. How will refunds be paid: original method only, or also cash or credit note?
20. What are your storage rules for vehicles left uncollected after work is completed?

### Finance and systems
21. Will you use external accounting software, or should the platform produce full reporting itself? *(Recommendation: integrate, not replace.)*
22. Which payment methods will you accept: cash, card terminal, payment links, bank transfer, buy-now-pay-later instalments?
23. Do you want the WhatsApp Business API? *(Note: per-message cost and approved message templates required.)*
24. One branch at launch? Should the system be built multi-branch-ready from day one?
25. What is your target launch date and budget range for the platform? Will you build in-house or buy/customize an existing garage management system?

---

## 3. Items Requiring Professional Verification

These are **not stated as facts**. Each requires confirmation from the appropriate professional:

| Area | What to verify | Who |
|---|---|---|
| Licensing | Sharjah trade license activities, workshop/premises approvals, civil defence, environmental rules for oil and waste disposal | Sharjah economic development authority, PRO |
| Tax | VAT registration threshold, tax-invoice format, corporate tax obligations, applicability and timing of UAE e-invoicing requirements | UAE tax agent |
| Data privacy | Obligations under UAE federal data protection law for customer data, vehicle photos, phone numbers; record retention periods | Lawyer |
| Consumer protection | Rules on estimates, warranties, and refunds | Lawyer |
| Partnership | Profit split, signing authority — system permissions should mirror the agreement | Lawyer |
| Employment | Labor and WPS payroll obligations (if payroll enters scope) | Lawyer / HR advisor |
| Payments | Payment gateway and card-terminal compliance | Payment provider / bank |

---

## 4. Draft Scope: MVP vs. Later

### MVP
- Customer and vehicle registration
- Booking, rescheduling, and cancellation
- Photo check-in
- Inspection and estimate
- Digital customer approval, including additional-work approval
- Repair orders and technician assignment
- Basic parts inventory and purchase orders
- WhatsApp/SMS status updates
- VAT invoices and payments
- Refunds with approval workflow
- Warranty records
- Revenue, gross profit, expense entry, and P&L reporting
- Roles, approval thresholds, and audit log
- Arabic and English

### Later
- Native customer app
- Loyalty program and maintenance plans
- Fleet/corporate portal
- Insurance claims workflow
- Supplier price comparison
- Accounting software integration
- Technician productivity incentives
- Multi-branch operations
- Advanced analytics

---

## 5. How to Respond

Answer whichever questions you can. Partial answers on **Q1–Q8** are enough to proceed. Anything unanswered will be carried into the PRD as a clearly labeled assumption.
