import type { CSSProperties } from "react";
import type { StatusTone } from "../ui";

/**
 * Small charts for the dashboard, drawn on the server as SVG/HTML. Animations are CSS only (components.css:
 * grow, fill) and stop under prefers-reduced-motion. Every chart carries its numbers as text too
 * (labels, legend or an accessible title), so nothing is read from colour alone.
 */

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
