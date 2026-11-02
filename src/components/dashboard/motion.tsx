"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { t, type Locale } from "../../i18n";
import { formatAed } from "../../i18n/format";
import { Money } from "../../server/core/money";

/**
 * The dashboard's moving parts (redesign references, OD-49). Each renders its final value on the server, so without
 * JavaScript, or with prefers-reduced-motion, the real figure shows at once; the animation only replays it.
 */

const DURATION_MS = 1500;
const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Progress 0 → 1 (eased) over DURATION_MS after mount; 1 straight away with reduced motion. */
function useProgress(): number {
  const [progress, setProgress] = useState(1);
  useEffect(() => {
    if (reducedMotion()) return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / DURATION_MS);
      setProgress(easeOutCubic(p));
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return progress;
}

/** A whole number counting up from 0. Screen readers get the final value only. */
export function CountUp({ value }: { value: number }) {
  const progress = useProgress();
  return (
    <>
      <span aria-hidden="true">{Math.round(value * progress)}</span>
      <span className="visually-hidden">{value}</span>
    </>
  );
}

/**
 * An AED amount counting up from 0. The amount stays exact: each frame is a whole number of fils (bigint), never a
 * floating-point amount (rule 5).
 */
export function CountUpMoney({ amount, locale }: { amount: string; locale: Locale }) {
  const progress = useProgress();
  const fils = Money.parse(amount).fils;
  const shown = Money.fromFils((fils * BigInt(Math.round(progress * 1000))) / 1000n);
  return (
    <>
      <bdi dir="ltr" aria-hidden="true">
        {formatAed(shown, locale)}
      </bdi>
      <span className="visually-hidden">{formatAed(Money.parse(amount), locale)}</span>
    </>
  );
}

/**
 * "Live": re-reads the page from the server every minute while the tab is visible (and on return to it), so the
 * figures follow the workshop without a manual reload.
 */
export function LiveRefresh({ locale, renderedAt }: { locale: Locale; renderedAt: string }) {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);
  return (
    <span className="live-badge">
      <span className="live-dot" aria-hidden="true" />
      {t(locale, "dashboard.live", { time: renderedAt })}
    </span>
  );
}
