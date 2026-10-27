"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

/**
 * The board's interactive part (UI-R5): filters (search, technician, overdue only — remembered in this browser),
 * the six columns, and a side panel per card. Cards and panels arrive rendered by the server with the viewer's
 * permissions; this only chooses which to show and opens the panel. The panel is a native <dialog>: Esc closes it,
 * focus stays inside while it is open and returns to the card afterwards.
 */

export interface BoardItem {
  id: string;
  column: string;
  /** Lower-case text the search box looks in (number, plate, car, jobs, technicians, status words). */
  haystack: string;
  technicians: string[];
  unassigned: boolean;
  overdue: boolean;
  /** Accessible name of the card's panel (car and order number). */
  title: string;
  card: ReactNode;
  panel: ReactNode;
}

export interface BoardColumnSpec {
  key: string;
  label: string;
  tone: string;
}

interface Labels {
  group: string;
  search: string;
  technician: string;
  allTechnicians: string;
  unassigned: string;
  overdue: string;
  clear: string;
  showing: string;
  empty: string;
  noMatch: string;
  details: string;
  close: string;
}

interface Filters {
  query: string;
  technician: string;
  overdueOnly: boolean;
}

const NONE: Filters = { query: "", technician: "", overdueOnly: false };
/** Filter value meaning "jobs nobody is assigned to" (printable: it round-trips through HTML and storage). */
export const UNASSIGNED = "__unassigned__";

function readStored(key: string): Filters {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null") as Partial<Filters> | null;
    if (!parsed) return NONE;
    return {
      query: typeof parsed.query === "string" ? parsed.query : "",
      technician: typeof parsed.technician === "string" ? parsed.technician : "",
      overdueOnly: parsed.overdueOnly === true,
    };
  } catch {
    return NONE;
  }
}

function BoardCard({ item, labels }: { item: BoardItem; labels: Labels }) {
  const panel = useRef<HTMLDialogElement>(null);
  const details = useRef<HTMLButtonElement>(null);
  const open = () => panel.current?.showModal();
  const onCard = (event: MouseEvent<HTMLElement>) => {
    // Links, buttons and forms on the card do their own thing; the panel's contents never reopen it.
    if ((event.target as HTMLElement).closest("a, button, input, select, textarea, summary, label, dialog"))
      return;
    if (window.getSelection()?.toString()) return;
    open();
  };
  return (
    <article className="board-card" data-card={item.id} onClick={onCard}>
      {item.card}
      <button
        ref={details}
        type="button"
        className="board-card-details"
        onClick={open}
        aria-haspopup="dialog"
      >
        {labels.details}
        <span className="visually-hidden"> {item.title}</span>
      </button>
      <dialog
        ref={panel}
        className="board-panel"
        aria-label={item.title}
        // Back to this card, whether the panel was opened by the card or by its Details button.
        onClose={() => details.current?.focus()}
        onClick={(event) => {
          // A click on the backdrop (outside the sheet) closes it.
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <div className="board-panel-inner">
          <button type="button" className="board-panel-close" onClick={() => panel.current?.close()}>
            <span aria-hidden="true">×</span>
            <span className="visually-hidden">{labels.close}</span>
          </button>
          {item.panel}
        </div>
      </dialog>
    </article>
  );
}

export function BoardColumns({
  columns,
  items,
  technicians,
  labels,
  storageKey,
}: {
  columns: BoardColumnSpec[];
  items: BoardItem[];
  technicians: string[];
  labels: Labels;
  /** Per signed-in user, so a shared tablet does not hand one person's filters to the next. */
  storageKey: string;
}) {
  const [filters, setFilters] = useState<Filters>(NONE);

  // Filters are per person on this browser: restored after the first render (the server never sees them).
  useEffect(() => {
    const stored = readStored(storageKey);
    // A technician no longer on the board would hide every card behind a select that cannot show it.
    if (stored.technician && stored.technician !== UNASSIGNED && !technicians.includes(stored.technician)) {
      stored.technician = "";
    }
    setFilters(stored);
    // Only on arrival: later changes to the board must not reset what the person chose.
  }, []);

  /** Applies and saves at once (not in an effect), so a reload right after a change keeps it. */
  const apply = (next: Filters) => {
    setFilters(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Private mode or blocked storage: the filters still work, they are just not remembered.
    }
  };

  const shown = useMemo(() => {
    const words = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter(
      (item) =>
        words.every((word) => item.haystack.includes(word)) &&
        (!filters.overdueOnly || item.overdue) &&
        (!filters.technician ||
          (filters.technician === UNASSIGNED
            ? item.unassigned
            : item.technicians.includes(filters.technician))),
    );
  }, [items, filters]);
  const filtering = filters.query.trim() !== "" || filters.technician !== "" || filters.overdueOnly;
  const set = (change: Partial<Filters>) => apply({ ...filters, ...change });

  return (
    <>
      <div className="board-filters" role="group" aria-label={labels.group}>
        <input
          type="search"
          className="board-search"
          placeholder={labels.search}
          aria-label={labels.search}
          value={filters.query}
          onChange={(event) => set({ query: event.target.value })}
        />
        <select
          className="board-tech"
          aria-label={labels.technician}
          value={filters.technician}
          onChange={(event) => set({ technician: event.target.value })}
        >
          <option value="">{labels.allTechnicians}</option>
          <option value={UNASSIGNED}>{labels.unassigned}</option>
          {technicians.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <label className="board-toggle">
          <input
            type="checkbox"
            checked={filters.overdueOnly}
            onChange={(event) => set({ overdueOnly: event.target.checked })}
          />
          <span>{labels.overdue}</span>
        </label>
        {/* Always present (empty when not filtering) so screen readers announce changes to it. */}
        <span className="board-showing" role="status">
          {filtering ? (
            <>
              {labels.showing}{" "}
              <bdi dir="ltr">
                {shown.length} / {items.length}
              </bdi>
            </>
          ) : null}
        </span>
        {filtering ? (
          <button type="button" className="btn btn-quiet board-clear" onClick={() => apply(NONE)}>
            {labels.clear}
          </button>
        ) : null}
      </div>

      <div className="board-scroll">
        <div className="board">
          {columns.map((column) => {
            const cards = shown.filter((item) => item.column === column.key);
            return (
              <section key={column.key} className="board-column" aria-labelledby={`col-${column.key}`}>
                <h2 id={`col-${column.key}`}>
                  <span
                    className="dot"
                    style={{ background: `var(--status-${column.tone}-solid)` }}
                    aria-hidden="true"
                  />
                  <span className="column-name">{column.label}</span>
                  <span className={`column-count chip-status-${column.tone}`}>
                    <bdi dir="ltr">{cards.length}</bdi>
                  </span>
                </h2>
                <div className="board-column-body">
                  {cards.length === 0 ? (
                    <p className="board-empty">{filtering ? labels.noMatch : labels.empty}</p>
                  ) : (
                    cards.map((item) => <BoardCard key={item.id} item={item} labels={labels} />)
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}
