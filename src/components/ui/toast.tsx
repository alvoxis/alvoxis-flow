"use client";

import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { useTranslations } from "next-intl";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Short, non-blocking notifications on Base UI's Toast (shadcn "base" pattern, our tokens).
 *
 *   toast.add({ title: t("saved"), type: "success" });
 *
 * Toasts are for confirmations that need no action. Errors and anything with a link or a decision
 * stay in an inline <Alert>, next to the form they belong to.
 *
 * Not mounted globally: render <Toaster /> in the layout or page of the routes that show toasts.
 * Next.js splits client code per route, so this module (and Base UI's toast code) is then loaded
 * only there, and the live region is present before the first toast is announced.
 */
export const toast = ToastPrimitive.createToastManager();

/** Renders the live region (role="region", polite) and the toasts; one per route tree. */
export function Toaster({ children }: { children?: ReactNode }) {
  const t = useTranslations("ui.toast");
  return (
    <ToastPrimitive.Provider toastManager={toast}>
      {children}
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport
          aria-label={t("region")}
          className="pointer-events-none fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 mx-auto max-w-sm outline-none sm:right-4 sm:left-auto sm:mx-0 sm:w-full"
        >
          <ToastList closeLabel={t("close")} />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}

function ToastList({ closeLabel }: { closeLabel: string }) {
  const { toasts } = ToastPrimitive.useToastManager();
  return toasts.map((item) => (
    <ToastPrimitive.Root
      key={item.id}
      toast={item}
      className={cn(
        "pointer-events-auto absolute right-0 bottom-0 z-[calc(1000-var(--toast-index))] w-full origin-bottom rounded-xl border bg-surface-2 text-text shadow-lg shadow-black/40 select-none",
        item.type === "success" && "border-emerald-800/60",
        item.type === "error" && "border-red-800/60",
        item.type !== "success" && item.type !== "error" && "border-border",
        // Stacking and swipe-to-dismiss, driven by Base UI's CSS variables.
        "[--gap:0.75rem] [--peek:0.75rem] [--scale:calc(max(0,1-(var(--toast-index)*0.1)))] [--shrink:calc(1-var(--scale))]",
        "h-(--height) [--height:var(--toast-frontmost-height,var(--toast-height))]",
        "[transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))]",
        "[transition:transform_400ms_cubic-bezier(0.22,1,0.36,1),opacity_400ms,height_150ms]",
        "data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--gap)*-1+var(--toast-swipe-movement-y)))]",
        "data-limited:opacity-0 data-starting-style:[transform:translateY(150%)]",
        "[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(150%)]",
        "data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
        "data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))]",
      )}
    >
      <ToastPrimitive.Content className="flex h-full items-start gap-3 overflow-hidden p-4 transition-opacity duration-200 data-behind:opacity-0 data-expanded:opacity-100">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <ToastPrimitive.Title className="text-sm font-medium" />
          <ToastPrimitive.Description className="text-sm text-muted" />
        </div>
        <ToastPrimitive.Close
          aria-label={closeLabel}
          className="-m-1 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:text-text"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
          >
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </ToastPrimitive.Close>
      </ToastPrimitive.Content>
    </ToastPrimitive.Root>
  ));
}
