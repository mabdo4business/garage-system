import type { MessageKey } from "../../../i18n";

/** What a failed sharing request tells the advisor (I2-09): the reason when the server gave one, else a retry. */
const KEYS: Record<string, MessageKey> = {
  message_superseded: "share.error.superseded",
  not_ready: "share.error.notReady",
  forbidden: "error.forbidden",
  unauthenticated: "error.signedOut",
};

export async function shareErrorKey(response: Response | null): Promise<MessageKey> {
  if (!response) return "share.error.failed";
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return KEYS[body.error ?? ""] ?? "share.error.failed";
}
