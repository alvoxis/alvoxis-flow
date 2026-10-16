import { clsx } from "clsx";
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useId } from "react";

export function Field({
  label,
  hint,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-text">
        {label}
      </label>
      <input
        id={id}
        {...input}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={clsx(
          "w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text placeholder:text-muted/60",
          "focus:border-accent focus:outline-none",
          input.className,
        )}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  return (
    <button
      {...props}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        variant === "primary" && "bg-accent-strong text-white hover:bg-accent",
        variant === "secondary" &&
          "border border-border bg-surface-2 text-text hover:border-accent/60",
        variant === "danger" &&
          "border border-red-800/60 bg-red-950/40 text-danger hover:bg-red-950/70",
        variant === "ghost" && "text-violet-300 hover:text-violet-200",
        className,
      )}
    />
  );
}

export function Alert({
  tone = "info",
  children,
}: {
  tone?: "info" | "success" | "warning" | "error";
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={clsx(
        "rounded-lg border px-3 py-2.5 text-sm",
        tone === "info" && "border-accent/40 bg-accent-soft/60 text-violet-100",
        tone === "success" && "border-emerald-800/60 bg-emerald-950/40 text-emerald-200",
        tone === "warning" && "border-amber-800/60 bg-amber-950/40 text-amber-100",
        tone === "error" && "border-red-800/60 bg-red-950/40 text-red-200",
      )}
    >
      {children}
    </div>
  );
}
