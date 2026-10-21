---
description: Checklist for adding a database migration in this project. Use whenever a table, column, index, constraint or grant changes.
---

Adding a migration:

1. Create the next file `db/migrations/NNNN_short_name.sql` (four digits, lowercase, underscores). Never edit a migration
   that is already committed — the runner rejects changed checksums.
2. Write plain SQL that runs as `garage_owner`. Use:
   - `numeric(14,2)` for money, `numeric(18,3)` for quantities, `timestamptz` for instants, `date` for business dates
   - `uuid PRIMARY KEY DEFAULT gen_random_uuid()` for ids
   - `CHECK` constraints for single-row rules, `UNIQUE`/partial unique indexes for "at most one" rules
   - foreign keys for every reference
   - a `business_date date NOT NULL` column on every financial record
3. Grant `garage_app` only what the code needs, column by column for UPDATE. Issued documents, ledgers (stock movements,
   payments, approvals) and audit tables get `SELECT, INSERT` only.
4. If a new table must be locked by commands, register it in `LOCK_RANK` / `LOCK_TARGETS`
   (`src/server/command/locks.ts`) at the correct rank.
5. Add the table types to `src/server/db/schema.ts` (numeric and bigint as `string`, dates as `string`).
6. Add or extend a test that proves the grants: the app role cannot UPDATE/DELETE what it must not
   (see `tests/s1-roles.test.ts`, `sqlErrorAs`).
7. Run `npm run check`.
