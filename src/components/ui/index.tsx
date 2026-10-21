import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { t, type Locale } from "../../i18n";
import type { Emirate } from "../../server/db/schema";

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

/** A status shown in words with a coloured edge (deck: status never by colour alone). */
export function StatusChip({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "neutral" | "warning";
}) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}
