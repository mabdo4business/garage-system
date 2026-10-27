import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo, type DemoResult } from "../scripts/demo-scenario";
import { BayView, type BayForms } from "../src/app/[locale]/(staff)/jobs/[id]/bay-view";
import { formatClockDuration } from "../src/components/bay/task-ring";
import { t, type Locale } from "../src/i18n";
import { recordInPersonApproval } from "../src/server/estimate/approval";
import { LocalDiskStorage } from "../src/server/media/storage";
import {
  bookedSecondsOf,
  jobCard,
  myJobs,
  workedSeconds,
  type JobCard,
} from "../src/server/workshop/queries";
import { createTestDatabase, type TestDatabase } from "./helpers/db";
import { makePng } from "./helpers/images";
import { TEST_PASSWORD } from "./helpers/users";

/**
 * Redesign UI-R3 — the technician bay screen: approved labour and the recorded approval on the job card, the timer
 * from the job's own history, Done locked until every item has an outcome (OD-31, OD-50), no price anywhere
 * (AC2-30), "do not start" without a recorded approval (AC2-01), status as a word, and the dark tokens scoped to it.
 */

describe("S25 — technician bay screen", () => {
  let db: TestDatabase;
  let storageDir: string;
  let storage: LocalDiskStorage;
  let demo: DemoResult;
  const now = new Date();
  const forms: BayForms = {
    start: () => <span>START-FORM</span>,
    waitingParts: () => <span>WAITING-PARTS-FORM</span>,
    resume: () => <span>RESUME-FORM</span>,
    pause: () => <span>PAUSE-FORM</span>,
    requestQc: () => <span>REQUEST-QC-FORM</span>,
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    storageDir = mkdtempSync(join(tmpdir(), "garage-bay-"));
    storage = new LocalDiskStorage(storageDir);
    demo = await seedDemo(db.app, storage, TEST_PASSWORD, { suffix: ".s25" });
  }, 120_000);
  afterAll(async () => {
    await db?.destroy();
    rmSync(storageDir, { recursive: true, force: true });
  });

  /** The (first) job of a demo repair order, as the job card. */
  async function cardOf(key: string): Promise<JobCard> {
    const job = await db.app
      .selectFrom("repair_job")
      .select("id")
      .where("repair_order_id", "=", demo.repairOrders[key]!)
      .orderBy("created_at")
      .executeTakeFirstOrThrow();
    return (await jobCard(db.app, job.id))!;
  }

  async function render(
    locale: Locale,
    card: JobCard,
    options: { mine: boolean; userId?: string; canRequestQc?: boolean },
  ) {
    const queue = options.userId
      ? (await myJobs(db.app, options.userId)).filter((other) => other.id !== card.id)
      : [];
    return renderToStaticMarkup(
      <BayView
        locale={locale}
        job={card}
        mine={options.mine}
        queue={queue}
        worked={workedSeconds(
          card.history.map((event) => ({ to: event.to, at: event.at })),
          now,
        )}
        businessDate="2026-10-27"
        canRequestQc={options.canRequestQc ?? false}
        completeAction={async (previous) => previous}
        completeHidden={{ jobId: card.id, idempotencyKey: "key" }}
        forms={forms}
      />,
    );
  }

  it("the job card: approved labour in seconds (labour lines only) and how the customer approved", async () => {
    const working = await cardOf("working");
    expect(working.bookedSeconds).toBe(5400); // 1.5 h
    expect(working.approval).toMatchObject({ method: "in_person_signature" });
    expect(working.approval!.recordedAt).toBeInstanceOf(Date);
    expect((await cardOf("parts")).bookedSeconds).toBe(7200); // 2 h of labour; the part line is not time
    expect((await cardOf("awaiting")).approval).toBeNull();
    expect(bookedSecondsOf([{ unit: "piece", qty: "2.000" }])).toBeNull();
    expect(bookedSecondsOf([{ unit: "hour", qty: "0.001" }])).toBe(3); // exact to the thousandth of an hour
  });

  it("the timer counts from the job's own history and stands still while paused", async () => {
    const paused = await cardOf("paused");
    const events = paused.history.map((event) => ({ to: event.to, at: event.at }));
    // After the seed, so every start and pause is in the past.
    const at = new Date();
    const later = new Date(at.getTime() + 3_600_000);
    expect(workedSeconds(events, later)).toBe(workedSeconds(events, at));
    const working = await cardOf("working");
    const running = working.history.map((event) => ({ to: event.to, at: event.at }));
    expect(workedSeconds(running, later) - workedSeconds(running, at)).toBe(3600);
    expect(formatClockDuration(5400)).toBe("1:30:00");
    expect(formatClockDuration(3725.9)).toBe("1:02:05");
  });

  it.each(["en", "ar"] as const)(
    "%s: the assignee's working screen — Done locked with the items left, no price anywhere",
    async (locale) => {
      const card = await cardOf("working");
      const html = await render(locale, card, { mine: true, userId: demo.users["demo.tech1"].userId });
      expect(html).toContain('class="bay wide"');
      expect(html).toContain(t(locale, "job.status.in_progress"));
      expect(html).toContain(`chip-status-progress">${t(locale, "job.status.in_progress")}`);
      expect(html).toContain(t(locale, "bay.ring", { done: "0", total: "1" }));
      expect(html).toMatch(
        new RegExp(
          `<button type="button" class="bay-done" disabled="">${t(locale, "bay.doneLocked", { n: "1" })}</button>`,
        ),
      );
      expect(html).not.toContain(t(locale, "job.complete"));
      expect(html).toContain("1:30:00");
      expect(html).toContain("PAUSE-FORM");
      expect(html).not.toContain("START-FORM");
      expect(html).toContain(t(locale, "bay.approval.method.in_person_signature"));
      // Up next: tech1's other job (the one waiting for parts), with its status in words.
      const parts = await cardOf("parts");
      expect(html).toContain(`/jobs/${parts.id}`);
      expect(html).toContain(t(locale, "job.status.waiting_parts"));
      // AC2-30: no price, amount or currency (labour is 180.00, the part 420.00 in the demo price list).
      expect(html).not.toMatch(/AED|د\.إ|180|420/);
    },
  );

  it("someone else reads the screen: no form, no up-next queue, who it is assigned to", async () => {
    const card = await cardOf("working");
    const html = await render("en", card, { mine: false });
    expect(html).not.toContain("PAUSE-FORM");
    expect(html).not.toContain("bay-done");
    expect(html).not.toContain("<form");
    expect(html).not.toContain(t("en", "bay.upNext"));
    expect(html).toContain(t("en", "job.assignedTo", { name: card.assigneeName! }));
  });

  it("an approved job not started offers start and waiting for parts; a paused one resume, with the reason", async () => {
    const parts = await cardOf("parts");
    expect(parts.status).toBe("waiting_parts");
    const authorized = await render("en", { ...parts, status: "authorized" }, { mine: true });
    expect(authorized).toContain("START-FORM");
    expect(authorized).toContain("WAITING-PARTS-FORM");
    expect(authorized).not.toContain("PAUSE-FORM");
    const paused = await cardOf("paused");
    const html = await render("en", paused, { mine: true, userId: demo.users["demo.tech2"].userId });
    expect(html).toContain("RESUME-FORM");
    expect(html).toContain("Waiting for the leak-test dye to settle");
    expect(html).toContain(t("en", "bay.timer.paused"));
    expect(html).not.toContain("breathe");
  });

  it("no approval of the job (undecided, then declined in person): do not start (AC2-01), nothing offered", async () => {
    const undecided = await cardOf("awaiting");
    expect(undecided.status).toBe("not_authorized");
    expect(undecided.approval).toBeNull();
    // The customer declines the job in person: a decision is recorded, but it is not an approval.
    const version = await db.app
      .selectFrom("estimate_version")
      .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
      .select(["estimate_version.id", "estimate_version.content_hash"])
      .where("estimate.repair_order_id", "=", demo.repairOrders.awaiting!)
      .where("estimate_version.status", "=", "sent")
      .executeTakeFirstOrThrow();
    const revision = await db.app
      .selectFrom("job_revision")
      .select("id")
      .where("job_id", "=", undecided.id)
      .executeTakeFirstOrThrow();
    await recordInPersonApproval(
      db.app,
      storage,
      demo.users["demo.advisor"],
      {
        versionId: version.id,
        contentHash: version.content_hash!,
        language: "en",
        approverName: "Declining Customer",
        decisions: [{ revisionId: revision.id, decision: "declined" }],
        signature: makePng(300, 100, 42),
      },
      "00000000-0000-4000-8000-000000000025",
    );
    const declined = await cardOf("awaiting");
    expect(declined.status).toBe("not_authorized");
    expect(declined.approval).toBeNull();
    // Even for the assignee: no start, no pause, no Done.
    const html = await render("en", declined, { mine: true });
    expect(html).toContain(t("en", "bay.notApproved"));
    expect(html).not.toContain(t("en", "bay.approval.method.in_person_signature"));
    for (const form of ["START-FORM", "WAITING-PARTS-FORM", "PAUSE-FORM", "RESUME-FORM"])
      expect(html).not.toContain(form);
    expect(html).not.toContain("bay-done");
  });

  it("a finished job: done panel, recorded outcomes, QC only when it may be requested, then the next job", async () => {
    const card = await cardOf("qc");
    expect(card.status).toBe("done");
    const html = await render("ar", card, { mine: true, userId: demo.users["demo.tech2"].userId });
    expect(html).toContain(t("ar", "bay.done.title"));
    expect(html).toContain(t("ar", "job.line.done"));
    expect(html).not.toContain("REQUEST-QC-FORM");
    const paused = await cardOf("paused");
    expect(html).toContain(`/ar/jobs/${paused.id}`);
    expect(html).toContain(t("ar", "bay.done.next"));
    expect(await render("ar", card, { mine: true, canRequestQc: true })).toContain("REQUEST-QC-FORM");
    expect(await render("ar", card, { mine: true })).toContain(t("ar", "bay.done.myJobs"));
  });

  it("the bay's dark tokens match the dark theme; ticks and the ring animate only without reduced motion", () => {
    const tokens = readFileSync("src/app/[locale]/tokens.css", "utf8");
    const dark = tokens.slice(tokens.indexOf("@media (prefers-color-scheme: dark)"));
    /** The declarations of the first rule block in `css` (custom properties hold no braces). */
    const declarations = (css: string) =>
      css
        .slice(css.indexOf("{", css.indexOf(":root")) + 1)
        .split("}")[0]!
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean);
    const bay = ":root" + tokens.slice(tokens.indexOf("\n.bay {"));
    expect(declarations(bay)).toEqual(declarations(dark));
    const css = readFileSync("src/app/[locale]/components.css", "utf8");
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{\s*animation: none !important;\s*transition: none !important;/,
    );
    for (const name of ["tick", "boxin", "breathe", "ready-glow", "success"])
      expect(css).toContain(`@keyframes ${name} {`);
  });
});
