"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A figure that counts up to its real value once, on first display. The server renders the final
 * text (no hydration mismatch, correct without JavaScript); the animation only replaces the text
 * for under a second and ends on exactly `text`. Skipped with prefers-reduced-motion. `format`
 * receives intermediate numbers only for display; the value shown at rest is always `text`.
 */
export function AnimatedNumber({
  value,
  text,
  format,
  className,
}: {
  value: number;
  text: string;
  format: Intl.NumberFormatOptions & { locale: string };
  className?: string;
}) {
  const [shown, setShown] = useState(text);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!Number.isFinite(value) || value === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const { locale, ...opts } = format;
    const nf = new Intl.NumberFormat(locale, opts);
    const start = performance.now();
    const duration = 800;
    let frame = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - p) ** 3;
      if (p >= 1) {
        setShown(text);
        return;
      }
      setShown(nf.format(value * eased));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      setShown(text);
    };
  }, [value, text, format]);
  return (
    <span className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">{shown}</span>
    </span>
  );
}
