"use client";

import { clsx } from "clsx";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { NAV_ITEMS } from "./nav-items";

export function NavIcon({ d }: { d: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

export function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations("nav");
  const pathname = usePathname();

  return (
    <ul className="space-y-1">
      {NAV_ITEMS.map((item) => {
        const active = !item.soon && pathname === item.href;
        const base = "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors";
        if (item.soon) {
          return (
            <li key={item.key}>
              <span aria-disabled="true" className={clsx(base, "cursor-not-allowed text-muted/60")}>
                <NavIcon d={item.icon} />
                <span className="flex-1">{t(item.key)}</span>
                <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] tracking-wide text-muted uppercase">
                  {t("soon")}
                </span>
              </span>
            </li>
          );
        }
        return (
          <li key={item.key}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={clsx(
                base,
                active
                  ? "bg-accent-soft font-medium text-violet-100"
                  : "text-muted hover:bg-surface-2 hover:text-text",
              )}
            >
              <NavIcon d={item.icon} />
              <span className="flex-1">{t(item.key)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
