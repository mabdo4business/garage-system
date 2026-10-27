import { expect, test } from "@playwright/test";
import { signIn } from "./fixtures";

/**
 * The workshop dashboard in a real browser (OD-49, OD-50; layout UI-R4): the partner sees the workshop flow and
 * revenue; a stage in the flow filters the repair orders, as does the search box; under prefers-reduced-motion
 * nothing animates and the real figures are on screen at once; Arabic renders right-to-left.
 */

test("partner: flow, revenue, filters; reduced motion shows final figures without animation", async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await signIn(page, "en", "partner");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Workshop overview");
  await expect(page.getByRole("heading", { name: "Workshop flow" })).toBeVisible();
  await expect(page.locator(".flow-stage")).toHaveCount(6);
  await expect(page.getByRole("heading", { name: "Revenue today" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();

  // Reduced motion: no animation runs and every count-up already shows its final value.
  const animated = await page.evaluate(
    () =>
      [...document.querySelectorAll(".flow-track, .grow, .fill-x, .live-dot")].filter(
        (element) => getComputedStyle(element).animationName !== "none",
      ).length,
  );
  expect(animated).toBe(0);
  const mismatched = await page.evaluate(() =>
    [...document.querySelectorAll(".flow-total-figure, .revenue-figure")]
      .map((element) => ({
        shown: element.querySelector("[aria-hidden=true]")?.textContent,
        final: element.querySelector(".visually-hidden")?.textContent,
      }))
      .filter(({ shown, final }) => shown !== final),
  );
  expect(mismatched).toEqual([]);

  // A stage in the flow filters the repair orders to that stage (other e2e specs leave cars at many stages).
  const orders = page.locator("#orders tbody tr");
  const all = await orders.count();
  const stage = page.locator(".flow-stage").filter({ hasText: "Checked in" });
  const checkedIn = Number(await stage.locator(".flow-stage-count").textContent());
  await stage.click();
  await expect(page).toHaveURL(/\?stage=checked_in#orders$/);
  await expect(page.locator("#orders .stage-chip")).toContainText("Checked in");
  await expect(orders).toHaveCount(Math.min(checkedIn, 12));
  for (const chip of await page.locator("#orders tbody .chip").allTextContents())
    expect(chip).toBe("Checked in");
  // Clearing the stage brings every order back.
  await page.locator("#orders .stage-chip").click();
  await expect(orders).toHaveCount(all);
  await expect(page).not.toHaveURL(/stage=/);

  // Search: a repair order number narrows the list to that order.
  const first = (await page.locator("#orders tbody tr").first().locator(".row-number").textContent())!.trim();
  await page.getByPlaceholder("Filter by number, plate, car or technician").fill(first);
  await expect(orders).toHaveCount(1);
  await expect(orders.first()).toContainText(first);
  // The row opens the repair order.
  await orders.first().click();
  await expect(page).toHaveURL(/\/en\/repair-orders\/[0-9a-f-]{36}$/);

  // Arabic: right-to-left, title in Arabic with the English beneath.
  await page.goto("/ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("نظرة عامة على الورشة");
  await expect(page.locator(".other-language")).toContainText("Workshop overview");
  await expect(page.getByRole("heading", { name: "مسار الورشة" })).toBeVisible();
  await context.close();
});

test("with motion allowed the count-up finishes on the real figure", async ({ page }) => {
  await signIn(page, "en", "manager");
  const total = page.locator(".flow-total-figure");
  const final = await total.locator(".visually-hidden").textContent();
  await expect(total.locator("[aria-hidden=true]")).toHaveText(final ?? "", { timeout: 5_000 });
});
