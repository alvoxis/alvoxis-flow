import { clsx } from "clsx";
import { type ReactNode } from "react";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-surface-2 text-muted ring-border",
  accent: "bg-accent-soft text-violet-200 ring-accent/40",
  success: "bg-emerald-950/60 text-success ring-emerald-800/60",
  warning: "bg-amber-950/60 text-warning ring-amber-800/60",
  danger: "bg-red-950/60 text-danger ring-red-800/60",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}
