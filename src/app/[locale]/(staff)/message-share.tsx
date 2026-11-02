"use client";

import { useState } from "react";
import { Alert, Button } from "../../../components/ui";
import { t, type Locale, type MessageKey } from "../../../i18n";
import { shareErrorKey } from "./share-errors";
import type { PreparedMessage } from "../../../server/messages/commands";

/**
 * A prepared customer message, sent from this device (I2-09, OD-69, OD-70): the text in the customer's language with
 * a switch to the other, "Send on WhatsApp" (opens WhatsApp to the contact with the text filled in), "Copy text" for
 * any other channel, and "I sent it", which is logged and clears "Customer not yet informed" (AC2-28).
 */
export function MessageShare({ locale, message }: { locale: Locale; message: PreparedMessage }) {
  const [language, setLanguage] = useState<"ar" | "en">(message.language);
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState<MessageKey | null>(null);
  const [pending, setPending] = useState(false);
  const body = message.bodies[language];

  async function confirm() {
    setPending(true);
    setFailed(null);
    try {
      const response = await fetch(`/api/customer-messages/${message.messageId}/shared`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language }),
      });
      if (response.ok) setSent(true);
      else setFailed(await shareErrorKey(response));
    } catch {
      setFailed(await shareErrorKey(null));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="message-share" data-testid="message-share">
      <h3>{t(locale, "share.title")}</h3>
      <p className="muted">{t(locale, "share.hint")}</p>
      <div className="form-actions" role="group" aria-label={t(locale, "share.language")}>
        {(["ar", "en"] as const).map((value) => (
          <Button
            key={value}
            type="button"
            lang={value}
            variant={language === value ? "primary" : "secondary"}
            aria-pressed={language === value}
            disabled={sent}
            onClick={() => {
              setLanguage(value);
              setCopied(false);
            }}
          >
            {t(value, "common.languageName")}
          </Button>
        ))}
      </div>
      <pre className="message-text" dir={language === "ar" ? "rtl" : "ltr"} lang={language}>
        {body}
      </pre>
      {failed ? (
        <Alert tone="danger">
          <p>{t(locale, failed)}</p>
        </Alert>
      ) : null}
      {sent ? (
        <p role="status">
          <strong>{t(locale, "share.sentDone")}</strong>
        </p>
      ) : (
        <div className="form-actions">
          <a
            className="btn btn-primary"
            href={message.whatsApp[language]}
            target="_blank"
            rel="noreferrer noopener"
            data-testid="share-whatsapp"
          >
            {t(locale, "share.whatsapp")}
          </a>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void navigator.clipboard?.writeText(body).then(() => setCopied(true))}
          >
            {copied ? t(locale, "share.copied") : t(locale, "share.copy")}
          </Button>
          <Button type="button" variant="secondary" disabled={pending} onClick={() => void confirm()}>
            {t(locale, "share.sent")}
          </Button>
        </div>
      )}
    </section>
  );
}
