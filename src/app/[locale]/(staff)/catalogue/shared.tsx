import type { Kysely } from "kysely";
import { Alert } from "../../../../components/ui";
import { t, type Locale } from "../../../../i18n";
import { dubaiDate } from "../../../../i18n/format";
import { taxProfileOn } from "../../../../server/catalog/tax";
import type { DB } from "../../../../server/db/schema";
import type { TaxCodeOption } from "./catalogue-forms";

/** Shown on the price list and Today until a partner sets the tax profile (OD-13). */
export async function NoTaxProfileBanner({ db, locale }: { db: Kysely<DB>; locale: Locale }) {
  if (await taxProfileOn(db, dubaiDate(new Date()))) return null;
  return (
    <Alert tone="warning">
      <p>
        <strong>{t(locale, "tax.noProfileTitle")}</strong>
      </p>
      <p>{t(locale, "tax.noProfileText")}</p>
    </Alert>
  );
}

export async function activeTaxCodes(db: Kysely<DB>, locale: Locale): Promise<TaxCodeOption[]> {
  const rows = await db
    .selectFrom("tax_code")
    .select(["code", "label_en", "label_ar"])
    .where("active", "=", true)
    .orderBy("code")
    .execute();
  return rows.map((row) => ({ code: row.code, label: locale === "ar" ? row.label_ar : row.label_en }));
}
