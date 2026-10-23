import type { MessageKey } from "../../../i18n";

/**
 * Camera-photo upload shared by check-in and inspection screens (client side).
 * Every photo is re-encoded as JPEG at most UPLOAD_LONG_EDGE on its long side (T-07); re-encoding
 * also drops metadata such as the GPS location (relevant to V-1).
 */
const UPLOAD_LONG_EDGE = 2560;

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

/** Uploads one photo; returns null on success or the message key to show. */
export async function uploadPhoto(
  url: string,
  file: File,
  fields: Record<string, string> = {},
): Promise<MessageKey | null> {
  try {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    body.set("idempotencyKey", crypto.randomUUID());
    body.set("photo", await prepare(file), "photo");
    const response = await fetch(url, { method: "POST", body });
    if (response.ok) return null;
    const result = (await response.json().catch(() => ({}))) as { details?: { reason?: string } };
    return UPLOAD_ERRORS[result.details?.reason ?? ""] ?? "checkIn.photoError.failed";
  } catch {
    return "checkIn.photoError.failed";
  }
}
