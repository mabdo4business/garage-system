"use client";

import { useEffect, useState } from "react";
import { boardChanges, parseSnapshot, type BoardSnapshot } from "./changes";

/**
 * Card pop and toast on the workshop board (UI-R2). Compares each card's status with what this browser last saw
 * (sessionStorage, a per-viewer convenience: without it nothing pops), pops the cards that moved or arrived, and
 * announces them in a toast. Messages are translated on the server. Pop is CSS and stops under reduced motion;
 * the toast still appears.
 */

const KEY = "workshop-board:statuses";
const TOAST_MS = 2800;

export interface BoardMotionCard {
  id: string;
  status: string;
  moved: string;
  added: string;
}

export function BoardMotion({ cards, more }: { cards: BoardMotionCard[]; more: string }) {
  const [messages, setMessages] = useState<string[]>([]);
  const snapshot: BoardSnapshot = Object.fromEntries(cards.map((card) => [card.id, card.status]));
  const signature = JSON.stringify(snapshot);

  useEffect(() => {
    let previous: BoardSnapshot | null = null;
    try {
      previous = parseSnapshot(window.sessionStorage.getItem(KEY));
      window.sessionStorage.setItem(KEY, signature);
    } catch {
      return; // storage blocked: the board still works, just without highlights
    }
    const current = JSON.parse(signature) as BoardSnapshot;
    const changes = boardChanges(previous, current);
    if (changes.length === 0) return;
    for (const change of changes) {
      const element = document.querySelector(`[data-card="${CSS.escape(change.id)}"]`);
      element?.classList.remove("pop");
      void (element as HTMLElement | null)?.offsetWidth; // restart the animation
      element?.classList.add("pop");
    }
    const text = changes.map((change) => {
      const card = cards.find((item) => item.id === change.id)!;
      return change.kind === "moved" ? card.moved : card.added;
    });
    setMessages(text.length > 3 ? [...text.slice(0, 2), more.replace("{n}", String(text.length - 2))] : text);
    // Re-run only when a status changes (the signature); the card texts follow it.
  }, [signature]);

  // Hide each toast after a while, whatever happens to the board meanwhile.
  useEffect(() => {
    if (messages.length === 0) return;
    const timer = setTimeout(() => setMessages([]), TOAST_MS);
    return () => clearTimeout(timer);
  }, [messages]);

  return (
    <div className="toast-region" role="status" aria-live="polite">
      {messages.map((message) => (
        <p key={message} className="toast">
          <span className="toast-tick" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          {message}
        </p>
      ))}
    </div>
  );
}
