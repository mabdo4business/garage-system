import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DB } from "../src/server/db/schema";
import { createHandlers } from "../src/server/http/handlers";
import { createTestDatabase, type TestDatabase } from "./helpers/db";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

/**
 * I1-01 server actions and page authorization, called directly. Next's cookies/redirect/notFound
 * are replaced: redirect and notFound throw signals the tests can inspect, as they do in Next.
 */

const state = vi.hoisted(() => ({
  db: undefined as Kysely<DB> | undefined,
  token: undefined as string | undefined,
}));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}
class NotFoundSignal extends Error {}

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.token ? { name, value: state.token } : undefined),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
  notFound: () => {
    throw new NotFoundSignal();
  },
}));
vi.mock("../src/server/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/db/client")>()),
  getDb: () => state.db!,
}));

const { createCustomerAction } = await import("../src/app/[locale]/(staff)/customers/new/actions");
const { createVehicleAction } = await import("../src/app/[locale]/(staff)/vehicles/new/actions");
const { requirePagePermission } = await import("../src/app/[locale]/server-support");
const { EMPTY_FORM_STATE } = await import("../src/app/[locale]/form-state");

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

/** Runs an action; returns either the state it produced or the URL it redirected to. */
async function submit<S>(action: (previous: S, data: FormData) => Promise<S>, previous: S, data: FormData) {
  try {
    return { state: await action(previous, data) };
  } catch (error) {
    if (error instanceof RedirectSignal) return { redirect: error.url };
    throw error;
  }
}

describe("S11 — server actions and page authorization", () => {
  let db: TestDatabase;
  let advisorToken: string;
  let technicianToken: string;
  let technicianUserId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    state.db = db.app;
    const handlers = createHandlers(db.app);
    const signIn = async (username: string) => {
      const response = await handlers.login(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          body: new URLSearchParams({ username, password: TEST_PASSWORD, locale: "en" }),
        }),
      );
      const match = /gs_session=([^;]*)/.exec(response.headers.get("set-cookie") ?? "");
      return decodeURIComponent(match?.[1] ?? "");
    };
    const advisor = await makeUser(db.app, ["service_advisor"], "advisor");
    const technician = await makeUser(db.app, ["technician"], "tech");
    technicianUserId = technician.userId;
    advisorToken = await signIn(advisor.username);
    technicianToken = await signIn(technician.username);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  const customerFields = (mobile: string, key: string) => ({
    locale: "en",
    idempotencyKey: key,
    nameEn: "Action Customer",
    mobile,
    preferredLanguage: "en",
  });

  it("duplicate mobile: warns, values come back in state, and confirming counts only for the warned number", async () => {
    state.token = advisorToken;
    const first = await submit(
      createCustomerAction,
      EMPTY_FORM_STATE,
      formData(customerFields("0571000001", randomUUID())),
    );
    expect(first.redirect).toMatch(/^\/en\/customers\/[0-9a-f-]{36}$/);
    await submit(
      createCustomerAction,
      EMPTY_FORM_STATE,
      formData(customerFields("0571000002", randomUUID())),
    );

    const key = randomUUID();
    const warned = await submit(
      createCustomerAction,
      EMPTY_FORM_STATE,
      formData(customerFields("0571000001", key)),
    );
    expect(warned.state?.duplicate?.matches).toHaveLength(1);
    expect(warned.state?.values).toMatchObject({ nameEn: "Action Customer", mobile: "0571000001" });
    const confirmFor = warned.state!.duplicate!.confirmFor;

    // The advisor changes the number to another existing one after the warning: warned again.
    const switched = await submit(
      createCustomerAction,
      warned.state!,
      formData({ ...customerFields("0571000002", key), confirmFor }),
    );
    expect(switched.state?.duplicate?.matches).toHaveLength(1);

    const confirmed = await submit(
      createCustomerAction,
      warned.state!,
      formData({ ...customerFields("0571000001", key), confirmFor }),
    );
    expect(confirmed.redirect).toMatch(/^\/en\/customers\//);
    const rows = await db.app
      .selectFrom("customer")
      .select("id")
      .where("mobile_normalized", "=", "571000001")
      .execute();
    expect(rows).toHaveLength(2);

    // Re-submitting the same form instance replays to the same customer instead of warning.
    const replay = await submit(
      createCustomerAction,
      EMPTY_FORM_STATE,
      formData(customerFields("0571000001", key)),
    );
    expect(replay.redirect).toBe(confirmed.redirect);
  });

  it("domain errors come back as translated keys with the field, never as an error page", async () => {
    state.token = advisorToken;
    const invalid = await submit(
      createVehicleAction,
      EMPTY_FORM_STATE,
      formData({
        locale: "ar",
        idempotencyKey: randomUUID(),
        ownerCustomerId: randomUUID(),
        make: "Toyota",
        model: "Camry",
        year: "abc",
        plateEmirate: "sharjah",
        plateCode: "AC",
        plateNumber: "71717",
      }),
    );
    expect(invalid.state?.error).toEqual({ key: "error.validationFailed", field: "year" });
    expect(invalid.state?.values.make).toBe("Toyota");

    const unknownOwner = await submit(
      createVehicleAction,
      EMPTY_FORM_STATE,
      formData({
        locale: "en",
        idempotencyKey: randomUUID(),
        ownerCustomerId: randomUUID(),
        make: "Toyota",
        model: "Camry",
        year: "2020",
        plateEmirate: "sharjah",
        plateCode: "AC",
        plateNumber: "71718",
      }),
    );
    expect(unknownOwner.state?.error).toEqual({ key: "error.notFound" });

    state.token = technicianToken;
    const denied = await submit(
      createCustomerAction,
      EMPTY_FORM_STATE,
      formData(customerFields("0571000009", randomUUID())),
    );
    expect(denied.state?.error).toEqual({ key: "error.forbidden" });

    state.token = undefined;
    const signedOut = await submit(
      createCustomerAction,
      EMPTY_FORM_STATE,
      formData(customerFields("0571000009", randomUUID())),
    );
    expect(signedOut.state?.error).toEqual({ key: "error.signedOut" });
  });

  it("pages: no session redirects to sign-in; a missing permission is audited and shows not-found", async () => {
    state.token = undefined;
    await expect(requirePagePermission("ar", "customer.read")).rejects.toMatchObject({ url: "/ar/login" });

    state.token = technicianToken;
    await expect(requirePagePermission("en", "customer.write")).rejects.toBeInstanceOf(NotFoundSignal);
    const denied = await db.app
      .selectFrom("audit_event")
      .select("details")
      .where("action", "=", "authz.denied")
      .where("actor_user_id", "=", technicianUserId)
      .execute();
    expect(
      denied.some((row) => (row.details as { permission?: string }).permission === "customer.write"),
    ).toBe(true);

    await expect(requirePagePermission("en", "customer.read")).resolves.toMatchObject({
      userId: technicianUserId,
    });
  });
});
