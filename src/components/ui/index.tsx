import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { t, type Locale } from "../../i18n";
import type { Emirate, JobExecutionStatus, RepairOrderStatus } from "../../server/db/schema";

/**
 * The shared component set from the UI/UX deck (slide 13). Plain components without hooks, so
 * server pages and the small client forms use the same markup. Styles live in components.css.
 */

type Variant = "primary" | "secondary" | "quiet";

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type="submit" {...props} className={cx("btn", `btn-${variant}`, className)} />;
}

export function ButtonLink({
  variant = "secondary",
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; href: string }) {
  return <a {...props} className={cx("btn", `btn-${variant}`, className)} />;
}

/** Label + control + optional hint. The control is passed as children and must use `id`. */
export function Field({
  id,
  label,
  hint,
  optionalLabel,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  /** Shown after the label for fields that may be left empty, e.g. "(optional)". */
  optionalLabel?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {optionalLabel ? <span className="optional"> {optionalLabel}</span> : null}
      </label>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      {title || actions ? (
        <div className="card-header">
          {title ? <h2>{title}</h2> : null}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="titles">
        <h1>{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}

/** A table with a header row that scrolls sideways on narrow screens instead of squeezing. */
export function DataTable({ columns, rows }: { columns: string[]; rows: ReactNode[][] }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, rowIndex) => (
            <tr key={rowIndex}>
              {cells.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EmptyState({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {text ? <p>{text}</p> : null}
      {action}
    </div>
  );
}

export function Alert({ tone, children }: { tone: "danger" | "warning"; children: ReactNode }) {
  return (
    <div role="alert" className={`alert alert-${tone}`}>
      {children}
    </div>
  );
}

/**
 * A UAE plate: emirate label (follows the page direction) and the code + number isolated
 * left-to-right, so "A 12345" never reorders inside Arabic text.
 */
export function PlateBadge({
  locale,
  plate,
}: {
  locale: Locale;
  plate: { emirate: Emirate; code: string; number: string };
}) {
  return (
    <span className="plate">
      <span className="emirate">{t(locale, `emirate.${plate.emirate}`)}</span>
      <bdi className="number" dir="ltr">
        <span>{plate.code}</span>
        <span>{plate.number}</span>
      </bdi>
    </span>
  );
}

function cx(...classes: (string | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

/** The six status colour pairs of the redesign references, plus "diagnosing" (tokens.css, OD-49). */
export type StatusTone = "checked" | "diagnosing" | "approval" | "progress" | "parts" | "qc" | "ready";

/** Repair order status → its colour pair. Closed states reuse the neutral pair; the word still says which. */
export const REPAIR_ORDER_TONE: Record<RepairOrderStatus, StatusTone> = {
  checked_in: "checked",
  diagnosing: "diagnosing",
  awaiting_approval: "approval",
  in_progress: "progress",
  qc: "qc",
  release_check: "qc",
  ready: "ready",
  delivered: "checked",
  closed: "checked",
  cancelled: "checked",
};

/** Job execution status → its colour pair (waiting parts is the purple pair of the references). */
export const JOB_STATUS_TONE: Record<JobExecutionStatus, StatusTone> = {
  not_authorized: "approval",
  authorized: "checked",
  waiting_parts: "parts",
  in_progress: "progress",
  paused: "approval",
  done: "ready",
  stopped_by_customer: "checked",
  cancelled: "checked",
};

/**
 * A status shown in words (deck: status never by colour alone): a coloured edge by tone, or the filled
 * colour pair of a workshop status.
 */
export function StatusChip({
  children,
  tone = "info",
  status,
}: {
  children: ReactNode;
  tone?: "info" | "neutral" | "warning" | "success" | "danger";
  status?: StatusTone;
}) {
  return <span className={`chip ${status ? `chip-status-${status}` : `chip-${tone}`}`}>{children}</span>;
}
