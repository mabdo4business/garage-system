import { StatusChip } from "../../../../../../../components/ui";
import { t, type Locale, type MessageKey } from "../../../../../../../i18n";
import { formatAed } from "../../../../../../../i18n/format";
import { Money } from "../../../../../../../server/core/money";
import type { EstimateSnapshot } from "../../../../../../../server/estimate/snapshot";

/**
 * Renders an estimate from its frozen snapshot only (P0-11 #5): what the customer sees is exactly what the
 * hash covers, in the language they chose. Reused for the printed/PDF estimate later (I5-06).
 */

const aed = (amount: string, locale: Locale) => <bdi>{formatAed(Money.parse(amount), locale)}</bdi>;
const trimQty = (qty: string) => qty.replace(/\.?0+$/, "");

export function EstimateDocument({ snapshot, locale }: { snapshot: EstimateSnapshot; locale: Locale }) {
  const unit = (value: string | null) =>
    value === "hour"
      ? t(locale, "estimate.unit.hour")
      : value
        ? t(locale, `catalogue.unit.${value}` as MessageKey)
        : "";
  return (
    <div className="estimate-document">
      {snapshot.jobs.map((job) => (
        <section key={job.jobId} className="card estimate-document-job" data-revision={job.revisionId}>
          <header className="finding-head">
            <h2 dir="auto">{job.title}</h2>
            {job.findingSeverity === "urgent" ? (
              <StatusChip tone="danger">{t(locale, "finding.severity.urgent")}</StatusChip>
            ) : null}
          </header>
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
