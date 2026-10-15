"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DEFAULT_LOCALE, isLocale, type Locale } from "../../../../i18n";
import { authorize } from "../../../../server/auth/service";
import { SESSION_COOKIE, validateSession } from "../../../../server/auth/session";
import { getDb } from "../../../../server/db/client";
import {
  createCustomer,
  findDuplicateCustomersByMobile,
  type CustomerInput,
} from "../../../../server/customer/service";

function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** Server action behind the "Register customer" form — works without client-side JavaScript. */
export async function createCustomerAction(formData: FormData): Promise<void> {
  const localeRaw = field(formData, "locale");
  const locale: Locale = isLocale(localeRaw) ? localeRaw : DEFAULT_LOCALE;
  const db = getDb();
  const session = await authorize(
    db,
    await validateSession(db, (await cookies()).get(SESSION_COOKIE)?.value),
    "customer.write",
  );

  const input: CustomerInput = {
    nameEn: field(formData, "nameEn") || null,
    nameAr: field(formData, "nameAr") || null,
    mobile: field(formData, "mobile"),
    email: field(formData, "email") || null,
    preferredLanguage: field(formData, "preferredLanguage") === "ar" ? "ar" : "en",
    marketingConsent: field(formData, "marketingConsent") === "on",
  };
  const confirmDuplicate = field(formData, "confirmDuplicate") === "1";

  if (!confirmDuplicate) {
    const duplicates = await findDuplicateCustomersByMobile(db, input.mobile);
    if (duplicates.length > 0) {
      const params = new URLSearchParams({
        duplicate: "1",
        nameEn: input.nameEn ?? "",
        nameAr: input.nameAr ?? "",
        mobile: input.mobile,
        email: input.email ?? "",
        preferredLanguage: input.preferredLanguage,
        marketingConsent: input.marketingConsent ? "1" : "0",
      });
      redirect(`/${locale}/customers/new?${params.toString()}`);
    }
  }

  const outcome = await createCustomer(
    db,
    { kind: "user", userId: session.userId },
    input,
    field(formData, "idempotencyKey"),
  );
  redirect(`/${locale}/customers/${outcome.result.customerId}`);
}
