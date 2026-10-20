"use server";

import { redirect } from "next/navigation";
import { idempotencyKeyUsed } from "../../../../server/command/runner";
import {
  createCustomer,
  findDuplicateCustomersByMobile,
  normalizeMobile,
  type CustomerInput,
} from "../../../../server/customer/service";
import { getDb } from "../../../../server/db/client";
import type { FormState } from "../../form-state";
import { errorFrom, field, localeOf, requireActionPermission, valuesOf } from "../../server-support";

export interface CustomerDuplicate {
  matches: { id: string; name: string }[];
  /** Normalised mobile the warning was shown for; confirming only counts for this number. */
  confirmFor: string;
}

export type CustomerFormState = FormState<CustomerDuplicate>;

const FIELDS = ["nameEn", "nameAr", "mobile", "email", "preferredLanguage", "marketingConsent"] as const;

/** Server action behind the "Register customer" form. Warns on a duplicate mobile (AC-02.4). */
export async function createCustomerAction(
  previous: CustomerFormState,
  formData: FormData,
): Promise<CustomerFormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, FIELDS);
  const seq = previous.seq + 1;
  const idempotencyKey = field(formData, "idempotencyKey");
  const db = getDb();

  let customerId: string;
  try {
    const session = await requireActionPermission("customer.write");
    const input: CustomerInput = {
      nameEn: values.nameEn || null,
      nameAr: values.nameAr || null,
      mobile: values.mobile ?? "",
      email: values.email || null,
      preferredLanguage: values.preferredLanguage === "ar" ? "ar" : "en",
      marketingConsent: values.marketingConsent === "on",
    };
    // Confirmation applies to the number that was warned about, not to whatever is typed after.
    const mobileKey = normalizeMobile(input.mobile);
    const confirmed = mobileKey !== "" && field(formData, "confirmFor") === mobileKey;
    if (!confirmed && !(await idempotencyKeyUsed(db, "customer.create", idempotencyKey))) {
      const duplicates = await findDuplicateCustomersByMobile(db, input.mobile);
      if (duplicates.length > 0) {
        return {
          seq,
          values,
          duplicate: {
            matches: duplicates.map((d) => ({ id: d.id, name: d.nameEn ?? d.nameAr ?? d.id })),
            confirmFor: mobileKey,
          },
        };
      }
    }
    const outcome = await createCustomer(db, { kind: "user", userId: session.userId }, input, idempotencyKey);
    customerId = outcome.result.customerId;
  } catch (error) {
    return { seq, values, error: errorFrom(error) };
  }
  redirect(`/${locale}/customers/${customerId}`);
}
