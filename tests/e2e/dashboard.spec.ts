import { expect, test } from "@playwright/test";
import { signIn } from "./fixtures";

/**
 * Redesign (OD-49, OD-50) in a real browser: the partner's dashboard shows money; under prefers-reduced-motion
 * nothing animates and the real figures are on screen at once; Arabic renders right-to-left.
 */

test("partner: dashboard with revenue; reduced motion shows final figures without animation", async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await signIn(page, "en", "partner");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Workshop overview");
  await expect(page.locator(".kpi")).toHaveCount(4);
  await expect(page.getByRole("heading", { name: "Revenue · last 7 days" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cars by status" })).toBeVisible();

  // Reduced motion: no animation runs and every count-up already shows its final value.
  const animated = await page.evaluate(
    () =>
      [...document.querySelectorAll(".rise, .grow, .draw, .fill-x, .donut-segment, .live-dot")].filter(
        (element) => getComputedStyle(element).animationName !== "none",
      ).length,
  );
  expect(animated).toBe(0);
  const mismatched = await page.evaluate(() =>
    [...document.querySelectorAll(".kpi-value, .donut-total")]
      .map((element) => ({
        shown: element.querySelector("[aria-hidden=true]")?.textContent,
        final: element.querySelector(".visually-hidden")?.textContent,
      }))
      .filter(({ shown, final }) => shown !== final),
  );
  expect(mismatched).toEqual([]);

  // Arabic: right-to-left, title in Arabic with the English beneath.
  await page.goto("/ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("نظرة عامة على الورشة");
  await expect(page.locator(".other-language")).toContainText("Workshop overview");
  await context.close();
});

test("with motion allowed the count-up finishes on the real figure", async ({ page }) => {
  await signIn(page, "en", "manager");
  const kpi = page.locator(".kpi-value").first();
  const final = await kpi.locator(".visually-hidden").textContent();
  await expect(kpi.locator("[aria-hidden=true]")).toHaveText(final ?? "", { timeout: 5_000 });
});
