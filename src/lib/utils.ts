import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Joins class names (clsx) and resolves conflicting Tailwind utilities so that the last one wins
 * (tailwind-merge): `cn("px-4 text-muted", compact && "px-0")`. Used by the shared UI components
 * in src/components/ui, whose `className` prop is meant to override their defaults.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
