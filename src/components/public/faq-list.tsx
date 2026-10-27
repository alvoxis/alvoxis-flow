import { getTranslations } from "next-intl/server";

export const FAQ_KEYS = [
  "what",
  "who",
  "price",
  "trial",
  "cancel",
  "data",
  "tax",
  "ai",
  "bank",
  "languages",
  "security",
  "export",
] as const;

/** Questions and answers as native disclosures (keyboard and screen-reader friendly, no JS). */
export async function FaqList({ limit }: { limit?: number }) {
  const t = await getTranslations("public.faq.items");
  return (
    <div className="divide-y divide-border rounded-2xl border border-border" data-testid="faq">
      {FAQ_KEYS.slice(0, limit).map((k) => (
        <details key={k} className="group p-4 open:bg-surface/60">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-text [&::-webkit-details-marker]:hidden">
            {t(`${k}.q`)}
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="size-4 shrink-0 text-muted transition-transform group-open:rotate-45"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
          </summary>
          <p className="mt-2 text-sm text-muted">{t(`${k}.a`)}</p>
        </details>
      ))}
    </div>
  );
}
