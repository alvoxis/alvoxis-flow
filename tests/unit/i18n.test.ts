import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/i18n/config";

type Tree = { [k: string]: string | Tree };

function load(locale: string): Tree {
  return JSON.parse(readFileSync(path.resolve("messages", `${locale}.json`), "utf8")) as Tree;
}

function flatten(tree: Tree, prefix = ""): Record<string, string> {
  return Object.entries(tree).reduce<Record<string, string>>((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === "string" ? { ...acc, [key]: v } : { ...acc, ...flatten(v, key) };
  }, {});
}

/** ICU placeholders like {count} or {number}, ignoring plural branch bodies. */
function placeholders(message: string): string[] {
  return [...message.matchAll(/\{\s*([a-zA-Z_]+)\s*[,}]/g)].map((m) => m[1]!).sort();
}

const source = flatten(load("en"));

describe("message catalogs", () => {
  it.each(LOCALES)("%s has exactly the same keys as en", (locale) => {
    const keys = Object.keys(flatten(load(locale))).sort();
    expect(keys).toEqual(Object.keys(source).sort());
  });

  it.each(LOCALES)("%s has no empty messages", (locale) => {
    const empty = Object.entries(flatten(load(locale))).filter(([, v]) => v.trim() === "");
    expect(empty).toEqual([]);
  });

  it.each(LOCALES.filter((l) => l !== "en"))("%s uses the same ICU arguments as en", (locale) => {
    const target = flatten(load(locale));
    for (const [key, msg] of Object.entries(source)) {
      expect([...new Set(placeholders(target[key]!))], key).toEqual([
        ...new Set(placeholders(msg)),
      ]);
    }
  });

  it.each(LOCALES.filter((l) => l !== "en"))(
    "%s is actually translated (not copied from en)",
    (locale) => {
      const target = flatten(load(locale));
      // Brand names and identical technical terms are allowed to match.
      const allowed = new Set([
        "metadata.title",
        // Identical internationally used terms and pure placeholders.
        "documentPdf.iban",
        "documentPdf.bic",
        "bankAccounts.colIban",
        "bankAccounts.colBic",
        "bankAccounts.fields.iban",
        "bankAccounts.fields.bic",
        "documentPdf.lineNo",
        "documentPdf.taxKind.standard",
        // The subscription's name is the product name, the same in every language.
        "billing.planName",
        // Month names that are spelled the same in some languages (e.g. Estonian).
        ...Array.from({ length: 12 }, (_, i) => `analytics.month.${i + 1}`),
      ]);
      const copied = Object.keys(source).filter((k) => !allowed.has(k) && target[k] === source[k]);
      expect(copied).toEqual([]);
    },
  );
});
