import type { Kysely } from "kysely";
import { runCommand, type CommandOutcome } from "../command/runner";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { isUuid } from "../core/ids";
import { Money } from "../core/money";
import type { CatalogueKind, DB, PartType, PartUnit } from "../db/schema";
import { conflictOnDuplicate, type Staff } from "./tax";

/**
 * Price list (US-06.1, US-08.1, PD-10): labor rates (price per hour), packages (fixed price) and parts
 * (price per unit). Parts are stock-tracked or non-stock — sublet or outside work, a one-off part
 * (P0-06, B-08). Prices include VAT (OD-14) and live in an insert-only history, so an estimate can
 * snapshot the price valid when it was made (AC2-12, I1-05). Every change is audited with before/after.
 */

export const KINDS: readonly CatalogueKind[] = ["labor_rate", "package", "part"];
export const PART_TYPES: readonly PartType[] = ["oem", "aftermarket", "other"];
export const UNITS: readonly PartUnit[] = ["piece", "set", "litre", "kg", "metre", "job"];

const actorOf = (staff: Staff) => ({ kind: "user" as const, userId: staff.userId });

function required(value: unknown, field: string, max: number): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length < 1 || trimmed.length > max)
    throw new ValidationError(`${field} is required`, { field });
  return trimmed;
}

function optional(value: unknown, field: string, max: number): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length > max) throw new ValidationError(`${field} is too long`, { field });
  return trimmed || null;
}

/** Largest amount numeric(14,2) holds: 12 whole digits. */
const MAX_PRICE = Money.parse("999999999999.99");

/** A non-negative amount with at most 2 decimals and 12 whole digits, kept exact (rule 5). */
export function parsePrice(value: unknown): string {
  try {
    const price = Money.parse(typeof value === "string" ? value.trim() : value);
    if (price.isNegative() || price.compare(MAX_PRICE) > 0) throw new Error("out of range");
    return price.toString();
  } catch {
    throw new ValidationError("Enter a price like 120 or 120.50", { field: "price" });
  }
}

export interface ItemDetails {
  nameEn: unknown;
  nameAr: unknown;
  descriptionEn?: unknown;
  descriptionAr?: unknown;
  partNo?: unknown;
  brand?: unknown;
  partType?: unknown;
  unit?: unknown;
}

function validateDetails(kind: CatalogueKind, input: ItemDetails) {
  const details = {
    name_en: required(input.nameEn, "nameEn", 200),
    name_ar: required(input.nameAr, "nameAr", 200),
    description_en: optional(input.descriptionEn, "descriptionEn", 1000),
    description_ar: optional(input.descriptionAr, "descriptionAr", 1000),
    part_no: null as string | null,
    brand: null as string | null,
    part_type: null as PartType | null,
    unit: null as PartUnit | null,
  };
  if (kind === "part") {
    details.part_no = optional(input.partNo, "partNo", 60);
    details.brand = optional(input.brand, "brand", 100);
    const partType = typeof input.partType === "string" && input.partType ? input.partType : null;
    if (partType && !PART_TYPES.includes(partType as PartType)) {
      throw new ValidationError("Choose OEM, aftermarket or other", { field: "partType" });
    }
    details.part_type = partType as PartType | null;
    if (!UNITS.includes(input.unit as PartUnit))
      throw new ValidationError("Choose a unit", { field: "unit" });
    details.unit = input.unit as PartUnit;
  }
  return details;
}

async function requireActiveTaxCode(db: Kysely<DB>, code: string): Promise<void> {
  const row = await db.selectFrom("tax_code").select("active").where("code", "=", code).executeTakeFirst();
  if (!row?.active) throw new ValidationError("Choose an active tax code", { field: "taxCode" });
}

// --------------------------------------------------------------------------- commands

