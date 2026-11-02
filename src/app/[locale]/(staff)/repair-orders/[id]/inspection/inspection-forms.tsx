"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Field } from "../../../../../../components/ui";
import { t, type Locale, type MessageKey } from "../../../../../../i18n";
import { FormErrorMessage } from "../../../../form-error";
import { EMPTY_FORM_STATE } from "../../../../form-state";
import { uploadPhoto } from "../../../photo-upload";
import {
  assignInspectionAction,
  findingPhotoAction,
  recordFindingAction,
  updateFindingAction,
  withdrawFindingAction,
} from "./actions";

const SEVERITIES = ["ok", "soon", "urgent"] as const;

function SeverityChoice({
  locale,
  name,
  defaultValue,
}: {
  locale: Locale;
  name: string;
  defaultValue?: string;
}) {
  return (
    <fieldset className="segmented segmented-3">
      <legend>{t(locale, "finding.severity")}</legend>
      {SEVERITIES.map((severity) => (
        <label key={severity} className={`severity-${severity}`}>
          <input
            type="radio"
            name={name}
            value={severity}
            defaultChecked={defaultValue === severity}
            required
          />
          <span>{t(locale, `finding.severity.${severity}`)}</span>
        </label>
      ))}
    </fieldset>
  );
}

interface FindingValues {
  title?: string;
  severity?: string;
  faultCodes?: string;
  customerNote?: string;
  internalNote?: string;
}

function FindingFields({
  locale,
  idPrefix,
  values,
  fixedTitle,
}: {
  locale: Locale;
  idPrefix: string;
  values: FindingValues;
  /** Checklist items use the item's own label as the title. */
  fixedTitle?: string;
}) {
  const optional = t(locale, "common.optional");
  return (
    <>
      {fixedTitle ? (
        <input type="hidden" name="title" value={fixedTitle} />
      ) : (
        <Field id={`${idPrefix}-title`} label={t(locale, "finding.title")}>
          <input id={`${idPrefix}-title`} name="title" defaultValue={values.title} required />
        </Field>
      )}
      <SeverityChoice locale={locale} name="severity" defaultValue={values.severity} />
      <div className="form-grid">
        <Field
          id={`${idPrefix}-faultCodes`}
          label={t(locale, "finding.faultCodes")}
          hint={t(locale, "finding.faultCodesHint")}
          optionalLabel={optional}
        >
          <input
            id={`${idPrefix}-faultCodes`}
            name="faultCodes"
            defaultValue={values.faultCodes}
            dir="ltr"
            autoCapitalize="characters"
            autoComplete="off"
          />
        </Field>
      </div>
      <div className="form-grid">
        <Field
          id={`${idPrefix}-customerNote`}
          label={t(locale, "finding.customerNote")}
          hint={t(locale, "finding.customerNoteHint")}
          optionalLabel={optional}
        >
          <textarea id={`${idPrefix}-customerNote`} name="customerNote" defaultValue={values.customerNote} />
        </Field>
        <Field
          id={`${idPrefix}-internalNote`}
          label={t(locale, "finding.internalNote")}
          hint={t(locale, "finding.internalNoteHint")}
          optionalLabel={optional}
        >
          <textarea
            id={`${idPrefix}-internalNote`}
            name="internalNote"
            defaultValue={values.internalNote}
            className="internal"
          />
        </Field>
      </div>
    </>
  );
}

/** "Add finding" — free, or for one checklist item (templateItem). */
export function AddFindingForm({
  locale,
  repairOrderId,
  idempotencyKey,
  templateItem,
}: {
  locale: Locale;
  repairOrderId: string;
  idempotencyKey: string;
  templateItem?: { id: string; label: string; templateCode: string };
}) {
  const [state, formAction, pending] = useActionState(recordFindingAction, EMPTY_FORM_STATE);
  const idPrefix = templateItem ? `item-${templateItem.id}` : "new-finding";
  return (
    <form action={formAction} key={state.seq} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="repairOrderId" value={repairOrderId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {templateItem ? (
        <>
          <input type="hidden" name="templateItemId" value={templateItem.id} />
          {/* Stay on the same checklist after saving, so the next item is right there. */}
          <input type="hidden" name="template" value={templateItem.templateCode} />
        </>
      ) : null}
      <FormErrorMessage locale={locale} error={state.error} />
      <FindingFields
        locale={locale}
        idPrefix={idPrefix}
        values={state.values}
        fixedTitle={templateItem?.label}
      />
      <div className="form-actions">
        <Button disabled={pending}>{t(locale, "finding.save")}</Button>
      </div>
    </form>
  );
}

export function EditFindingForm({
  locale,
  repairOrderId,
  findingId,
  initial,
}: {
  locale: Locale;
  repairOrderId: string;
  findingId: string;
  initial: FindingValues;
}) {
  const [state, formAction, pending] = useActionState(updateFindingAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} key={state.seq} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="repairOrderId" value={repairOrderId} />
      <input type="hidden" name="findingId" value={findingId} />
      <FormErrorMessage locale={locale} error={state.error} />
      <FindingFields
        locale={locale}
        idPrefix={`edit-${findingId}`}
        values={{ ...initial, ...state.values }}
      />
      <div className="form-actions">
        <Button variant="secondary" disabled={pending}>
          {t(locale, "finding.saveChanges")}
        </Button>
      </div>
    </form>
  );
}

