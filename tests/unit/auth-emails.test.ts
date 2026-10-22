import { describe, expect, it } from "vitest";
import { LOCALES } from "@/i18n/config";
import { asLocale, type AuthEmailKind, authEmail } from "@/server/notifications/auth-emails";

/** Every security email renders in every language: subject, greeting, link, no raw keys. */
const KINDS: AuthEmailKind[] = [
  "verify",
  "reset",
  "existingAccount",
  "newSignIn",
  "passwordChanged",
  "twoFactorEnabled",
  "twoFactorDisabled",
  "signInLocked",
];
const LINK = "https://alvoxis-flow-git-main-team.vercel.app/lv/account/security";

describe("authEmail", () => {
  it.each(LOCALES)("renders every kind in %s", (locale) => {
    const subjects = new Set<string>();
    for (const kind of KINDS) {
      const m = authEmail(kind, "tester@example.test", locale, {
        name: "Test User",
        link: LINK,
        time: "2026-10-20 10:00",
        device: "Safari on iPhone",
      });
      expect(m).toMatchObject({ kind, to: "tester@example.test" });
      expect(m.subject.startsWith("ALVOXIS Flow: ")).toBe(true);
      subjects.add(m.subject);
      expect(m.text).toContain("Test User");
      // No unresolved placeholder or missing message key.
      expect(m.text).not.toMatch(/\{\w+\}|email\.\w+|undefined/);
      // Every kind except "2FA enabled" carries the link, exactly as given.
      if (kind !== "twoFactorEnabled") expect(m.text).toContain(LINK);
    }
    expect(subjects.size).toBe(KINDS.length);
  });

  it("falls back to English and to the address when the name is missing", () => {
    expect(asLocale("xx")).toBe("en");
    expect(asLocale(undefined)).toBe("en");
    const m = authEmail("verify", "tester@example.test", "en", { name: "  ", link: LINK });
    expect(m.text.startsWith("Hello tester@example.test,")).toBe(true);
  });
});
