"use client";

import { useState } from "react";
import { Alert, Button, Card } from "../../../../../components/ui";
import { t, type Locale, type MessageKey } from "../../../../../i18n";
import { shareErrorKey } from "../../share-errors";
import type { PreparedMessage } from "../../../../../server/messages/commands";
import { MessageShare } from "../../message-share";

/**
 * "Your car is ready for collection" (I2-09, OD-71), prepared while the car is Ready and sent from this device.
 * `status` says what happened to the last one, so a second advisor does not send it twice.
 */
export function ReadyMessageCard({
  locale,
  repairOrderId,
  status,
}: {
  locale: Locale;
  repairOrderId: string;
  status: string | null;
}) {
  const [message, setMessage] = useState<PreparedMessage | null>(null);
  const [failed, setFailed] = useState<MessageKey | null>(null);
  const [pending, setPending] = useState(false);

  async function prepare() {
    setPending(true);
    setFailed(null);
    try {
      const response = await fetch(`/api/repair-orders/${repairOrderId}/messages/ready`, { method: "POST" });
      if (response.ok) setMessage((await response.json()) as PreparedMessage);
      else setFailed(await shareErrorKey(response));
    } catch {
      setFailed(await shareErrorKey(null));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card title={t(locale, "share.readyTitle")}>
      {status ? (
        <p className="muted" data-testid="ready-message-status">
          {status}
        </p>
      ) : null}
      {failed ? (
        <Alert tone="danger">
          <p>{t(locale, failed)}</p>
        </Alert>
      ) : null}
      {message ? (
        <MessageShare locale={locale} message={message} />
      ) : (
        <Button type="button" variant="secondary" disabled={pending} onClick={() => void prepare()}>
          {t(locale, "share.prepareReady")}
        </Button>
      )}
    </Card>
  );
}
