import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { Alert, Card, PageHeader } from "../../../../../../../components/ui";
import { isLocale, t } from "../../../../../../../i18n";
import { formatDubaiDateTime } from "../../../../../../../i18n/format";
import { getDb } from "../../../../../../../server/db/client";
import { approvalScreenView } from "../../../../../../../server/estimate/queries";
import { requirePagePermission } from "../../../../../server-support";
import { ApprovalForm } from "./approval-form";
import { EstimateDocument } from "./estimate-document";

export const dynamic = "force-dynamic";

/**
 * The customer's decision at the counter (I1-05b, L3 in person, OD-20). Tablet-first. Everything shown comes
 * from the frozen snapshot; the page's language is the language the customer reads (recorded on the event).
 */
export default async function ApprovePage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  await requirePagePermission(locale, "estimate.record_approval", {
    entityType: "repair_order",
    entityId: id,
  });
  const view = await approvalScreenView(getDb(), id);
  if (!view) redirect(`/${locale}/repair-orders/${id}/estimate`);
  const other = locale === "ar" ? "en" : "ar";
  // An instant compared with an instant; the expiry transition itself arrives with I2-01.
  const expired = view.expiresAt.getTime() <= Date.now();
  const terms = view.termsBody[locale];

  return (
    <div className="workshop">
      <PageHeader
        title={
          <>
            {t(locale, "approval.title")} <bdi dir="ltr">{view.snapshot.repairOrderNumber}</bdi>
          </>
        }
        subtitle={t(locale, "approval.validUntil", { date: formatDubaiDateTime(view.expiresAt, locale) })}
        actions={
          <a
            className="btn btn-secondary"
            href={`/${other}/repair-orders/${id}/estimate/approve`}
            lang={other}
          >
            {t(other, "approval.language")} {t(other, "common.languageName")}
          </a>
        }
      />
      <p>{t(locale, "approval.intro")}</p>
      <EstimateDocument snapshot={view.snapshot} locale={locale} />
      {terms ? (
        <Card title={t(locale, "approval.terms")}>
          {/* The versioned text recorded in the snapshot, in the language shown (P0-11). */}
          <p className="terms-text">{terms}</p>
        </Card>
      ) : null}
      {expired ? (
        <Alert tone="danger">
          <p>{t(locale, "error.estimateExpired")}</p>
        </Alert>
      ) : view.status === "sent" && view.pendingRevisionIds.length > 0 ? (
        <ApprovalForm
          locale={locale}
          repairOrderId={id}
          versionId={view.versionId}
          contentHash={view.contentHash}
          idempotencyKey={randomUUID()}
          jobs={view.snapshot.jobs
            .filter((job) => view.pendingRevisionIds.includes(job.revisionId))
            .map((job) => ({ revisionId: job.revisionId, title: job.title }))}
        />
      ) : (
        <p className="muted">{t(locale, "approval.nothingPending")}</p>
      )}
    </div>
  );
}
