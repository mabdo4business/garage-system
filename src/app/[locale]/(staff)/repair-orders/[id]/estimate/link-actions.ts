"use server";

import { redirect } from "next/navigation";
import { getDb } from "../../../../../../server/db/client";
import { createCustomerLink, revokeCustomerLink } from "../../../../../../server/links/commands";
import type { FormState } from "../../../../form-state";
import { errorFrom, field, localeOf, requireActionPermission } from "../../../../server-support";

/** The new link's address: returned to the form once and shown there, never put in a redirect URL or a log. */
export type LinkFormState = FormState & { path?: string };

/** Creates the customer link (I2-03a); a live link to the same version is replaced. */
export async function createLinkAction(previous: LinkFormState, formData: FormData): Promise<LinkFormState> {
  try {
    const session = await requireActionPermission("customer_link.create");
    const outcome = await createCustomerLink(getDb(), session, field(formData, "repairOrderId"));
    return { seq: previous.seq + 1, values: {}, path: outcome.result.path };
  } catch (error) {
    return { seq: previous.seq + 1, values: {}, error: errorFrom(error) };
  }
}

export async function revokeLinkAction(previous: LinkFormState, formData: FormData): Promise<LinkFormState> {
  const locale = localeOf(formData);
  const repairOrderId = field(formData, "repairOrderId");
  try {
    const session = await requireActionPermission("customer_link.revoke");
    await revokeCustomerLink(getDb(), session, field(formData, "linkId"));
  } catch (error) {
    return { seq: previous.seq + 1, values: {}, error: errorFrom(error) };
  }
  redirect(`/${locale}/repair-orders/${repairOrderId}/estimate`);
}
