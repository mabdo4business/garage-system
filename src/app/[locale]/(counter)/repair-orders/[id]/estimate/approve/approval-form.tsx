"use client";

import { useState } from "react";
import { useSignaturePad } from "../../../../../../../components/signature-pad";
import { Alert, Button, Field } from "../../../../../../../components/ui";
import { t, type Locale, type MessageKey } from "../../../../../../../i18n";

/**
 * The customer's decision per job, their name and a finger-drawn signature (OD-20). Sent as one multipart
 * request with the content hash of the snapshot on screen, so a decision can only land on what was shown.
 */

const ERROR_KEYS: Record<string, MessageKey> = {
  estimate_not_sent: "error.estimateNotSent",
  estimate_expired: "error.estimateExpired",
  estimate_changed: "error.estimateChanged",
  estimate_updated: "error.estimateUpdated",
  revision_not_pending: "error.revisionNotPending",
  forbidden: "error.forbidden",
  unauthenticated: "error.signedOut",
  try_again: "error.tryAgain",
};

type Choice = "approved" | "declined" | "";

export function ApprovalForm({
  locale,
  repairOrderId,
  versionId,
  contentHash,
  idempotencyKey,
  jobs,
}: {
  locale: Locale;
  repairOrderId: string;
  versionId: string;
  contentHash: string;
  idempotencyKey: string;
  jobs: { revisionId: string; title: string }[];
}) {
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [name, setName] = useState("");
  const [error, setError] = useState<MessageKey | null>(null);
  const [pending, setPending] = useState(false);
  const pad = useSignaturePad();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!Object.values(choices).some((choice) => choice !== "")) return setError("approval.chooseOne");
    if (!pad.signed) return setError("approval.signFirst");
    setPending(true);
    try {
      const blob = await pad.toBlob();
      if (!blob) return setError("approval.signFirst");
      const form = new FormData();
      form.set("contentHash", contentHash);
      form.set("language", locale);
      form.set("approverName", name);
      form.set("idempotencyKey", idempotencyKey);
      for (const [revisionId, choice] of Object.entries(choices)) form.set(`decision.${revisionId}`, choice);
      form.set("signature", blob, "signature.png");
      const response = await fetch(`/api/estimate-versions/${versionId}/approvals`, {
        method: "POST",
        body: form,
      });
      if (response.ok) {
        window.location.assign(`/${locale}/repair-orders/${repairOrderId}/estimate`);
        return;
      }
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(ERROR_KEYS[body.error ?? ""] ?? "error.validationFailed");
    } catch {
      setError("error.tryAgain");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="form card approval-form" onSubmit={submit}>
      {error ? (
        <Alert tone="danger">
          <p>{t(locale, error)}</p>
        </Alert>
      ) : null}
      {jobs.map((job) => (
        <fieldset key={job.revisionId} className="segmented segmented-3 approval-choice">
          <legend dir="auto">{job.title}</legend>
          {(["approved", "declined", ""] as const).map((choice) => (
            <label key={choice || "later"} className={choice ? `choice-${choice}` : undefined}>
              <input
                type="radio"
                name={`decision.${job.revisionId}`}
                value={choice}
                checked={(choices[job.revisionId] ?? "") === choice}
                onChange={() => setChoices((current) => ({ ...current, [job.revisionId]: choice }))}
              />
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
      ))}
      <Field id="approverName" label={t(locale, "approval.name")}>
        <input
          id="approverName"
          name="approverName"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          dir="auto"
          autoComplete="off"
        />
      </Field>
      <div className="field">
        <span id="signature-label">{t(locale, "approval.signature")}</span>
        <canvas {...pad.canvasProps} className="signature-pad" aria-labelledby="signature-label" />
        <div className="form-actions">
          <Button type="button" variant="quiet" onClick={pad.clear}>
            {t(locale, "approval.clear")}
          </Button>
        </div>
      </div>
      <div className="form-actions">
        <Button disabled={pending}>{t(locale, "approval.submit")}</Button>
      </div>
    </form>
  );
}
