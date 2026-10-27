"use client";

import { useActionState, useState, type ReactNode } from "react";
import { TaskRing } from "../../../../../components/bay/task-ring";
import { t, type Locale } from "../../../../../i18n";
import { FormErrorMessage } from "../../../form-error";
import { EMPTY_FORM_STATE, type FormState } from "../../../form-state";

/**
 * The bay screen's "work in progress" part (UI-R3, docs/design/Bay.dc.html): tick each authorized item done, or mark
 * it not performed with a reason (OD-31, T-29). Ticks stay in this form until Done (OD-50), which submits them all
 * with the completion note to the same completeJob command as before. Done stays locked, saying what is missing,
 * until every item has an outcome; the command checks it all again on the server.
 */

export interface BayLine {
  id: string;
  label: string;
  /** Quantity and unit, and parts received for part lines — never a price (AC2-30). */
  detail: string;
}

type Outcome = "done" | "not_performed";

export function BayWork({
  locale,
  action,
  hidden,
  lines,
  car,
  timer,
  actions,
}: {
  locale: Locale;
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  hidden: Record<string, string>;
  lines: BayLine[];
  /** Server-rendered plate, status and car, shown beside the ring. */
  car: ReactNode;
  timer: ReactNode;
  /** Server-rendered actions beside Done (pause with reason). */
  actions: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome | undefined>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const formId = `bay-complete-${hidden.jobId}`;

  const settled = lines.filter((line) => outcomes[line.id] !== undefined).length;
  const left = lines.length - settled;
  const reasonMissing = lines.some(
    (line) => outcomes[line.id] === "not_performed" && !reasons[line.id]?.trim(),
  );
  const locked =
    left > 0
      ? t(locale, "bay.doneLocked", { n: String(left) })
      : reasonMissing
        ? t(locale, "bay.doneNeedsReason")
        : !note.trim()
          ? t(locale, "bay.doneNeedsNote")
          : null;

  const toggle = (lineId: string, outcome: Outcome) =>
    setOutcomes((current) => ({ ...current, [lineId]: current[lineId] === outcome ? undefined : outcome }));

  return (
    <>
      <div className="bay-head">
        {car}
        <TaskRing locale={locale} done={settled} total={lines.length} />
      </div>
      {timer}
      <form id={formId} action={formAction} className="bay-form">
        <input type="hidden" name="locale" value={locale} />
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <FormErrorMessage locale={locale} error={state.error} />
        <ul className="bay-tasks">
          {lines.map((line) => {
            const outcome = outcomes[line.id];
            return (
              <li key={line.id} className="bay-task" data-outcome={outcome ?? "open"}>
                <div className="bay-task-row">
                  <button
                    type="button"
                    className="bay-tick"
                    aria-pressed={outcome === "done"}
                    onClick={() => toggle(line.id, "done")}
                  >
                    <TaskBox outcome={outcome} />
                    <span className="bay-task-text">
                      <span dir="auto">{line.label}</span>
                      <span className="bay-task-detail">{line.detail}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="bay-skip"
                    aria-pressed={outcome === "not_performed"}
                    onClick={() => toggle(line.id, "not_performed")}
                  >
                    {t(locale, "job.line.notPerformed")}
                  </button>
                </div>
                {outcome ? <input type="hidden" name={`outcome.${line.id}`} value={outcome} /> : null}
                {outcome === "not_performed" ? (
                  <div className="field bay-reason">
                    <label htmlFor={`reason-${line.id}`}>{t(locale, "job.line.reason")}</label>
                    <input
                      id={`reason-${line.id}`}
                      name={`reason.${line.id}`}
                      required
                      maxLength={500}
                      dir="auto"
                      value={reasons[line.id] ?? ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        setReasons((current) => ({ ...current, [line.id]: value }));
                      }}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className="field">
          <label htmlFor="note">{t(locale, "job.note")}</label>
          <textarea
            id="note"
            name="note"
            maxLength={500}
            required
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </form>
      <div className="bay-actions">
        {actions}
        {locked ? (
          <button type="button" className="bay-done" disabled>
            {locked}
          </button>
        ) : (
          <button type="submit" form={formId} className="bay-done ready" disabled={pending}>
            {t(locale, "job.complete")}
          </button>
        )}
      </div>
    </>
  );
}

/** The tick box: empty, a drawn checkmark (done) or a cross (not performed). */
export function TaskBox({ outcome }: { outcome: Outcome | null | undefined }) {
  return (
    <span className={`bay-box${outcome ? ` bay-box-${outcome}` : ""}`} aria-hidden="true">
      {outcome === "done" ? (
        <svg viewBox="0 0 24 24">
          <path className="tickpath" d="M20 6L9 17l-5-5" pathLength={24} />
        </svg>
      ) : outcome === "not_performed" ? (
        <svg viewBox="0 0 24 24">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      ) : null}
    </span>
  );
}
