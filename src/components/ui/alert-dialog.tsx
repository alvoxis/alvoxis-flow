"use client";

import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { type ComponentProps } from "react";
import { Button } from "@/components/ui/form";
import { cn } from "@/lib/utils";

/**
 * Confirmation dialog on Base UI's AlertDialog (shadcn "base" pattern, styled with our tokens).
 * Base UI provides the behaviour: modal, focus moves inside and is trapped, Esc closes, page scroll
 * is locked, the rest of the page is inert for assistive technology, and focus returns to the
 * trigger on close. Unlike a plain dialog, a click on the backdrop does not dismiss it.
 */
export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
export const AlertDialogTitle = AlertDialogPrimitive.Title;
export const AlertDialogDescription = AlertDialogPrimitive.Description;

export function AlertDialogContent({ className, ...props }: AlertDialogPrimitive.Popup.Props) {
  return (
    <AlertDialogPrimitive.Portal>
      {/* `absolute` (with body { position: relative }) also covers the area under the iOS 26
          Safari toolbars; the popup itself is fixed to the viewport. */}
      <AlertDialogPrimitive.Backdrop className="absolute inset-0 z-50 bg-black/60 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <AlertDialogPrimitive.Popup
        className={cn(
          "fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 space-y-3 rounded-2xl border border-border bg-surface p-5 text-text shadow-2xl shadow-black/50 outline-none",
          "transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
          className,
        )}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  );
}

/** Actions row: stacked on phones (primary action on top), side by side from `sm`. */
export function AlertDialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2 pt-1 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

/** Closes the dialog without doing anything; the safe default focus target. */
export function AlertDialogCancel({
  variant = "secondary",
  ...props
}: AlertDialogPrimitive.Close.Props & Pick<ComponentProps<typeof Button>, "variant">) {
  return <AlertDialogPrimitive.Close render={<Button variant={variant} />} {...props} />;
}
