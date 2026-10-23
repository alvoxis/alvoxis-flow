"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";

const WORD = "ALVOXIS";
/** When the card has fully appeared (globals.css: 3.9 s delay + 0.8 s). */
const INTRO_MS = 4700;

/**
 * Sign-in intro: an interactive particle field behind the page and the ALVOXIS word in 3D. The
 * word flies in slowly from far away, turning, and lands above the card; then the card fades in.
 * The particles stand still until the word has landed, so nothing competes with its flight. A
 * click, tap or key press skips straight to the form. With reduced motion the final state shows at once. Purely
 * decorative: the form is in the page from the start, so nothing waits for the animation.
 */
export function SignInIntro({ children }: { children: ReactNode }) {
  const t = useTranslations("auth.intro");
  const tiltRef = useRef<HTMLDivElement>(null);
  const [skipped, setSkipped] = useState(false);
  // The skip button goes away once there is nothing left to skip.
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setFinished(true), INTRO_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // Any key or pointer press ends the intro; the pointer also tilts the word. The tilt is written
  // straight to the one element's transform, at most once per frame, so moving the pointer never
  // restyles the rest of the page.
  useEffect(() => {
    const el = tiltRef.current;
    if (!el) return;
    const skip = () => setSkipped(true);
    let pending = 0;
    let x = 0;
    let y = 0;
    const tilt = (e: PointerEvent) => {
      x = e.clientX / window.innerWidth - 0.5;
      y = e.clientY / window.innerHeight - 0.5;
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        el.style.transform = `rotateX(${(-y * 16).toFixed(2)}deg) rotateY(${(x * 22).toFixed(2)}deg)`;
      });
    };
    window.addEventListener("keydown", skip, { once: true });
    window.addEventListener("pointerdown", skip, { once: true });
    window.addEventListener("pointermove", tilt, { passive: true });
    return () => {
      window.removeEventListener("keydown", skip);
      window.removeEventListener("pointerdown", skip);
      window.removeEventListener("pointermove", tilt);
      cancelAnimationFrame(pending);
    };
  }, []);

  return (
    <div
      className={`sign-in-intro relative flex w-full flex-col items-center ${skipped ? "intro-skipped" : ""}`}
      data-testid="sign-in-intro"
    >
      <ParticleField still={!skipped && !finished} />
      <div
        className="intro-logo-wrap pointer-events-none relative z-10 mb-6 flex justify-center select-none"
        aria-hidden="true"
      >
        <div ref={tiltRef} className="intro-tilt">
          <div className="intro-glow" />
          <div className="intro-logo">{WORD}</div>
          <p className="intro-tagline">Flow</p>
        </div>
      </div>
      <div className="intro-card relative z-10 flex w-full justify-center">{children}</div>
      {!skipped && !finished ? (
        <button
          type="button"
          className="intro-skip fixed right-4 bottom-4 z-20 rounded-lg px-3 py-2 text-xs text-muted hover:text-text"
          onClick={() => setSkipped(true)}
        >
          {t("skip")}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Drifting points joined by faint lines when close; they lean towards the pointer. While `still`
 * (and with reduced motion) only one frame is drawn. A capped point count and a canvas at CSS pixel
 * size keep phones light; drawing stops while the tab is hidden, and the field is rebuilt only when
 * the width changes (a phone's address bar showing or hiding only changes the height).
 */
const LINK = 120;
const LINE_BANDS = 4;

function ParticleField({ still }: { still: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runRef = useRef<(run: boolean) => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let frame = 0;
    const pointer = { x: -9999, y: -9999 };
    type P = { x: number; y: number; vx: number; vy: number };
    let points: P[] = [];

    const resize = () => {
      if (width === window.innerWidth) return;
      width = window.innerWidth;
      height = Math.max(window.innerHeight, window.screen.height);
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const count = Math.round(Math.min(60, (width * height) / 22000));
      points = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
      }));
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      for (const p of points) {
        const dx = pointer.x - p.x;
        const dy = pointer.y - p.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 160 * 160) {
          p.vx += dx * 0.00004;
          p.vy += dy * 0.00004;
        }
        p.vx *= 0.995;
        p.vy *= 0.995;
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > width) p.vx *= -1;
        if (p.y < 0 || p.y > height) p.vy *= -1;
      }
      // Lines go into a few paths by strength and dots into one, so a frame is a handful of draw
      // calls instead of one per line.
      const paths = Array.from({ length: LINE_BANDS }, () => new Path2D());
      const dots = new Path2D();
      for (let i = 0; i < points.length; i++) {
        const a = points[i]!;
        for (let j = i + 1; j < points.length; j++) {
          const b = points[j]!;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < LINK * LINK) {
            const band = Math.min(LINE_BANDS - 1, Math.floor((Math.sqrt(d2) / LINK) * LINE_BANDS));
            paths[band]!.moveTo(a.x, a.y);
            paths[band]!.lineTo(b.x, b.y);
          }
        }
        dots.moveTo(a.x + 1.6, a.y);
        dots.arc(a.x, a.y, 1.6, 0, Math.PI * 2);
      }
      ctx.lineWidth = 1;
      paths.forEach((path, band) => {
        ctx.strokeStyle = `rgba(139, 92, 246, ${((1 - (band + 0.5) / LINE_BANDS) * 0.35).toFixed(3)})`;
        ctx.stroke(path);
      });
      ctx.fillStyle = "rgba(196, 181, 253, 0.8)";
      ctx.fill(dots);
    };

    let running = false;
    const loop = () => {
      draw();
      frame = requestAnimationFrame(loop);
    };
    runRef.current = (run) => {
      running = run && !reduced;
      cancelAnimationFrame(frame);
      if (running && !document.hidden) frame = requestAnimationFrame(loop);
    };
    const onMove = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
    };
    const onVisibility = () => {
      cancelAnimationFrame(frame);
      if (!document.hidden && running) frame = requestAnimationFrame(loop);
    };

    resize();
    draw();
    const onResize = () => {
      resize();
      if (!running) draw();
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", onVisibility);
      runRef.current = () => {};
    };
  }, []);

  useEffect(() => runRef.current(!still), [still]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed top-0 left-0 z-0"
      aria-hidden="true"
    />
  );
}