export async function createItem(
  db: Kysely<DB>,
  staff: Staff,
  input: ItemDetails & {
    kind: unknown;
    code: unknown;
    stockTracked?: unknown;
    price: unknown;
    taxCode: unknown;
  },
  idempotencyKey: string,
): Promise<CommandOutcome<{ itemId: string }>> {
  const kind = input.kind as CatalogueKind;
  if (!KINDS.includes(kind))
    throw new ValidationError("Choose labor rate, package or part", { field: "kind" });
  const code = required(input.code, "code", 40);
  if (!/^[A-Za-z0-9._/-]{1,40}$/.test(code)) {
    throw new ValidationError("Code is letters, digits and . _ / -", { field: "code" });
  }
  const details = validateDetails(kind, input);
  const stockTracked = kind === "part" && input.stockTracked === true;
  const price = parsePrice(input.price);
  const taxCode = required(input.taxCode, "taxCode", 20);
  const payload = { kind, code, stockTracked, price, taxCode, ...details };
  return runCommand(
    db,
    { name: "catalogue.create_item", actor: actorOf(staff), idempotency: { key: idempotencyKey, payload } },
    async (ctx) => {
      await requireActiveTaxCode(ctx.tx, taxCode);
      const taken = await ctx.tx
        .selectFrom("catalogue_item")
        .select("id")
        .where("code", "=", code)
        .executeTakeFirst();
      if (taken) throw new ConflictError("item_code_taken", "This code is already used");
      const row = await ctx.tx
        .insertInto("catalogue_item")
        .values({
          kind,
          code,
          stock_tracked: stockTracked,
          ...details,
          created_by: staff.userId,
          updated_by: staff.userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
        .catch(conflictOnDuplicate("item_code_taken", "This code is already used"));
      await ctx.tx
        .insertInto("catalogue_price")
        .values({ item_id: row.id, price, tax_code: taxCode, set_by: staff.userId })
        .execute();
      await ctx.audit({
        action: "catalogue.item_created",
        entityType: "catalogue_item",
        entityId: row.id,
        after: payload,
      });
      return { itemId: row.id };
    },
  );
}

export async function updateItemDetails(
  db: Kysely<DB>,
  staff: Staff,
  itemId: string,
  input: ItemDetails,
): Promise<CommandOutcome<{ itemId: string }>> {
  if (!isUuid(itemId)) throw new NotFoundError("catalogue_item", itemId);
  return runCommand(db, { name: "catalogue.update_item", actor: actorOf(staff) }, async (ctx) => {
    await ctx.locks.acquire("catalogue_item", [itemId]);
    const before = await ctx.tx
      .selectFrom("catalogue_item")
      .selectAll()
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    const details = validateDetails(before.kind, input);
    await ctx.tx
      .updateTable("catalogue_item")
      .set({ ...details, updated_by: staff.userId })
      .where("id", "=", itemId)
      .execute();
    await ctx.audit({
      action: "catalogue.item_updated",
      entityType: "catalogue_item",
      entityId: itemId,
      before: {
        name_en: before.name_en,
        name_ar: before.name_ar,
        description_en: before.description_en,
        description_ar: before.description_ar,
        part_no: before.part_no,
        brand: before.brand,
        part_type: before.part_type,
        unit: before.unit,
      },
      after: details,
    });
    return { itemId };
  });
}

/** A new price from now on (the history keeps every earlier price). */
export async function setPrice(
  db: Kysely<DB>,
  staff: Staff,
  itemId: string,
  input: { price: unknown; taxCode: unknown },
  idempotencyKey: string,
): Promise<CommandOutcome<{ itemId: string }>> {
  if (!isUuid(itemId)) throw new NotFoundError("catalogue_item", itemId);
  const price = parsePrice(input.price);
  const taxCode = required(input.taxCode, "taxCode", 20);
  return runCommand(
    db,
    {
      name: "catalogue.set_price",
      actor: actorOf(staff),
      idempotency: { key: idempotencyKey, payload: { itemId, price, taxCode } },
    },
    async (ctx) => {
      await ctx.locks.acquire("catalogue_item", [itemId]);
      await requireActiveTaxCode(ctx.tx, taxCode);
      const current = await currentPrice(ctx.tx, itemId);
      if (current && current.price === price && current.taxCode === taxCode) {
        throw new ValidationError("This is already the current price", { field: "price" });
      }
      await ctx.tx
        .insertInto("catalogue_price")
        .values({ item_id: itemId, price, tax_code: taxCode, set_by: staff.userId })
        .execute();
      await ctx.audit({
        action: "catalogue.price_changed",
        entityType: "catalogue_item",
        entityId: itemId,
        before: current ? { price: current.price, taxCode: current.taxCode } : null,
        after: { price, taxCode },
      });
      return { itemId };
    },
  );
}

export async function setItemActive(
  db: Kysely<DB>,
  staff: Staff,
  itemId: string,
  active: boolean,
): Promise<CommandOutcome<{ itemId: string }>> {
  if (!isUuid(itemId)) throw new NotFoundError("catalogue_item", itemId);
  return runCommand(db, { name: "catalogue.set_active", actor: actorOf(staff) }, async (ctx) => {
    await ctx.locks.acquire("catalogue_item", [itemId]);
    const before = await ctx.tx
      .selectFrom("catalogue_item")
      .select("active")
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    if (before.active === active) throw new ValidationError("Nothing to change", { field: "active" });
    await ctx.tx
      .updateTable("catalogue_item")
      .set({ active, updated_by: staff.userId })
      .where("id", "=", itemId)
      .execute();
    await ctx.audit({
      action: active ? "catalogue.item_reactivated" : "catalogue.item_deactivated",
      entityType: "catalogue_item",
      entityId: itemId,
      before: { active: before.active },
      after: { active },
    });
    return { itemId };
  });
}

// --------------------------------------------------------------------------- reads

async function currentPrice(
  db: Kysely<DB>,
  itemId: string,
): Promise<{ price: string; taxCode: string } | null> {
  const row = await db
    .selectFrom("catalogue_price")
    .select(["price", "tax_code"])
    .where("item_id", "=", itemId)
    .orderBy("effective_from", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
  return row ? { price: row.price, taxCode: row.tax_code } : null;
}

/**
 * The price (VAT-inclusive) and tax code valid at an instant (basis for AC2-12, I1-05).
 *
 * A price row's time is when it was inserted, not committed, so asking again later for the same
 * instant can return a price that was still uncommitted the first time. Callers that must reproduce a
 * price (estimate lines) store the returned `priceId` and the values themselves — never just the instant.
 */
export async function priceAt(
  db: Kysely<DB>,
  itemId: string,
  instant: Date,
): Promise<{ priceId: string; price: string; taxCode: string; effectiveFrom: Date } | null> {
  if (!isUuid(itemId)) return null;
  const row = await db
    .selectFrom("catalogue_price")
    .select(["id", "price", "tax_code", "effective_from"])
    .where("item_id", "=", itemId)
    .where("effective_from", "<=", instant)
    .orderBy("effective_from", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
  return row
    ? { priceId: row.id, price: row.price, taxCode: row.tax_code, effectiveFrom: row.effective_from }
    : null;
}

export interface CatalogueListItem {
  id: string;
  kind: CatalogueKind;
  code: string;
  nameEn: string;
  nameAr: string;
  partNo: string | null;
  brand: string | null;
  unit: PartUnit | null;
  stockTracked: boolean;
  active: boolean;
  price: string | null;
  taxCode: string | null;
}

export async function listCatalogue(
  db: Kysely<DB>,
  options: { kind: CatalogueKind; includeInactive?: boolean; search?: string },
): Promise<CatalogueListItem[]> {
  let query = db
    .selectFrom("catalogue_item")
    .select([
      "id",
      "kind",
      "code",
      "name_en",
      "name_ar",
      "part_no",
      "brand",
      "unit",
      "stock_tracked",
      "active",
    ])
    .where("kind", "=", options.kind);
  if (!options.includeInactive) query = query.where("active", "=", true);
  const search = options.search?.trim();
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    query = query.where((eb) =>
      eb.or([
        eb("code", "ilike", like),
        eb("name_en", "ilike", like),
        eb("name_ar", "ilike", like),
        eb("part_no", "ilike", like),
      ]),
    );
  }
  const items = await query.orderBy("name_en").orderBy("id").limit(500).execute();
  const prices = await Promise.all(items.map((item) => currentPrice(db, item.id)));
  return items.map((item, index) => ({
    id: item.id,
    kind: item.kind,
    code: item.code,
    nameEn: item.name_en,
    nameAr: item.name_ar,
    partNo: item.part_no,
    brand: item.brand,
    unit: item.unit,
    stockTracked: item.stock_tracked,
    active: item.active,
    price: prices[index]?.price ?? null,
    taxCode: prices[index]?.taxCode ?? null,
  }));
}

export interface CatalogueItemView extends CatalogueListItem {
  descriptionEn: string | null;
  descriptionAr: string | null;
  partType: PartType | null;
  history: { price: string; taxCode: string; effectiveFrom: Date; setByName: string | null }[];
}

export async function getCatalogueItem(db: Kysely<DB>, itemId: string): Promise<CatalogueItemView | null> {
  if (!isUuid(itemId)) return null;
  const item = await db.selectFrom("catalogue_item").selectAll().where("id", "=", itemId).executeTakeFirst();
  if (!item) return null;
  const history = await db
    .selectFrom("catalogue_price")
    .leftJoin("app_user", "app_user.id", "catalogue_price.set_by")
    .select([
      "catalogue_price.price",
      "catalogue_price.tax_code",
      "catalogue_price.effective_from",
      "app_user.display_name",
    ])
    .where("catalogue_price.item_id", "=", itemId)
    .orderBy("catalogue_price.effective_from", "desc")
    .orderBy("catalogue_price.id", "desc")
    .execute();
  return {
    id: item.id,
    kind: item.kind,
    code: item.code,
    nameEn: item.name_en,
    nameAr: item.name_ar,
    descriptionEn: item.description_en,
    descriptionAr: item.description_ar,
    partNo: item.part_no,
    brand: item.brand,
    partType: item.part_type,
    unit: item.unit,
    stockTracked: item.stock_tracked,
    active: item.active,
    price: history[0]?.price ?? null,
    taxCode: history[0]?.tax_code ?? null,
    history: history.map((row) => ({
      price: row.price,
      taxCode: row.tax_code,
      effectiveFrom: row.effective_from,
      setByName: row.display_name,
    })),
  };
}
