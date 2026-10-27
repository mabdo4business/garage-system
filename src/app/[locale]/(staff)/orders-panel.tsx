"use client";

import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import type { DashboardStatus } from "../../../server/reporting/dashboard";

/**
 * The dashboard's repair orders (UI-R4): filter by stage (also set from the workshop flow strip through `?stage=`),
 * overdue only, and a search over number, plate, car, services and technicians. Rows arrive already rendered by
 * the server (same formatting and permissions as the rest of the page); this only chooses which to show.
 */

export interface OrderItem {
  id: string;
  status: DashboardStatus;
  overdue: boolean;
  /** The repair order; a click anywhere on the row opens it (the number is the keyboard link). */
  href: string;
  /** Lower-case text searched by the box. */
  haystack: string;
  row: ReactNode;
}

const FIRST = 12;

export function OrdersPanel({
  items,
  head,
  initialStage,
  labels,
}: {
  items: OrderItem[];
  head: ReactNode;
  initialStage: DashboardStatus | null;
  labels: {
    group: string;
    all: string;
    overdue: string;
    search: string;
    clearStage: string;
    stageName: Partial<Record<DashboardStatus, string>>;
    noMatch: string;
    /** "Show all"; the count is shown beside it. */
    showAll: string;
    showFewer: string;
  };
}) {
  const [stage, setStage] = useState<DashboardStatus | null>(initialStage);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);

  // A new filter starts from the short list again.
  useEffect(() => setExpanded(false), [stage, overdueOnly, query]);

  /** Row click opens the order, except on links or while selecting text. */
  const openRow = (event: MouseEvent<HTMLTableRowElement>, href: string) => {
    if ((event.target as HTMLElement).closest("a, button") || window.getSelection()?.toString()) return;
    window.location.assign(href);
  };

  // Keep the stage in the address, so a reload or a shared link shows the same list.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (stage) url.searchParams.set("stage", stage);
    else url.searchParams.delete("stage");
    window.history.replaceState(null, "", url);
  }, [stage]);

  const matching = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter(
      (item) => (!stage || item.status === stage) && words.every((word) => item.haystack.includes(word)),
    );
  }, [items, stage, query]);
  const overdueCount = matching.filter((item) => item.overdue).length;
  const shown = overdueOnly ? matching.filter((item) => item.overdue) : matching;
  const visible = expanded ? shown : shown.slice(0, FIRST);

  return (
    <>
      <div className="orders-tools" role="group" aria-label={labels.group}>
        <div className="segmented-tabs">
          <button type="button" aria-pressed={!overdueOnly} onClick={() => setOverdueOnly(false)}>
            {labels.all}
          </button>
          <button type="button" aria-pressed={overdueOnly} onClick={() => setOverdueOnly(true)}>
            {labels.overdue}
            <span className="tab-count">{overdueCount}</span>
          </button>
        </div>
        {stage ? (
          <button type="button" className="stage-chip" onClick={() => setStage(null)}>
            {labels.stageName[stage]}
            <span className="visually-hidden">{labels.clearStage}</span>
            <span aria-hidden="true" className="stage-chip-x">
              ×
            </span>
          </button>
        ) : null}
        <input
          type="search"
          className="orders-search"
          placeholder={labels.search}
          aria-label={labels.search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {shown.length === 0 ? (
        <p className="muted orders-empty">{labels.noMatch}</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table orders-table">
            {head}
            <tbody>
              {visible.map((item) => (
                <tr
                  key={item.id}
                  className={item.overdue ? "row-click is-overdue" : "row-click"}
                  onClick={(event) => openRow(event, item.href)}
                >
                  {item.row}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {shown.length > FIRST ? (
        <button type="button" className="btn btn-quiet orders-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? (
            labels.showFewer
          ) : (
            <>
              {labels.showAll} <span className="tab-count tab-count-neutral">{shown.length}</span>
            </>
          )}
        </button>
      ) : null}
    </>
  );
}
