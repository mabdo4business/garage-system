"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "../../../../../components/ui";
import { t, type Locale, type MessageKey } from "../../../../../i18n";
import { FormErrorMessage } from "../../../form-error";
import { EMPTY_FORM_STATE } from "../../../form-state";
import { uploadPhoto } from "../../photo-upload";
import { discardPhotoAction } from "../actions";

export interface SlotPhoto {
  id: string;
  slot: string;
}

export function PhotoSlots({
  locale,
  checkInId,
  requiredSlots,
  photos,
}: {
  locale: Locale;
  checkInId: string;
  requiredSlots: string[];
  photos: SlotPhoto[];
}) {
  const router = useRouter();
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [discardState, discardAction] = useActionState(discardPhotoAction, EMPTY_FORM_STATE);

  async function upload(slot: string, file: File | undefined) {
    if (!file) return;
    setBusySlot(slot);
    setError(null);
    try {
      const failure = await uploadPhoto(`/api/check-ins/${checkInId}/photos`, file, { slot });
      if (failure) setError(failure);
      else router.refresh();
    } finally {
      setBusySlot(null);
    }
  }

  const others = photos.filter((photo) => photo.slot === "other");
  const cards = [
    ...requiredSlots.map((slot) => ({ slot, photo: photos.find((p) => p.slot === slot) })),
    ...others.map((photo) => ({ slot: "other", photo })),
    { slot: "other", photo: undefined },
  ];

  return (
    <div className="form">
      {error ? (
        <Alert tone="danger">
          <p>{t(locale, error)}</p>
        </Alert>
      ) : null}
      <FormErrorMessage locale={locale} error={discardState.error} />
      <div className="photo-grid">
        {cards.map(({ slot, photo }, index) => {
          const inputId = `photo-${slot}-${index}`;
          const label = t(locale, `checkIn.slot.${slot}` as MessageKey);
          return (
            <div key={photo?.id ?? inputId} className={photo ? "photo-slot filled" : "photo-slot"}>
              <span className="slot-name">
                {label}
                {slot !== "other" ? null : <span className="muted"> {t(locale, "common.optional")}</span>}
              </span>
              {photo ? (
                // A plain <img>: the photo comes from the private, authorized /api/media endpoint.
                <img src={`/api/media/${photo.id}`} alt={label} />
              ) : (
                <span className="placeholder">{t(locale, "checkIn.noPhoto")}</span>
              )}
              <label
                className="btn btn-secondary file-button"
                htmlFor={inputId}
                aria-disabled={busySlot !== null}
              >
                {busySlot === slot
                  ? t(locale, "checkIn.uploading")
                  : photo
                    ? t(locale, "checkIn.retakePhoto")
                    : t(locale, "checkIn.takePhoto")}
                <input
                  id={inputId}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/*"
                  capture="environment"
                  disabled={busySlot !== null}
                  data-slot={slot}
                  onChange={(event) => {
                    void upload(slot, event.currentTarget.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              {photo ? (
                <form action={discardAction}>
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="checkInId" value={checkInId} />
                  <input type="hidden" name="mediaId" value={photo.id} />
                  <button type="submit" className="btn btn-quiet">
                    {t(locale, "checkIn.removePhoto")}
                  </button>
                </form>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
