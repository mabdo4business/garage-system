"use client";

import { useActionState, useEffect, useState } from "react";
import { Button, Card } from "../../../../../../components/ui";
import { t, type Locale } from "../../../../../../i18n";
import { FormErrorMessage } from "../../../../form-error";
import { EMPTY_FORM_STATE } from "../../../../form-state";
import { createLinkAction, revokeLinkAction, type LinkFormState } from "./link-actions";

/** Arabic counts take one, two, 3–10 and 11+ forms; English uses the same text for the last two. */
function openedKey(count: number) {
  if (count === 1) return "link.card.openedOnce" as const;
  if (count === 2) return "link.card.openedTwice" as const;
  return count <= 10 ? ("link.card.openedTimes" as const) : ("link.card.openedMany" as const);
}

export interface LinkCardStatus {
  linkId: string;
  createdLabel: string;
  expiresLabel: string;
  opens: number;
  lastOpenedLabel: string | null;
}

/**
 * The customer link on the estimate screen (I2-03a). The address is shown once, right after it is made: only its
 * hash is kept, so a lost address is replaced by making a new link (the old one stops working, T-41).
 */
export function CustomerLinkCard({
  locale,
  repairOrderId,
  canCreate,
  canRevoke,
  live,
}: {
  locale: Locale;
  repairOrderId: string;
  canCreate: boolean;
  canRevoke: boolean;
  live: LinkCardStatus | null;
}) {
  const [created, create, creating] = useActionState<LinkFormState, FormData>(
    createLinkAction,
    EMPTY_FORM_STATE,
  );
  const [revoked, revoke, revoking] = useActionState<LinkFormState, FormData>(
    revokeLinkAction,
    EMPTY_FORM_STATE,
  );
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  const url = created.path ? `${origin}${created.path}` : null;

  return (
    <Card title={t(locale, "link.card.title")}>
      <p className="muted">{t(locale, "link.card.hint")}</p>
      {url ? (
        <div className="link-new" data-testid="customer-link-url">
          <p>
            <strong>{t(locale, "link.card.created")}</strong> {t(locale, "link.card.onlyOnce")}
          </p>
          <input readOnly value={url} dir="ltr" aria-label={t(locale, "link.card.address")} />
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(() => setCopied(true));
            }}
          >
            {copied ? t(locale, "link.card.copied") : t(locale, "link.card.copy")}
          </Button>
        </div>
      ) : live ? (
        <dl className="detail-list" data-testid="customer-link-live">
          <dt>{t(locale, "link.card.createdAt")}</dt>
          <dd>{live.createdLabel}</dd>
          <dt>{t(locale, "link.card.expiresAt")}</dt>
          <dd>{live.expiresLabel}</dd>
          <dt>{t(locale, "link.card.opened")}</dt>
          <dd>
            {live.opens === 0
              ? t(locale, "link.card.notOpened")
              : t(locale, openedKey(live.opens), {
                  count: String(live.opens),
                  last: live.lastOpenedLabel ?? "",
                })}
          </dd>
          <dd className="muted">{t(locale, "link.card.openedNote")}</dd>
        </dl>
      ) : (
        <p>{t(locale, "link.card.none")}</p>
      )}
      <FormErrorMessage locale={locale} error={created.error ?? revoked.error} />
      <div className="actions">
        {canCreate ? (
          <form action={create}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="repairOrderId" value={repairOrderId} />
            <Button type="submit" variant={live || url ? "secondary" : "primary"} disabled={creating}>
              {t(locale, live || url ? "link.card.replace" : "link.card.create")}
            </Button>
          </form>
        ) : null}
        {canRevoke && live && !url ? (
          <form action={revoke}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="repairOrderId" value={repairOrderId} />
            <input type="hidden" name="linkId" value={live.linkId} />
            <Button type="submit" variant="quiet" disabled={revoking}>
              {t(locale, "link.card.revoke")}
            </Button>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
