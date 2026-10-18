import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { CATALOGS } from "@/i18n/catalogs";
import { LOCALES } from "@/i18n/config";

// The localized Link needs the Next router; a plain anchor is enough for markup checks.
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: unknown }) =>
    createElement("a", { href }, children as never),
}));
let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

const { default: LocaleError } = await import("@/app/[locale]/error");
const { default: GlobalError } = await import("@/app/global-error");

// Children are passed as the third createElement argument (typed loosely for that call).
const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
  locale: string;
  messages: unknown;
  children?: ReactNode;
}>;

const secret = "connect ECONNREFUSED postgres://user:pass@db.internal/app at query(stack.js:1)";

function localeError(locale: (typeof LOCALES)[number], digest?: string) {
  const error = Object.assign(new Error(secret), digest ? { digest } : {});
  return renderToStaticMarkup(
    createElement(
      Provider,
      { locale, messages: CATALOGS[locale] },
      createElement(LocaleError, { error, reset: () => {} }),
    ),
  );
}

describe("localized error boundary", () => {
  it.each(LOCALES)("%s: title, retry, home link and digest; never the error message", (locale) => {
    const html = localeError(locale, "1234567890");
    const t = CATALOGS[locale].errorPage;
    expect(html).toContain(t.title);
    expect(html).toContain(t.retry);
    expect(html).toContain(t.home);
    expect(html).toContain("1234567890");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("ECONNREFUSED");
    expect(html).not.toContain("postgres://");
    expect(html).not.toContain("stack.js");
  });

  it("omits the digest line when there is none", () => {
    expect(localeError("en")).not.toContain('data-testid="error-digest"');
  });
});

describe("global error boundary (root layout failed)", () => {
  it("uses the locale of the path, shows the digest and never the message", () => {
    pathname = "/lv/companies/x/documents";
    const error = Object.assign(new Error(secret), { digest: "987" });
    const html = renderToStaticMarkup(createElement(GlobalError, { error, reset: () => {} }));
    expect(html).toContain('<html lang="lv"');
    expect(html).toContain("Radās kļūda");
    expect(html).toContain("987");
    expect(html).not.toContain("ECONNREFUSED");
    expect(html).not.toContain("postgres://");
  });
});
