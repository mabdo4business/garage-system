import { StatusChip } from "./ui";
import { t, type Locale, type MessageKey } from "../i18n";
import { formatAed } from "../i18n/format";
import { Money } from "../server/core/money";
import type { EstimateSnapshot } from "../server/estimate/snapshot";

/**
 * Renders an estimate from its frozen snapshot only (P0-11 #5): what the customer sees is exactly what the
 * hash covers, in the language they chose. Reused for the printed/PDF estimate later (I5-06).
 */

const aed = (amount: string, locale: Locale) => <bdi>{formatAed(Money.parse(amount), locale)}</bdi>;
const trimQty = (qty: string) => qty.replace(/\.?0+$/, "");
/** A signed amount: "+30.00 AED" / "−20.00 AED" (the sign kept outside the bidi-isolated amount). */
const signedAed = (amount: Money, locale: Locale) =>
  amount.isNegative() ? (
    <>
      − <bdi>{formatAed(Money.ZERO.sub(amount), locale)}</bdi>
    </>
  ) : (
    <>
      + <bdi>{formatAed(amount, locale)}</bdi>
    </>
  );
const AMENDMENT_KINDS = ["add_scope", "price_change", "substitution"];

export function EstimateDocument({
  snapshot,
  locale,
  photoUrl,
  visiblePhotoIds,
  decisions,
}: {
  snapshot: Pick<EstimateSnapshot, "jobs" | "earlierApproved" | "totals">;
  locale: Locale;
  /** Where a finding photo is loaded from (staff media route, or the customer link's own route). */
  photoUrl: (photoId: string) => string;
  /** When given, only these of the snapshot's photos are shown (one turned internal since sending is not). */
  visiblePhotoIds?: readonly string[];
  /** Jobs already decided, shown with their decision and no control (the customer link, read-only). */
  decisions?: ReadonlyMap<string, "approved" | "declined">;
}) {
  const unit = (value: string | null) =>
    value === "hour"
      ? t(locale, "estimate.unit.hour")
      : value
        ? t(locale, `catalogue.unit.${value}` as MessageKey)
        : "";
  // Snapshot schema 3: what the customer is shown about the finding (never its internal note, rule 9).
  function FindingDetails({
    finding,
  }: {
    finding: NonNullable<EstimateSnapshot["jobs"][number]["finding"]>;
  }) {
    const photos = finding.photoIds.filter((id) => !visiblePhotoIds || visiblePhotoIds.includes(id));
    if (!finding.customerNote && finding.faultCodes.length === 0 && photos.length === 0) return null;
    return (
      <div className="estimate-finding">
        {finding.customerNote ? (
          <p className="estimate-finding-note" dir="auto">
            {finding.customerNote}
          </p>
        ) : null}
        {finding.faultCodes.length > 0 ? (
          <p className="estimate-finding-codes">
            {t(locale, "link.faultCodes")}{" "}
            {finding.faultCodes.map((code) => (
              <bdi key={code} className="mono" dir="ltr">
                {code}
              </bdi>
            ))}
          </p>
        ) : null}
        {photos.length > 0 ? (
          <div className="estimate-finding-photos">
            {photos.map((id) => (
              <a key={id} href={photoUrl(id)} target="_blank" rel="noreferrer noopener">
                {/* A plain <img>: the photo comes from a private, authorized endpoint and is never cached. */}
                <img src={photoUrl(id)} alt={t(locale, "link.photoAlt")} loading="lazy" />
              </a>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="estimate-document">
      {snapshot.earlierApproved && snapshot.earlierApproved.length > 0 ? (
        // Context only (v0.2.1 §2.1 #4, AC21-01): no decision control here.
        <section className="card estimate-document-context">
          <h2>{t(locale, "approval.alreadyApproved")}</h2>
          <p className="muted">{t(locale, "approval.alreadyApprovedHint")}</p>
          <ul className="result-list">
            {snapshot.earlierApproved.map((job) => (
              <li key={job.revisionId} data-context-revision={job.revisionId}>
                <span dir="auto">{job.title}</span>
                <span className="num">{aed(job.total, locale)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {snapshot.jobs.map((job) => (
        <section key={job.jobId} className="card estimate-document-job" data-revision={job.revisionId}>
          <header className="finding-head">
            <h2 dir="auto">{job.title}</h2>
            {AMENDMENT_KINDS.includes(job.revisionKind) ? (
              // Schema 4 (I2-02a): a change to work the customer already approved.
              <StatusChip tone="info">
                {t(locale, `estimate.kind.${job.revisionKind}` as MessageKey)}
              </StatusChip>
            ) : null}
            {job.findingSeverity === "urgent" ? (
              <StatusChip tone="danger">{t(locale, "finding.severity.urgent")}</StatusChip>
            ) : null}
            {decisions?.get(job.revisionId) === "approved" ? (
              <StatusChip tone="success">{t(locale, "link.decision.approved")}</StatusChip>
            ) : decisions?.get(job.revisionId) === "declined" ? (
              <StatusChip tone="neutral">{t(locale, "link.decision.declined")}</StatusChip>
            ) : null}
          </header>
          {job.finding ? <FindingDetails finding={job.finding} /> : null}
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t(locale, "estimate.line.description")}</th>
                  <th scope="col">{t(locale, "estimate.line.qty")}</th>
                  <th scope="col">{t(locale, "estimate.line.unitPrice")}</th>
                  <th scope="col">{t(locale, "estimate.line.discount")}</th>
                  <th scope="col">{t(locale, "estimate.line.total")}</th>
                </tr>
              </thead>
              <tbody>
                {job.lines.map((line) => (
                  <tr key={line.lineId}>
                    <td>
                      <bdi>{locale === "ar" ? line.descriptionAr : line.descriptionEn}</bdi>
                      {line.replaces ? (
                        <span className="estimate-replaces muted" data-replaces={line.replaces.lineId}>
                          {t(locale, "estimate.line.replaces")}{" "}
                          <bdi>
                            {locale === "ar" ? line.replaces.descriptionAr : line.replaces.descriptionEn}
                          </bdi>
                          {t(locale, "common.listSeparator")}
                          <bdi dir="ltr">{trimQty(line.replaces.qty)}</bdi> {unit(line.replaces.unit)}
                          {t(locale, "common.listSeparator")}
                          {aed(line.replaces.total, locale)}
                        </span>
                      ) : null}
                    </td>
                    <td className="num">
                      <bdi dir="ltr">{trimQty(line.qty)}</bdi> {unit(line.unit)}
                    </td>
                    <td className="num">{aed(line.unitPrice, locale)}</td>
                    <td className="num">{line.discount === "0.00" ? "—" : aed(line.discount, locale)}</td>
                    <td className="num">{aed(line.total, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="estimate-job-total">
            {t(locale, "estimate.jobTotal")} <strong>{aed(job.total, locale)}</strong>
          </p>
          {(() => {
            const replaced = job.lines.reduce(
              (sum, line) => (line.replaces ? sum.add(Money.parse(line.replaces.total)) : sum),
              Money.ZERO,
            );
            if (!job.lines.some((line) => line.replaces)) return null;
            return (
              <p className="estimate-job-difference muted" data-testid="job-difference">
                {t(locale, "estimate.replacedWorth")} {aed(replaced.toString(), locale)}
                {t(locale, "common.listSeparator")}
                {t(locale, "estimate.difference")} {signedAed(Money.parse(job.total).sub(replaced), locale)}
              </p>
            );
          })()}
        </section>
      ))}
      <section className="card">
        <dl className="detail-list estimate-totals">
          <dt>{t(locale, "estimate.gross")}</dt>
          <dd className="num">{aed(snapshot.totals.gross, locale)}</dd>
          <dt>{t(locale, "estimate.discountTotal")}</dt>
          <dd className="num">{aed(snapshot.totals.discount, locale)}</dd>
          <dt>
            <strong>{t(locale, "estimate.total")}</strong>
          </dt>
          <dd className="num">
            <strong>{aed(snapshot.totals.total, locale)}</strong>
          </dd>
          {snapshot.totals.byRate
            .filter((rate) => rate.rate !== "0.00")
            .map((rate) => (
              <div key={rate.rate} className="contents">
                <dt>{t(locale, "estimate.vatAt", { rate: `\u2066${trimQty(rate.rate)}%\u2069` })}</dt>
                <dd className="num">{aed(rate.vat, locale)}</dd>
              </div>
            ))}
          <dt>{t(locale, "estimate.net")}</dt>
          <dd className="num">{aed(snapshot.totals.net, locale)}</dd>
        </dl>
        <p className="muted">{t(locale, "estimate.pricesIncludeVat")}</p>
      </section>
    </div>
  );
}
