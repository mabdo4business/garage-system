"use client";

import { useActionState } from "react";
import { Alert, Button, Field } from "../../../../../components/ui";
import { t, type Locale, type MessageKey } from "../../../../../i18n";
import { FormErrorMessage } from "../../../form-error";
import { EMPTY_FORM_STATE } from "../../../form-state";
import { abandonCheckInAction, saveCheckInAction, type CheckInFormState } from "../actions";

export interface CheckInFormValues {
  contactName: string;
  contactMobile: string;
  contactRelationship: string;
  odometerKm: string;
  fuelEighths: string;
  warningLights: string;
  concerns: string;
  belongings: string;
  keysReceived: string;
  keyTag: string;
  promisedAt: string;
  photoShortfallReason: string;
}

const RELATIONSHIPS = ["owner", "driver", "company_representative", "other"] as const;
const FUEL_LABELS: MessageKey[] = [
  "checkIn.fuel.0",
  "checkIn.fuel.1",
  "checkIn.fuel.2",
  "checkIn.fuel.3",
  "checkIn.fuel.4",
  "checkIn.fuel.5",
  "checkIn.fuel.6",
  "checkIn.fuel.7",
  "checkIn.fuel.8",
];

export function CheckInForm({
  locale,
  checkInId,
  idempotencyKey,
  initial,
  missingSlots,
  showContactMobile,
  openRepairOrder,
}: {
  locale: Locale;
  checkInId: string;
  idempotencyKey: string;
  initial: CheckInFormValues;
  /** Required photo slots that have no photo yet, as labels. */
  missingSlots: string[];
  showContactMobile: boolean;
  /** OQ-1: the vehicle's other open repair order, which completing must confirm. */
  openRepairOrder: { number: string; statusLabel: string } | null;
}) {
  const [state, formAction, pending] = useActionState(
    saveCheckInAction,
    EMPTY_FORM_STATE as CheckInFormState,
  );
  // After a submission the form shows what was sent; before that, what is stored.
  const values: CheckInFormValues = { ...initial, ...state.values };
  const optional = t(locale, "common.optional");

  return (
    <form action={formAction} key={state.seq} className="form" id="check-in-form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="checkInId" value={checkInId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <FormErrorMessage locale={locale} error={state.error} />
      {state.saved ? (
        <p role="status" className="muted">
          {t(locale, "checkIn.saved")}
        </p>
      ) : null}

      <h3>{t(locale, "checkIn.section.contact")}</h3>
      <p className="muted">{t(locale, "checkIn.contactHint")}</p>
      <div className="form-grid">
        <Field id="contactName" label={t(locale, "checkIn.contactName")}>
          <input
            id="contactName"
            name="contactName"
            defaultValue={values.contactName}
            required
            autoComplete="off"
          />
        </Field>
        {showContactMobile ? (
          <Field id="contactMobile" label={t(locale, "customer.new.mobile")}>
            <input
              id="contactMobile"
              name="contactMobile"
              type="tel"
              defaultValue={values.contactMobile}
              required
              dir="ltr"
              autoComplete="off"
            />
          </Field>
        ) : null}
        <Field id="contactRelationship" label={t(locale, "checkIn.relationship")}>
          <select
            id="contactRelationship"
            name="contactRelationship"
            defaultValue={values.contactRelationship}
          >
            {RELATIONSHIPS.map((relationship) => (
              <option key={relationship} value={relationship}>
                {t(locale, `checkIn.relationship.${relationship}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <h3>{t(locale, "checkIn.section.arrival")}</h3>
      <div className="form-grid">
        <Field id="odometerKm" label={t(locale, "checkIn.odometer")}>
          <input
            id="odometerKm"
            name="odometerKm"
            inputMode="numeric"
            defaultValue={values.odometerKm}
            required
            dir="ltr"
            autoComplete="off"
          />
        </Field>
        <Field id="keysReceived" label={t(locale, "checkIn.keysReceived")} optionalLabel={optional}>
          <input
            id="keysReceived"
            name="keysReceived"
            inputMode="numeric"
            defaultValue={values.keysReceived}
            dir="ltr"
          />
        </Field>
        <Field id="keyTag" label={t(locale, "checkIn.keyTag")} optionalLabel={optional}>
          <input id="keyTag" name="keyTag" defaultValue={values.keyTag} dir="ltr" autoComplete="off" />
        </Field>
      </div>

      <fieldset className="segmented">
        <legend>
          {t(locale, "checkIn.fuel")} <span className="optional">{optional}</span>
        </legend>
        {FUEL_LABELS.map((label, eighths) => (
          <label key={label}>
            <input
              type="radio"
              name="fuelEighths"
              value={eighths}
              defaultChecked={values.fuelEighths === String(eighths)}
            />
            <span>{t(locale, label)}</span>
          </label>
        ))}
      </fieldset>

      <Field id="concerns" label={t(locale, "checkIn.concerns")}>
        <textarea id="concerns" name="concerns" defaultValue={values.concerns} required />
      </Field>
      <div className="form-grid">
        <Field
          id="warningLights"
          label={t(locale, "checkIn.warningLights")}
          hint={t(locale, "checkIn.warningLightsHint")}
          optionalLabel={optional}
        >
          <textarea id="warningLights" name="warningLights" defaultValue={values.warningLights} />
        </Field>
        <Field id="belongings" label={t(locale, "checkIn.belongings")} optionalLabel={optional}>
          <textarea id="belongings" name="belongings" defaultValue={values.belongings} />
        </Field>
      </div>
      <Field
        id="promisedAt"
        label={t(locale, "checkIn.promisedAt")}
        hint={t(locale, "checkIn.promisedAtHint")}
        optionalLabel={optional}
      >
        <input
          id="promisedAt"
          name="promisedAt"
          type="datetime-local"
          defaultValue={values.promisedAt}
          dir="ltr"
        />
      </Field>

      {missingSlots.length > 0 ? (
        <Alert tone="warning">
          <p>
            {t(locale, "checkIn.missingPhotos", {
              slots: missingSlots.join(t(locale, "common.listSeparator")),
            })}
          </p>
        </Alert>
      ) : null}
      <Field
        id="photoShortfallReason"
        label={t(locale, "checkIn.shortfallReason")}
        hint={t(locale, "checkIn.shortfallReasonHint")}
        optionalLabel={missingSlots.length > 0 ? undefined : optional}
      >
        <textarea
          id="photoShortfallReason"
          name="photoShortfallReason"
          defaultValue={values.photoShortfallReason}
        />
      </Field>

      {openRepairOrder ? (
        <Alert tone="warning">
          <p>
            {t(locale, "checkIn.openRepairOrder", { status: openRepairOrder.statusLabel })}{" "}
            <bdi dir="ltr">{openRepairOrder.number}</bdi>
          </p>
          <label className="checkbox">
            <input type="checkbox" name="confirmOpenRepairOrder" value={openRepairOrder.number} />{" "}
            {t(locale, "checkIn.confirmOpenRepairOrder")}
          </label>
        </Alert>
      ) : null}
      <div className="form-actions">
        <Button name="intent" value="complete" disabled={pending}>
          {t(locale, "checkIn.complete")}
        </Button>
        <Button name="intent" value="save" variant="secondary" disabled={pending}>
          {t(locale, "checkIn.save")}
        </Button>
      </div>
    </form>
  );
}

export function AbandonCheckInForm({ locale, checkInId }: { locale: Locale; checkInId: string }) {
  const [state, formAction, pending] = useActionState(abandonCheckInAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} key={state.seq} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="checkInId" value={checkInId} />
      <FormErrorMessage locale={locale} error={state.error} />
      <Field id="abandonedReason" label={t(locale, "checkIn.abandonReason")}>
        <input
          id="abandonedReason"
          name="abandonedReason"
          defaultValue={state.values.abandonedReason}
          required
        />
      </Field>
      <div className="form-actions">
        <Button variant="secondary" disabled={pending}>
          {t(locale, "checkIn.abandon")}
        </Button>
      </div>
    </form>
  );
}
