import type { CSSProperties, ReactNode } from "react";
import type { StatusTone } from "../ui";

/**
 * Small charts for the dashboard, drawn on the server as SVG/HTML. Animations are CSS only (components.css:
 * draw, grow, fill, donut) and stop under prefers-reduced-motion. Every chart carries its numbers as text too
 * (labels, legend or an accessible title), so nothing is read from colour alone.
 */

/** A 7-point trend line. `label` names the series and lists its values for screen readers and on hover. */
export function Sparkline({ values, label, tone }: { values: number[]; label: string; tone: StatusTone }) {
  const width = 120;
  const height = 36;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? (width - 4) / (values.length - 1) : 0;
  const d = values
    .map(
      (value, i) =>
        `${i === 0 ? "M" : "L"}${(2 + i * step).toFixed(1)} ${(height - 4 - (value / max) * (height - 8)).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img">
      <title>{label}</title>
      <path
        className="draw"
        d={d}
        pathLength={1}
        fill="none"
        stroke={`var(--status-${tone}-solid)`}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface Bar {
  key: string;
  label: string;
  /** Short direct label shown above the bar. */
  value: string;
  /** The exact value: hover title and screen readers. */
  exact: string;
  /** Height as a share of the tallest bar, 0–1. */
  ratio: number;
  highlight?: boolean;
}

/** Vertical bars with a direct value label on each (single series: no legend; the heading names it). */
export function BarChart({ bars, label }: { bars: Bar[]; label: string }) {
  return (
    <figure className="bar-chart" aria-label={label}>
      <ol>
        {bars.map((bar, i) => (
          <li key={bar.key} title={`${bar.label}: ${bar.exact}`}>
            <span className="bar-value" aria-hidden="true">
              {bar.value}
            </span>
            <span className="visually-hidden">{`${bar.label}: ${bar.exact}`}</span>
            <span
              className={`bar grow${bar.highlight ? " highlight" : ""}`}
              style={
                {
                  "--h": `${Math.max(bar.ratio * 72, bar.ratio > 0 ? 2 : 0)}%`,
                  animationDelay: `${0.3 + 0.07 * i}s`,
                } as CSSProperties
              }
            />
            <span className="bar-label" aria-hidden="true">
              {bar.label}
            </span>
          </li>
        ))}
      </ol>
    </figure>
  );
}

export interface DonutSegment {
  key: string;
  label: string;
  count: number;
  tone: StatusTone;
}

/**
 * Parts of a whole by status, with a legend that names every status and its count (the legend is the table
 * view). Segments are separated by a small gap so neighbouring colours never touch.
 */
export function Donut({
  segments,
  label,
  center,
}: {
  segments: DonutSegment[];
  label: string;
  center: ReactNode;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  const gap = total > 0 && segments.filter((segment) => segment.count > 0).length > 1 ? 0.8 : 0;
  let start = 0;
  return (
    <div className="donut">
      <div className="donut-ring">
        <svg width="160" height="160" viewBox="0 0 140 140" role="img" aria-label={label}>
          <circle cx="70" cy="70" r="54" fill="none" stroke="var(--track)" strokeWidth="18" />
          {total > 0
            ? segments.map((segment) => {
                const share = (segment.count / total) * 100;
                const offset = start;
                start += share;
                if (segment.count === 0) return null;
                return (
                  <circle
                    key={segment.key}
                    className="donut-segment"
                    cx="70"
                    cy="70"
                    r="54"
                    fill="none"
                    pathLength={100}
                    stroke={`var(--status-${segment.tone}-solid)`}
                    strokeWidth="18"
                    strokeDasharray={`${Math.max(share - gap, 0.5).toFixed(2)} 100`}
                    strokeDashoffset={(-offset).toFixed(2)}
                    transform="rotate(-90 70 70)"
                  />
                );
              })
            : null}
        </svg>
        <div className="donut-center">{center}</div>
      </div>
      <ul className="donut-legend">
        {segments.map((segment) => (
          <li key={segment.key}>
            <span
              className="swatch"
              style={{ background: `var(--status-${segment.tone}-solid)` }}
              aria-hidden="true"
            />
            <span className="legend-label">{segment.label}</span>
            <span className="legend-count num">{segment.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A thin progress bar (share 0–1) in a status colour; the text beside it carries the meaning. */
export function ProgressBar({ share, tone, delay = 0 }: { share: number; tone: StatusTone; delay?: number }) {
  return (
    <span className="progress" aria-hidden="true">
      <span
        className="progress-fill fill-x"
        style={{
          inlineSize: `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%`,
          background: `var(--status-${tone}-solid)`,
          animationDelay: `${delay}s`,
        }}
      />
    </span>
  );
}
