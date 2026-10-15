"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DEFAULT_LOCALE, isLocale, type Locale } from "../../../../i18n";
import { authorize } from "../../../../server/auth/service";
import { SESSION_COOKIE, validateSession } from "../../../../server/auth/session";
import { getDb } from "../../../../server/db/client";
import type { Emirate } from "../../../../server/db/schema";
import { changePlate, transferOwnership } from "../../../../server/vehicle/service";

function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

async function requireWriteSession(db: ReturnType<typeof getDb>) {
  return authorize(
    db,
    await validateSession(db, (await cookies()).get(SESSION_COOKIE)?.value),
    "vehicle.write",
  );
}

export async function changePlateAction(formData: FormData): Promise<void> {
  const localeRaw = field(formData, "locale");
  const locale: Locale = isLocale(localeRaw) ? localeRaw : DEFAULT_LOCALE;
  const vehicleId = field(formData, "vehicleId");
  const db = getDb();
  const session = await requireWriteSession(db);
  await changePlate(db, { kind: "user", userId: session.userId }, vehicleId, {
    emirate: field(formData, "plateEmirate") as Emirate,
    code: field(formData, "plateCode"),
    number: field(formData, "plateNumber"),
  });
  redirect(`/${locale}/vehicles/${vehicleId}`);
}

export async function transferOwnerAction(formData: FormData): Promise<void> {
  const localeRaw = field(formData, "locale");
  const locale: Locale = isLocale(localeRaw) ? localeRaw : DEFAULT_LOCALE;
  const vehicleId = field(formData, "vehicleId");
  const db = getDb();
  const session = await requireWriteSession(db);
  await transferOwnership(
    db,
    { kind: "user", userId: session.userId },
    vehicleId,
    field(formData, "newOwnerCustomerId"),
  );
  redirect(`/${locale}/vehicles/${vehicleId}`);
}
