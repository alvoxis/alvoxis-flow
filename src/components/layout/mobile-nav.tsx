"use client";

import { Dialog } from "@base-ui/react/dialog";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { usePathname } from "@/i18n/navigation";
import { Brand } from "./brand";
import { NavList } from "./nav-list";

/** The breakpoint from which the sidebar is shown and the drawer is not needed (Tailwind `lg`). */
const DESKTOP_QUERY = "(min-width: 1024px)";

/**
 * The main navigation below the `lg` breakpoint: a modal drawer on Base UI's Dialog. It is portalled
 * to <body>, so no ancestor of the trigger (the sticky, blurred top bar is a containing block for
 * fixed elements) can clip it or stack above it. Base UI provides the modal behaviour: focus moves
 * into the drawer and is trapped, Esc and a click on the backdrop close it, page scroll is locked
 * and restored, the rest of the page is inert, and focus returns to the menu button. It also closes
 * after navigating and when the window grows to the desktop layout (rotation, resizing).
 */
export function MobileNav() {
  const t = useTranslations("nav");
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // A page change (a link in the drawer, browser back/forward) closes the drawer.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const desktop = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => desktop.matches && setOpen(false);
    onChange();
    desktop.addEventListener("change", onChange);
    return () => desktop.removeEventListener("change", onChange);
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        aria-label={t("openMenu")}
        data-testid="mobile-nav-open"
        className="inline-flex size-11 items-center justify-center rounded-lg border border-border text-muted hover:text-text lg:hidden"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
        >
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop
          data-testid="mobile-nav-backdrop"
          className="absolute inset-0 z-50 bg-black/60 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 lg:hidden"
        />
        <Dialog.Popup
          id="mobile-nav"
          aria-label={t("main")}
          data-testid="mobile-nav"
          className="fixed inset-y-0 left-0 z-50 flex h-dvh w-80 max-w-[85vw] flex-col border-r border-border bg-surface pt-[max(1rem,env(safe-area-inset-top))] pr-4 pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] text-text shadow-2xl shadow-black/60 transition-transform duration-200 outline-none data-ending-style:-translate-x-full data-starting-style:-translate-x-full lg:hidden"
        >
          <div className="mb-6 flex shrink-0 items-center justify-between gap-3">
            <Brand />
            <Dialog.Close
              aria-label={t("closeMenu")}
              data-testid="mobile-nav-close"
              className="inline-flex size-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="size-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
              >
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </Dialog.Close>
          </div>
          {/* A long list (short landscape screens, large text) scrolls inside the drawer only. */}
          <nav aria-label={t("main")} className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
            <NavList onNavigate={() => setOpen(false)} />
          </nav>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
