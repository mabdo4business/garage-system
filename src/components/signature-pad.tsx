"use client";

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/**
 * A finger-drawn signature on a canvas (in-person approval OD-20, contact change in person OD-64). The hook keeps the
 * drawing state; the page renders the canvas with `canvasProps` and the class `signature-pad`.
 *
 * The canvas may appear after the form (the contact change shows it only once "In person" is chosen), so it is sized
 * whenever it attaches, and a canvas that comes or goes always starts unsigned — a blank one must never pass for a
 * signature.
 */
export function useSignaturePad() {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const [signed, setSigned] = useState(false);

  // Size the drawing surface to its box (and the screen's pixel density) as soon as it is in the page.
  const ref = useCallback((element: HTMLCanvasElement | null) => {
    canvas.current = element;
    drawing.current = false;
    setSigned(false);
    if (!element) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = Math.round(element.clientWidth * ratio);
    element.height = Math.round(element.clientHeight * ratio);
    const context = element.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.lineWidth = 2.5;
    context.lineCap = "round";
    context.strokeStyle = "#111";
  }, []);

  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const start = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const { x, y } = point(event);
    context.beginPath();
    context.moveTo(x, y);
  };
  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    const { x, y } = point(event);
    context.lineTo(x, y);
    context.stroke();
    setSigned(true);
  };
  const stop = () => {
    drawing.current = false;
  };
  const clear = () => {
    const element = canvas.current;
    element?.getContext("2d")?.clearRect(0, 0, element.width, element.height);
    setSigned(false);
  };
  /** The signature as a PNG, or null when nothing was drawn on the canvas in the page now. */
  const toBlob = async (): Promise<Blob | null> =>
    signed && canvas.current
      ? new Promise<Blob | null>((resolve) => canvas.current!.toBlob(resolve, "image/png"))
      : null;

  return {
    signed,
    clear,
    toBlob,
    canvasProps: { ref, onPointerDown: start, onPointerMove: move, onPointerUp: stop, onPointerLeave: stop },
  };
}
