import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { makePng } from "../helpers/images";
import { uniqueDigits } from "./fixtures";
import { businessProfileSetUp, checkedInRepairOrder, pageFor, taxSetUp } from "./estimate-helpers";

/**
 * I1-10 in a real browser: the advisor takes a part payment in cash and the rest by card (approval code required,
 * AC2-22) and hands the car over — the repair order closes. A balance blocks the advisor's handover; a partner
 * releases with a reason (AC2-27) and the partners' dashboard shows it. A same-amount payment asks for confirmation
 * (AC2-20).
 */

const post = (page: Page, path: string, data: Record<string, unknown> = {}) =>
  page.request.post(path, { data: { idempotencyKey: randomUUID(), ...data } });

/** A repair order made Ready through the API: one approved labour line at `price`, done, QC passed, invoiced. */
async function readyRepairOrder(browser: Browser, price: string) {
  const partner = await pageFor(browser, "partner");
  const taxCode = await taxSetUp(partner);
  await businessProfileSetUp(await pageFor(browser, "partner", "ar"), `Test Garage ${uniqueDigits(5)} LLC`);
  const manager = await pageFor(browser, "manager");
  const advisor = await pageFor(browser, "advisor");
  const tech = await pageFor(browser, "technician");
  const ro = await checkedInRepairOrder(advisor);
  const item = await (
    await post(manager, "/api/catalogue", {
      kind: "labor_rate",
      code: `PAY-${uniqueDigits(6)}`,
      price,
      taxCode,
      nameEn: "Brake service",
      nameAr: "صيانة الفرامل",
    })
  ).json();
  expect((await post(advisor, `/api/repair-orders/${ro}/estimate`)).ok()).toBe(true);
  const job = await (
    await post(advisor, `/api/repair-orders/${ro}/estimate/jobs`, { title: "Brake service" })
  ).json();
  const line = await (
    await post(advisor, `/api/repair-jobs/${job.jobId}/lines`, { itemId: item.itemId, qty: "1" })
  ).json();
  const sent = await (await post(advisor, `/api/repair-orders/${ro}/estimate/send`)).json();
  const view = await (await advisor.request.get(`/api/repair-orders/${ro}/estimate`)).json();
  const approval = await advisor.request.post(`/api/estimate-versions/${sent.versionId}/approvals`, {
    multipart: {
      contentHash: sent.contentHash,
      language: "en",
      approverName: "Paying Customer",
      idempotencyKey: randomUUID(),
      [`decision.${view.jobs[0].revisionId}`]: "approved",
      signature: { name: "signature.png", mimeType: "image/png", buffer: Buffer.from(makePng(300, 100, 13)) },
    },
  });
  expect(approval.ok()).toBe(true);
  await manager.goto("/en/workshop");
  const techId = await manager
    .locator(`li[data-job="${job.jobId}"] select[name=assigneeId] option`, { hasText: "Tariq Technician" })
    .getAttribute("value");
  expect((await post(manager, `/api/jobs/${job.jobId}/assign`, { assigneeId: techId })).ok()).toBe(true);
  expect((await post(tech, `/api/jobs/${job.jobId}/start`)).ok()).toBe(true);
  expect(
    (
      await post(tech, `/api/jobs/${job.jobId}/complete`, {
        lines: [{ lineId: line.lineId, outcome: "done" }],
        note: "Done",
      })
    ).ok(),
  ).toBe(true);
  expect((await post(tech, `/api/repair-orders/${ro}/qc/request`)).ok()).toBe(true);
  expect(
    (
      await post(partner, `/api/repair-orders/${ro}/qc/pass`, {
        noNewWarningLights: true,
        roadTest: "done",
        odometerOutKm: "61050",
        fluidsOk: true,
        cleanlinessOk: true,
        belongingsOk: true,
        oldParts: "returned_to_customer",
      })
    ).ok(),
  ).toBe(true);
  const draft = await (await post(advisor, `/api/repair-orders/${ro}/invoice-drafts`)).json();
  expect((await post(advisor, `/api/invoice-drafts/${draft.draftId}/issue`)).ok()).toBe(true);
  return { ro, partner, advisor, manager };
}

const paymentsCard = (page: Page) =>
  page.locator(".card").filter({ has: page.getByRole("heading", { name: "Payments" }) });

async function pay(page: Page, amount: string, method: "Cash" | "Card" | "Bank transfer", reference = "") {
  const card = paymentsCard(page);
  await card.locator("label", { hasText: method }).click();
  await card.locator("input[name=amount]").fill(amount);
  await card.locator("input[name=reference]").fill(reference);
  await card.getByRole("button", { name: "Record payment" }).click();
}

