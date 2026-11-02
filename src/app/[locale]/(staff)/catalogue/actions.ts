"use server";

import { redirect } from "next/navigation";
import { createItem, setItemActive, setPrice, updateItemDetails } from "../../../../server/catalog/items";
import { getDb } from "../../../../server/db/client";
import type { FormState } from "../../form-state";
import { errorFrom, field, localeOf, requireActionPermission, valuesOf } from "../../server-support";

/** Price list actions (I1-04). Partners and managers (OD-12). */

const DETAIL_FIELDS = [
  "nameEn",
  "nameAr",
  "descriptionEn",
  "descriptionAr",
  "partNo",
  "brand",
  "partType",
  "unit",
] as const;

function details(values: Record<string, string>) {
  return {
    nameEn: values.nameEn,
    nameAr: values.nameAr,
    descriptionEn: values.descriptionEn,
    descriptionAr: values.descriptionAr,
    partNo: values.partNo,
    brand: values.brand,
    partType: values.partType,
    unit: values.unit,
  };
}

export async function createItemAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, ["kind", "code", "price", "taxCode", "stockTracked", ...DETAIL_FIELDS]);
  let itemId: string;
  try {
    const session = await requireActionPermission("pricing.manage");
    const outcome = await createItem(
      getDb(),
      session,
      {
        ...details(values),
        kind: values.kind,
        code: values.code,
        price: values.price,
        taxCode: values.taxCode,
        stockTracked: values.stockTracked === "on",
      },
      field(formData, "idempotencyKey"),
    );
    itemId = outcome.result.itemId;
  } catch (error) {
    return { seq: previous.seq + 1, values, error: errorFrom(error) };
  }
  redirect(`/${locale}/catalogue/${itemId}`);
}

export async function setPriceAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, ["price", "taxCode"]);
  const itemId = field(formData, "itemId");
  try {
    const session = await requireActionPermission("pricing.manage");
    await setPrice(
      getDb(),
      session,
      itemId,
      { price: values.price, taxCode: values.taxCode },
      field(formData, "idempotencyKey"),
    );
  } catch (error) {
    return { seq: previous.seq + 1, values, error: errorFrom(error) };
  }
  redirect(`/${locale}/catalogue/${itemId}`);
}

export async function updateItemAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, DETAIL_FIELDS);
  const itemId = field(formData, "itemId");
  try {
    const session = await requireActionPermission("pricing.manage");
    await updateItemDetails(getDb(), session, itemId, details(values));
  } catch (error) {
    return { seq: previous.seq + 1, values, error: errorFrom(error) };
  }
  redirect(`/${locale}/catalogue/${itemId}`);
}

export async function setActiveAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locale = localeOf(formData);
  const itemId = field(formData, "itemId");
  try {
    const session = await requireActionPermission("pricing.manage");
    await setItemActive(getDb(), session, itemId, field(formData, "active") === "true");
  } catch (error) {
    return { seq: previous.seq + 1, values: {}, error: errorFrom(error) };
  }
  redirect(`/${locale}/catalogue/${itemId}`);
}
