import { t, type Locale } from "../../i18n";

/** "1:05:09": hours, minutes, seconds of a duration (Western digits, T-02). */
export function formatClockDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(whole / 3600)}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}`;
}

/**
 * The task ring of the bay screen (docs/design/Bay.dc.html): items with an outcome out of all authorized items.
 * The arc length uses pathLength 100, so the stroke is a plain percentage; it animates with a CSS transition.
 */
export function TaskRing({ locale, done, total }: { locale: Locale; done: number; total: number }) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div
      className="bay-ring"
      role="img"
      aria-label={t(locale, "bay.ring", { done: String(done), total: String(total) })}
    >
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="bay-ring-track" cx="50" cy="50" r="38" pathLength={100} />
        <circle
          className="bay-ring-fill"
          cx="50"
          cy="50"
          r="38"
          pathLength={100}
          // A round cap would still draw a dot at 0 %.
          strokeOpacity={percent === 0 ? 0 : 1}
          style={{ strokeDasharray: `${percent} 100` }}
        />
      </svg>
      <span className="bay-ring-text" aria-hidden="true">
        <strong>
          <bdi dir="ltr">
            {done}/{total}
          </bdi>
        </strong>
        <span>{t(locale, "bay.tasks")}</span>
      </span>
    </div>
  );
}
