import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { Card, EmptyState, PageHeader, PlateBadge, StatusChip } from "../../../../../../components/ui";
import { isLocale, t, type MessageKey } from "../../../../../../i18n";
import { formatDubaiDateTime } from "../../../../../../i18n/format";
import { NotFoundError } from "../../../../../../server/core/errors";
import { getDb } from "../../../../../../server/db/client";
import { requireRepairOrderAccess } from "../../../../../../server/inspection/access";
import {
  getInspection,
  listChecklistTemplates,
  type FindingView,
} from "../../../../../../server/inspection/queries";
import { requirePagePermission } from "../../../../server-support";
import { AddFindingForm, EditFindingForm, FindingPhotos, WithdrawFindingForm } from "./inspection-forms";

export const dynamic = "force-dynamic";

const SEVERITY_TONE = { ok: "success", soon: "warning", urgent: "danger" } as const;

export default async function InspectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePagePermission(locale, "finding.record", {
    entityType: "repair_order",
    entityId: id,
  });
  const db = getDb();
  try {
    // AC2-30: a technician not assigned to this repair order gets "not found" (and it is logged).
    await requireRepairOrderAccess(db, session, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const inspection = await getInspection(db, id);
  if (!inspection) notFound();

  const open = inspection.status === "checked_in" || inspection.status === "diagnosing";
  const templates = await listChecklistTemplates(db);
  const query = await searchParams;
  const templateCode = typeof query.template === "string" ? query.template : "";
  const template = templates.find((candidate) => candidate.code === templateCode);
  const label = (item: { labelEn: string; labelAr: string }) =>
    locale === "ar" ? item.labelAr : item.labelEn;
  const active = inspection.findings.filter((finding) => finding.status === "active");
  const recordedItems = new Set(active.map((finding) => finding.templateItemId).filter(Boolean));
  const vehicleTitle = t(locale, "vehicle.summary", {
    make: inspection.make,
    model: inspection.model,
    year: String(inspection.year),
  });

  const findingCard = (finding: FindingView) => (
    <li key={finding.id} className={finding.status === "withdrawn" ? "finding withdrawn" : "finding"}>
      <div className="finding-head">
        <StatusChip tone={SEVERITY_TONE[finding.severity]}>
          {t(locale, `finding.severity.${finding.severity}` as MessageKey)}
        </StatusChip>
        <strong dir="auto">{finding.title}</strong>
        {finding.faultCodes.length > 0 ? (
          <bdi dir="ltr" className="muted">
            {finding.faultCodes.join(t(locale, "common.listSeparator"))}
          </bdi>
        ) : null}
      </div>
      {finding.customerNote ? <p dir="auto">{finding.customerNote}</p> : null}
      {finding.internalNote ? (
        <p className="internal-note">
          <StatusChip tone="neutral">{t(locale, "finding.internal")}</StatusChip>{" "}
          <bdi>{finding.internalNote}</bdi>
        </p>
      ) : null}
      <p className="muted">
        <bdi>{formatDubaiDateTime(finding.recordedAt, locale)}</bdi>
        {finding.recordedByName ? (
          <>
            {t(locale, "common.listSeparator")}
            <bdi>{finding.recordedByName}</bdi>
          </>
        ) : null}
      </p>
      {finding.status === "withdrawn" ? (
        <p>
          <StatusChip tone="neutral">{t(locale, "finding.withdrawn")}</StatusChip>{" "}
          <bdi>{finding.withdrawnReason}</bdi>
        </p>
      ) : (
        <>
          <FindingPhotos
            locale={locale}
            repairOrderId={inspection.repairOrderId}
            findingId={finding.id}
            photos={finding.photos}
            editable={open}
          />
          {open ? (
            <>
              <details className="disclosure">
                <summary>{t(locale, "finding.edit")}</summary>
                <EditFindingForm
                  locale={locale}
                  repairOrderId={inspection.repairOrderId}
                  findingId={finding.id}
                  initial={{
                    title: finding.title,
                    severity: finding.severity,
                    faultCodes: finding.faultCodes.join(" "),
                    customerNote: finding.customerNote ?? "",
                    internalNote: finding.internalNote ?? "",
                  }}
                />
              </details>
              <details className="disclosure">
                <summary>{t(locale, "finding.withdraw")}</summary>
                <WithdrawFindingForm
                  locale={locale}
                  repairOrderId={inspection.repairOrderId}
                  findingId={finding.id}
                />
              </details>
            </>
          ) : null}
        </>
      )}
    </li>
  );

  return (
    <div className="workshop">
      <PageHeader
        title={
          <>
            {t(locale, "inspection.title")} <bdi dir="ltr">{inspection.number}</bdi>
          </>
        }
        subtitle={
          <>
            {inspection.plate ? <PlateBadge locale={locale} plate={inspection.plate} /> : null}{" "}
            <bdi dir="ltr">{vehicleTitle}</bdi>{" "}
            <StatusChip>{t(locale, `repairOrder.status.${inspection.status}` as MessageKey)}</StatusChip>
          </>
        }
      />

      <Card title={t(locale, "inspection.fromCheckIn")}>
        <dl className="detail-list">
          <dt>{t(locale, "checkIn.concerns")}</dt>
          <dd dir="auto">{inspection.concerns}</dd>
          <dt>{t(locale, "checkIn.warningLights")}</dt>
          <dd dir="auto">{inspection.warningLights ?? t(locale, "repairOrder.none")}</dd>
          <dt>{t(locale, "inspection.technician")}</dt>
          <dd>{inspection.technician?.displayName ?? t(locale, "inspection.unassigned")}</dd>
        </dl>
      </Card>

      <Card title={t(locale, "inspection.findings")}>
        {inspection.findings.length === 0 ? (
          <EmptyState
            title={t(locale, "inspection.noFindings")}
            text={t(locale, "inspection.noFindingsHint")}
          />
        ) : (
          <ul className="finding-list">{inspection.findings.map(findingCard)}</ul>
        )}
      </Card>

      {open ? (
        <>
          <Card title={t(locale, "inspection.checklist")}>
            <nav className="form-actions" aria-label={t(locale, "inspection.checklist")}>
              {templates.map((candidate) => (
                <a
                  key={candidate.code}
                  className={candidate.code === templateCode ? "btn btn-primary" : "btn btn-secondary"}
                  href={`/${locale}/repair-orders/${id}/inspection?template=${candidate.code}`}
                  aria-current={candidate.code === templateCode ? "true" : undefined}
                >
                  {locale === "ar" ? candidate.nameAr : candidate.nameEn}
                </a>
              ))}
            </nav>
            {template ? (
              <ul className="finding-list">
                {template.items.map((item) => (
                  <li key={item.id} className="finding">
                    <div className="finding-head">
                      <strong>{label(item)}</strong>
                      {recordedItems.has(item.id) ? (
                        <StatusChip tone="success">{t(locale, "inspection.itemRecorded")}</StatusChip>
                      ) : null}
                    </div>
                    {recordedItems.has(item.id) ? null : (
                      <details className="disclosure">
                        <summary>{t(locale, "inspection.recordItem")}</summary>
                        <AddFindingForm
                          locale={locale}
                          repairOrderId={id}
                          idempotencyKey={randomUUID()}
                          templateItem={{ id: item.id, label: label(item), templateCode: template.code }}
                        />
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t(locale, "inspection.chooseChecklist")}</p>
            )}
          </Card>

          <Card title={t(locale, "inspection.addFinding")}>
            <AddFindingForm locale={locale} repairOrderId={id} idempotencyKey={randomUUID()} />
          </Card>
        </>
      ) : (
        <p className="muted">{t(locale, "inspection.closed")}</p>
      )}
      {/* The technician's own list; staff reach this screen from the repair order. */}
      {session.roles.includes("technician") ? (
        <p>
          <a href={`/${locale}/inspections`}>{t(locale, "nav.myInspections")}</a>
        </p>
      ) : (
        <p>
          <a href={`/${locale}/repair-orders/${id}`}>{t(locale, "inspection.backToRepairOrder")}</a>
        </p>
      )}
    </div>
  );
}
