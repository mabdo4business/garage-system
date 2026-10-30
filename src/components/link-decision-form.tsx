"use client";

import { useActionState } from "react";
import { submitLinkDecision, type LinkDecisionState } from "../app/[locale]/c/[token]/actions";
import { t, type Locale } from "../i18n";
import { Alert, Button, Field } from "./ui";

const EMPTY: LinkDecisionState = { seq: 0, values: {} };

/**
 * The customer's decision through the link (I2-03b, OD-60): approve, decline or decide later per job, and their
 * typed name (recorded as evidence, never matched, OD-61). A plain form posting a server action, so it also works
 * before scripts load; the idempotency key is made when the page is shown (AC2-03).
 */
export function LinkDecisionForm({
  locale,
  token,
  idempotencyKey,
  jobs,
}: {
  locale: Locale;
  token: string;
  idempotencyKey: string;
  jobs: { revisionId: string; title: string }[];
}) {
  const [state, action, pending] = useActionState(submitLinkDecision, EMPTY);
  if (state.page) {
    // The same fixed text as the link's own message pages (AC2-04): nothing about why.
    return (
      <section className="card link-message" data-link-state={state.page} role="alert">
        <h2>{t(locale, `link.${state.page}.title`)}</h2>
        <p>{t(locale, `link.${state.page}.body`)}</p>
      </section>
    );
  }
  return (
    <form action={action} key={state.seq} className="form card approval-form link-decision-form">
      <h2>{t(locale, "link.form.title")}</h2>
      <p className="muted">{t(locale, "link.form.hint")}</p>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {state.error ? (
        <Alert tone="danger">
          <p>{t(locale, state.error)}</p>
        </Alert>
      ) : null}
      {jobs.map((job) => {
        const name = `decision.${job.revisionId}`;
        const chosen = state.values[name] ?? "";
        return (
          <fieldset key={job.revisionId} className="segmented segmented-3 approval-choice">
            <legend dir="auto">{job.title}</legend>
            {(["approved", "declined", ""] as const).map((choice) => (
              <label key={choice || "later"} className={choice ? `choice-${choice}` : undefined}>
                <input type="radio" name={name} value={choice} defaultChecked={chosen === choice} />
                <span>
                  {t(
                    locale,
                    choice === "approved"
                      ? "approval.approve"
                      : choice === "declined"
                        ? "approval.decline"
                        : "approval.later",
                  )}
                </span>
              </label>
            ))}
          </fieldset>
        );
      })}
      <Field id="approverName" label={t(locale, "link.form.name")}>
        <input
          id="approverName"
          name="approverName"
          defaultValue={state.values.approverName ?? ""}
          required
          maxLength={200}
          dir="auto"
          autoComplete="name"
        />
      </Field>
      <div className="form-actions">
        <Button type="submit" disabled={pending}>
          {t(locale, "approval.submit")}
        </Button>
      </div>
    </form>
  );
}
