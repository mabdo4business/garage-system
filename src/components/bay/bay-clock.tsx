"use client";

import { useEffect, useState } from "react";
import { t, type Locale } from "../../i18n";
import { formatDubaiTime } from "../../i18n/format";
import { formatClockDuration } from "./task-ring";

/**
 * The bay screen's clocks. Both render the server's value first (correct without JavaScript) and then tick in the
 * browser; the timer adds only the time since the page was rendered, so the worked total stays the one the server
 * computed from the job's status history (start, pause, resume).
 */

/** Dubai wall-clock time, HH:MM. */
export function BayClock({ locale, initial }: { locale: Locale; initial: string }) {
  const [text, setText] = useState(initial);
  useEffect(() => {
    const update = () => setText(formatDubaiTime(new Date(), locale));
    update();
    const timer = setInterval(update, 15_000);
    return () => clearInterval(timer);
  }, [locale]);
  return (
    <time className="bay-clock" aria-label={t(locale, "bay.clock")}>
      <bdi dir="ltr">{text}</bdi>
    </time>
  );
}

/** Time worked on the job; counts up only while the job is in progress. */
export function BayTimer({ seconds, running }: { seconds: number; running: boolean }) {
  const [extra, setExtra] = useState(0);
  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    const timer = setInterval(() => setExtra(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return (
    <span className="bay-elapsed" role="timer">
      <bdi dir="ltr">{formatClockDuration(seconds + extra)}</bdi>
    </span>
  );
}