test("advisor takes cash and card, hands the car over, and the repair order closes", async ({ browser }) => {
  test.setTimeout(120_000);
  const { ro, advisor } = await readyRepairOrder(browser, "210");
  await advisor.goto(`/en/repair-orders/${ro}`);
  const card = paymentsCard(advisor);
  await expect(card).toContainText("210.00");
  // The handover is locked while a balance is due, and says why.
  await expect(card.locator(".board-locked")).toContainText("balance due");
  await expect(card).toContainText("Only a partner can release a car with a balance due.");
  await expect(card).toContainText("Returned to the customer"); // old parts from the QC pass (OD-54)

  await pay(advisor, "100", "Cash");
  await expect(paymentsCard(advisor)).toContainText("110.00"); // balance due
  // AC2-22: a card payment needs the approval code; nothing is recorded without it.
  await pay(advisor, "110.00", "Card");
  await expect(paymentsCard(advisor).locator(".alert")).toContainText("Approval code or transfer reference");
  await expect(paymentsCard(advisor).locator(".payment-list li")).toHaveCount(1);
  // AC2-21: more than the balance is refused with the balance.
  await pay(advisor, "120.00", "Card", "A1B2C3");
  await expect(paymentsCard(advisor).locator(".alert")).toContainText(
    /Amount exceeds balance due \(\u2068?110\.00\u2069?\)/,
  );
  await pay(advisor, "110.00", "Card", "A1B2C3");
  await expect(paymentsCard(advisor)).toContainText("Paid in full");
  await expect(paymentsCard(advisor)).toContainText("A1B2C3");

  // Board: the Ready card now offers the handover.
  await advisor.goto("/en/workshop");
  await expect(advisor.locator(`[data-card="${ro}"]`).getByRole("link", { name: "Hand over" })).toBeVisible();
  await advisor.goto(`/en/repair-orders/${ro}`);
  const handover = paymentsCard(advisor);
  await handover.getByLabel("Keys handed back").check();
  await handover.getByLabel("Belongings handed back (or none were left)").check();
  await handover.getByRole("button", { name: "Hand over the car" }).click();
  await expect(advisor.locator(".page-header")).toContainText("Closed");
  await expect(paymentsCard(advisor)).toContainText("Handed over");
});

test("a balance blocks the advisor; the partner releases with a reason; a repeated amount asks first", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { ro, advisor, partner } = await readyRepairOrder(browser, "300");
  await advisor.goto(`/en/repair-orders/${ro}`);
  await pay(advisor, "50", "Cash");
  await expect(paymentsCard(advisor)).toContainText("250.00");
  // AC2-20: the same amount again within two minutes asks for confirmation; nothing is saved until confirmed.
  await pay(advisor, "50.00", "Cash");
  await expect(paymentsCard(advisor).locator(".alert")).toContainText(
    "A payment of this amount was just recorded",
  );
  await expect(paymentsCard(advisor).locator(".payment-list li")).toHaveCount(1);
  // React resets a form after its action returns; tick and save until it sticks. Repeating is safe: the form key
  // stays the same, so a second submission replays the first instead of recording another payment.
  await expect(async () => {
    if ((await paymentsCard(advisor).locator(".payment-list li").count()) < 2) {
      await paymentsCard(advisor).getByLabel("This is a second payment of the same amount").check();
      await paymentsCard(advisor).getByRole("button", { name: "Record payment" }).click();
    }
    await expect(paymentsCard(advisor).locator(".payment-list li")).toHaveCount(2, { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await expect(paymentsCard(advisor)).toContainText("200.00");
  await expect(paymentsCard(advisor).getByRole("button", { name: "Hand over the car" })).toHaveCount(0);

  // AC2-27: the partner releases with a reason, in Arabic.
  const partnerAr = await pageFor(browser, "partner", "ar");
  await partnerAr.goto(`/ar/repair-orders/${ro}`);
  const card = partnerAr
    .locator(".card")
    .filter({ has: partnerAr.getByRole("heading", { name: "المدفوعات" }) });
  await card.getByLabel("سُلِّمت المفاتيح").check();
  await card.getByLabel("سُلِّمت المتعلقات (أو لم تُترك متعلقات)").check();
  await card.locator("textarea[name=overrideReason]").fill("عميل شركة يدفع نهاية الشهر");
  await card.getByRole("button", { name: "تسليم برصيد مستحق" }).click();
  await expect(partnerAr.locator(".page-header")).toContainText("تم التسليم");
  await expect(card).toContainText("عميل شركة يدفع نهاية الشهر");

  // The partners' dashboard shows it until it is paid.
  await partner.goto("/en");
  // Most urgent first; with many items it may sit under "Show more".
  const more = partner.locator(".attention-more summary");
  if (await more.isVisible()) await more.click();
  await expect(
    partner.locator(".attention-row").filter({ hasText: "Released with balance" }).first(),
  ).toBeVisible();
  // Paying the rest after the handover closes the repair order.
  await advisor.goto(`/en/repair-orders/${ro}`);
  await pay(advisor, "200.00", "Bank transfer", "FT-778899");
  await expect(advisor.locator(".page-header")).toContainText("Closed");
});
