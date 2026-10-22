export type NavKey =
  | "dashboard"
  | "documents"
  | "customers"
  | "suppliers"
  | "products"
  | "inventory"
  | "production"
  | "payroll"
  | "analytics"
  | "settings";

export interface NavItem {
  key: NavKey;
  href: string;
  icon: string;
  /** Module not implemented yet: rendered disabled with a "soon" badge. */
  soon: boolean;
  /** Other paths (without locale) that belong to this item, e.g. a company's documents. */
  alsoActiveOn?: RegExp;
}

/** SVG path data (24×24, stroke icons). */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    key: "dashboard",
    href: "/",
    soon: false,
    icon: "M3 13h8V3H3v10Zm10 8h8V11h-8v10ZM3 21h8v-6H3v6Zm10-18v6h8V3h-8Z",
  },
  {
    key: "documents",
    href: "/documents",
    soon: false,
    alsoActiveOn: /^\/companies\/[^/]+\/documents(\/|$)/,
    icon: "M7 3h7l5 5v13H7V3Zm7 0v5h5M9 13h8M9 17h6",
  },
  {
    key: "customers",
    href: "/customers",
    soon: false,
    alsoActiveOn: /^\/companies\/[^/]+\/customers(\/|$)/,
    icon: "M16 20v-2a4 4 0 0 0-8 0v2M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8 8v-2a4 4 0 0 0-3-3.87M4 20v-2a4 4 0 0 1 3-3.87",
  },
  {
    key: "suppliers",
    href: "/suppliers",
    soon: false,
    alsoActiveOn: /^\/companies\/[^/]+\/suppliers(\/|$)/,
    icon: "M3 7h11v10H3V7Zm11 3h4l3 3v4h-7v-7ZM7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  },
  {
    key: "products",
    href: "/products",
    soon: false,
    alsoActiveOn: /^\/companies\/[^/]+\/products(\/|$)/,
    icon: "M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8",
  },
  {
    key: "inventory",
    href: "/inventory",
    soon: true,
    icon: "M4 4h16v6H4V4Zm0 10h7v6H4v-6Zm9 0h7v6h-7v-6Z",
  },
  { key: "production", href: "/production", soon: true, icon: "M3 21V10l6 4V10l6 4V4h6v17H3Z" },
  {
    key: "payroll",
    href: "/payroll",
    soon: true,
    icon: "M3 6h18v12H3V6Zm9 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 9v.01M18 15v.01",
  },
  { key: "analytics", href: "/analytics", soon: true, icon: "M4 20V10m6 10V4m6 16v-7m4 7H2" },
  {
    key: "settings",
    href: "/settings",
    soon: true,
    icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z",
  },
];

/** Whether `item` is the current section for `pathname` (a path without the locale prefix). */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.soon) return false;
  return pathname === item.href || Boolean(item.alsoActiveOn?.test(pathname));
}
