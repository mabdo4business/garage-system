"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "../../../../../components/ui";
import { t, type Locale, type MessageKey } from "../../../../../i18n";
import { FormErrorMessage } from "../../../form-error";
import { EMPTY_FORM_STATE } from "../../../form-state";
import { discardPhotoAction } from "../actions";

export interface SlotPhoto {
  id: string;
  slot: string;
}

/** Long edge the tablet scales photos down to before upload (T-07). */
const UPLOAD_LONG_EDGE = 2560;

/**
 * Re-encodes every camera photo as JPEG, at most UPLOAD_LONG_EDGE on its long side. Re-encoding also
 * drops metadata such as the GPS location (relevant to V-1).
 */
async function prepare(file: File): Promise<Blob> {
  if (typeof createImageBitmap !== "function") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, UPLOAD_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ?? file;
  } catch {
    // Formats the browser can't decode (e.g. some HEIC files) go up unchanged; the server decides.
    return file;
  }
}

const UPLOAD_ERRORS: Record<string, MessageKey> = {
  too_large: "checkIn.photoError.tooLarge",
  not_image: "checkIn.photoError.notImage",
};

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
      const body = new FormData();
      body.set("slot", slot);
      body.set("idempotencyKey", crypto.randomUUID());
      body.set("photo", await prepare(file), "photo");
      const response = await fetch(`/api/check-ins/${checkInId}/photos`, { method: "POST", body });
      if (!response.ok) {
        const result = (await response.json().catch(() => ({}))) as { details?: { reason?: string } };
        setError(UPLOAD_ERRORS[result.details?.reason ?? ""] ?? "checkIn.photoError.failed");
        return;
      }
      router.refresh();
    } catch {
      setError("checkIn.photoError.failed");
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
