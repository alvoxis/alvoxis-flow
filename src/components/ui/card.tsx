import { clsx } from "clsx";
import { type ReactNode } from "react";

export function Card({
  className,
  children,
  padded = true,
}: {
  className?: string;
  children: ReactNode;
  /** Set to false for edge-to-edge content such as tables. */
  padded?: boolean;
}) {
  return (
    <section
      className={clsx(
        "overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset]",
        padded && "p-5",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-start justify-between gap-2">
      <div>
        <h2 className="text-base font-semibold text-text">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
      </div>
      {action}
    </header>
  );
}