export function WithdrawFindingForm({
  locale,
  repairOrderId,
  findingId,
}: {
  locale: Locale;
  repairOrderId: string;
  findingId: string;
}) {
  const [state, formAction, pending] = useActionState(withdrawFindingAction, EMPTY_FORM_STATE);
  const id = `withdraw-${findingId}`;
  return (
    <form action={formAction} key={state.seq} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="repairOrderId" value={repairOrderId} />
      <input type="hidden" name="findingId" value={findingId} />
      <FormErrorMessage locale={locale} error={state.error} />
      <Field id={id} label={t(locale, "finding.withdrawReason")}>
        <input id={id} name="withdrawnReason" defaultValue={state.values.withdrawnReason} required />
      </Field>
      <Button variant="secondary" disabled={pending}>
        {t(locale, "finding.withdraw")}
      </Button>
    </form>
  );
}

/** A finding's photos: "show to customer" toggle (OD-11), remove, and camera upload. */
export function FindingPhotos({
  locale,
  repairOrderId,
  findingId,
  photos,
  editable,
}: {
  locale: Locale;
  repairOrderId: string;
  findingId: string;
  photos: { id: string; visibility: "internal" | "customer" }[];
  editable: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [state, photoAction] = useActionState(findingPhotoAction, EMPTY_FORM_STATE);
  const inputId = `finding-photo-${findingId}`;

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const failure = await uploadPhoto(`/api/findings/${findingId}/photos`, file);
      if (failure) setError(failure);
      else router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form">
      {error ? (
        <Alert tone="danger">
          <p>{t(locale, error)}</p>
        </Alert>
      ) : null}
      <FormErrorMessage locale={locale} error={state.error} />
      {photos.length > 0 ? (
        <div className="photo-grid">
          {photos.map((photo) => (
            <div key={photo.id} className="photo-slot filled">
              {/* A plain <img>: the photo comes from the private, authorized /api/media endpoint. */}
              <img src={`/api/media/${photo.id}`} alt={t(locale, "finding.photo")} />
              <span className={photo.visibility === "customer" ? "chip chip-info" : "chip chip-neutral"}>
                {t(locale, photo.visibility === "customer" ? "finding.photoShared" : "finding.photoInternal")}
              </span>
              {editable ? (
                <form action={photoAction} className="form-actions">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="repairOrderId" value={repairOrderId} />
                  <input type="hidden" name="mediaId" value={photo.id} />
                  <button
                    type="submit"
                    name="intent"
                    value={photo.visibility === "customer" ? "unshare" : "share"}
                    className="btn btn-secondary"
                  >
                    {t(
                      locale,
                      photo.visibility === "customer" ? "finding.unsharePhoto" : "finding.sharePhoto",
                    )}
                  </button>
                  <button type="submit" name="intent" value="discard" className="btn btn-quiet">
                    {t(locale, "checkIn.removePhoto")}
                  </button>
                </form>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {editable ? (
        <label className="btn btn-secondary file-button" htmlFor={inputId} aria-disabled={busy}>
          {busy ? t(locale, "checkIn.uploading") : t(locale, "finding.addPhoto")}
          <input
            id={inputId}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/*"
            capture="environment"
            disabled={busy}
            data-finding={findingId}
            onChange={(event) => {
              void onFile(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
        </label>
      ) : null}
    </div>
  );
}

export function AssignInspectionForm({
  locale,
  repairOrderId,
  technicians,
  currentTechnicianId,
}: {
  locale: Locale;
  repairOrderId: string;
  technicians: { userId: string; displayName: string }[];
  currentTechnicianId: string | null;
}) {
  const [state, formAction, pending] = useActionState(assignInspectionAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} key={state.seq} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="repairOrderId" value={repairOrderId} />
      <FormErrorMessage locale={locale} error={state.error} />
      <Field id="technicianUserId" label={t(locale, "inspection.technician")}>
        <select
          id="technicianUserId"
          name="technicianUserId"
          defaultValue={state.values.technicianUserId || currentTechnicianId || ""}
          required
        >
          <option value="" disabled>
            {t(locale, "inspection.chooseTechnician")}
          </option>
          {technicians.map((technician) => (
            <option key={technician.userId} value={technician.userId}>
              {technician.displayName}
            </option>
          ))}
        </select>
      </Field>
      <div className="form-actions">
        <Button variant={currentTechnicianId ? "secondary" : "primary"} disabled={pending}>
          {t(locale, currentTechnicianId ? "inspection.reassign" : "inspection.assign")}
        </Button>
      </div>
    </form>
  );
}
