"use client";

import { useState } from "react";
import { useSignaturePad } from "../../../../../components/signature-pad";
import { Alert, Button, Field } from "../../../../../components/ui";
import { t, type Locale, type MessageKey } from "../../../../../i18n";

/**
 * Changing the authorized contact (I2-06, OD-64–OD-67): new contact, reason, who authorized it (owner on record or
 * current contact), and how it was verified — in person with a signature (L3) or by callback to that person's
 * number on file (L2). Every customer link of the repair order stops working with the change (F-10).
 */

const RELATIONSHIPS = ["owner", "driver", "company_representative", "other"] as const;

const FIELD_LABELS: Record<string, MessageKey> = {
  newName: "contact.newName",
  newMobile: "contact.newMobile",
  newRelationship: "contact.newRelationship",
  reason: "contact.reason",
  authorizedBy: "contact.authorizedBy",
  verification: "contact.verification",
  signerName: "contact.signerName",
  signature: "contact.signature",
  calledAt: "contact.calledAt",
  spokenTo: "contact.spokenTo",
};

const ERROR_KEYS: Record<string, MessageKey> = {
  contact_changed: "contact.error.changed",
  repair_order_closed: "contact.error.closed",
  forbidden: "error.forbidden",
  unauthenticated: "error.signedOut",
  try_again: "error.tryAgain",
};

type Who = "owner" | "current_contact";
type How = "in_person" | "callback";

export function ContactChangeForm({
  locale,
  repairOrderId,
  current,
  owner,
  idempotencyKey,
}: {
  locale: Locale;
  repairOrderId: string;
  current: { name: string; mobile: string; relationship: string };
  owner: { name: string; mobile: string };
  idempotencyKey: string;
}) {
  const [who, setWho] = useState<Who | "">("");
  const [how, setHow] = useState<How | "">("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pad = useSignaturePad();
  const authorizer = who === "owner" ? owner : who === "current_contact" ? current : null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    if (how === "in_person") {
      const blob = await pad.toBlob();
      if (!blob) return setError(t(locale, "contact.error.signFirst"));
      form.set("signature", blob, "signature.png");
    }
    setPending(true);
    try {
      const response = await fetch(`/api/repair-orders/${repairOrderId}/contact`, {
        method: "POST",
        body: form,
      });
      if (response.ok) {
        window.location.reload();
        return;
      }
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        details?: { field?: string };
      };
      const field = body.details?.field;
      if (body.error === "validation_failed" && field && FIELD_LABELS[field]) {
        setError(t(locale, "contact.error.check", { field: t(locale, FIELD_LABELS[field]) }));
      } else {
        setError(t(locale, ERROR_KEYS[body.error ?? ""] ?? "error.validationFailed"));
      }
    } catch {
      setError(t(locale, "error.tryAgain"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="form contact-change-form" onSubmit={submit}>
      <input type="hidden" name="expectedName" value={current.name} />
      <input type="hidden" name="expectedMobile" value={current.mobile} />
      <input type="hidden" name="expectedRelationship" value={current.relationship} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <p className="muted">{t(locale, "contact.linksNote")}</p>
      {error ? (
        <Alert tone="danger">
          <p>{error}</p>
        </Alert>
      ) : null}
      <Field id="contact-new-name" label={t(locale, FIELD_LABELS.newName!)}>
        <input id="contact-new-name" name="newName" required maxLength={200} dir="auto" autoComplete="off" />
      </Field>
      <Field id="contact-new-mobile" label={t(locale, FIELD_LABELS.newMobile!)}>
        <input id="contact-new-mobile" name="newMobile" required maxLength={20} dir="ltr" inputMode="tel" />
      </Field>
      <Field id="contact-new-relationship" label={t(locale, FIELD_LABELS.newRelationship!)}>
        <select id="contact-new-relationship" name="newRelationship" required defaultValue="">
          <option value="" />
          {RELATIONSHIPS.map((value) => (
            <option key={value} value={value}>
              {t(locale, `checkIn.relationship.${value}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field
        id="contact-reason"
        label={t(locale, FIELD_LABELS.reason!)}
        hint={t(locale, "contact.reasonHint")}
      >
        <input id="contact-reason" name="reason" required maxLength={500} dir="auto" />
      </Field>

      <fieldset className="segmented segmented-2">
        <legend>{t(locale, FIELD_LABELS.authorizedBy!)}</legend>
        {(["owner", "current_contact"] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="authorizedBy"
              value={value}
              required
              checked={who === value}
              onChange={() => setWho(value)}
            />
            <span>
              {t(locale, `contact.authorizedBy.${value}`, {
                name: `⁨${value === "owner" ? owner.name : current.name}⁩`,
              })}
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="segmented segmented-2">
        <legend>{t(locale, FIELD_LABELS.verification!)}</legend>
        {(["in_person", "callback"] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="verification"
              value={value}
              required
              checked={how === value}
              onChange={() => setHow(value)}
            />
            <span>{t(locale, `contact.verification.${value}`)}</span>
          </label>
        ))}
      </fieldset>

      {how === "callback" ? (
        <>
          {authorizer ? (
            <p data-testid="contact-call-number">
              {t(locale, "contact.callNumber")} <bdi dir="ltr">{authorizer.mobile}</bdi>
            </p>
          ) : null}
          <Field
            id="contact-called-at"
            label={t(locale, FIELD_LABELS.calledAt!)}
            hint={t(locale, "contact.calledAtHint")}
          >
            <input id="contact-called-at" name="calledAt" type="datetime-local" required />
          </Field>
          <Field id="contact-spoken-to" label={t(locale, FIELD_LABELS.spokenTo!)}>
            <input id="contact-spoken-to" name="spokenTo" required maxLength={200} dir="auto" />
          </Field>
        </>
      ) : null}
      {how === "in_person" ? (
        <>
          <Field id="contact-signer" label={t(locale, FIELD_LABELS.signerName!)}>
            <input
              id="contact-signer"
              name="signerName"
              required
              maxLength={200}
              dir="auto"
              autoComplete="off"
            />
          </Field>
          <div className="field">
            <span id="contact-signature-label">{t(locale, FIELD_LABELS.signature!)}</span>
            <canvas
              {...pad.canvasProps}
              className="signature-pad"
              aria-labelledby="contact-signature-label"
            />
            <div className="form-actions">
              <Button type="button" variant="quiet" onClick={pad.clear}>
                {t(locale, "approval.clear")}
              </Button>
            </div>
          </div>
        </>
      ) : null}
      <div className="form-actions">
        <Button type="submit" disabled={pending}>
          {t(locale, "contact.submit")}
        </Button>
      </div>
    </form>
  );
}
