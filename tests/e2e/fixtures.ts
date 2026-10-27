import { expect, type Page } from "@playwright/test";

import { E2E_PASSWORD, E2E_USERS } from "./users";

export { E2E_PASSWORD, E2E_PORT, E2E_USERS } from "./users";

export async function signIn(page: Page, locale: "ar" | "en", user: keyof typeof E2E_USERS) {
  await page.goto(`/${locale}/login`);
  await page.locator("#username").fill(E2E_USERS[user].username);
  await page.locator("#password").fill(E2E_PASSWORD);
  await page.locator("form.form button[type=submit]").click();
  // Technicians land on My jobs; everyone else on Today (OD-50).
  const landing = E2E_USERS[user].role === "technician" ? "/jobs" : "";
  await expect(page).toHaveURL(new RegExp(`/${locale}${landing}$`));
}

/** Submits the form inside the page content (not the top bar's search form). */
export async function submitForm(page: Page, index = 0) {
  await page.locator("main form.form").nth(index).locator("button[type=submit]").click();
}

/** Digits unique to this run and project, so desktop and tablet runs never collide. */
export function uniqueDigits(length: number): string {
  return String(Date.now() * 1000 + Math.floor(Math.random() * 1000)).slice(-length);
}
