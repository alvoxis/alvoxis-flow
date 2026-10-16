import { type ReactNode } from "react";
import { Brand } from "@/components/layout/brand";
import { LocaleSwitcher } from "@/components/layout/locale-switcher";

export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-4 py-4 sm:px-6">
        <Brand />
        <LocaleSwitcher />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-6 pb-12 sm:items-center sm:pt-0">
        <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-[0_0_80px_-40px_rgba(139,92,246,0.6)] sm:p-8">
          <h1 className="text-2xl font-semibold tracking-tight text-text">{title}</h1>
          {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
          <div className="mt-6 space-y-4">{children}</div>
        </div>
      </main>
    </div>
  );
}
