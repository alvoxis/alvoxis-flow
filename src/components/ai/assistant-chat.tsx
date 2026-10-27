"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Alert, Button } from "@/components/ui/form";

interface Turn {
  question: string;
  answer: string;
  status: "ok" | "refused" | "incomplete";
  toolsUsed: string[];
}

const SUGGESTIONS = [
  "profitLastMonth",
  "expensesIncreased",
  "highestMargin",
  "overdue",
  "inflows30",
  "reduceCosts",
  "underpriced",
  "risks",
  "profitChange",
] as const;

/**
 * Questions to the assistant and its answers. Answers are shown as plain text (never as HTML).
 * The conversation lives in this page only; the last turns go back to the server as context.
 */
export function AssistantChat({
  companyId,
  remaining: initialRemaining,
}: {
  companyId: string;
  remaining: number;
}) {
  const t = useTranslations("assistant");
  const locale = useLocale();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(initialRemaining);
  const endRef = useRef<HTMLDivElement>(null);

  async function ask(q: string) {
    const text = q.trim();
    if (!text || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/assistant`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: text,
          locale,
          history: turns
            .slice(-4)
            .map((x) => ({ question: x.question, answer: x.answer.slice(0, 4000) })),
        }),
      });
      const body = (await res.json().catch(() => null)) as
        (Turn & { remainingThisMonth?: number; error?: string; code?: string }) | null;
      if (res.ok && body) {
        setTurns((list) => [
          ...list,
          { question: text, answer: body.answer, status: body.status, toolsUsed: body.toolsUsed },
        ]);
        setRemaining(body.remainingThisMonth ?? remaining);
        setQuestion("");
        requestAnimationFrame(() =>
          endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }),
        );
      } else if (res.status === 429)
        setError(t(body?.error === "budget_exhausted" ? "error.budget" : "error.rate"));
      else if (res.status === 402) setError(t("error.subscription"));
      else if (body?.code === "ai.timeout") setError(t("error.timeout"));
      else if (res.status === 422) setError(t("error.invalid"));
      else setError(t("error.failed"));
    } catch {
      setError(t("error.failed"));
    }
    setPending(false);
  }

  return (
    <div className="space-y-5" data-testid="assistant-chat">
      {turns.length === 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">{t("suggestionsTitle")}</p>
          <ul className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s, i) => (
              <li key={s} className="animate-fade-up" style={{ animationDelay: `${i * 35}ms` }}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void ask(t(`suggestions.${s}`))}
                  className="min-h-10 rounded-full border border-border bg-surface-2/70 px-3.5 text-left text-sm text-text transition-[border-color,transform] hover:-translate-y-px hover:border-accent/60 disabled:opacity-60"
                >
                  {t(`suggestions.${s}`)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ol className="space-y-4" aria-live="polite" data-testid="assistant-turns">
        {turns.map((turn, i) => (
          <li key={i} className="animate-fade-up space-y-2">
            <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-accent-strong px-4 py-2 text-sm whitespace-pre-wrap text-white">
              {turn.question}
            </p>
            <div
              className="max-w-[95%] rounded-2xl rounded-bl-sm px-4 py-3 surface-raised"
              data-testid="assistant-answer"
            >
              {turn.status === "refused" ? (
                <p className="text-sm text-muted">{t("refused")}</p>
              ) : (
                <p className="text-sm leading-relaxed whitespace-pre-wrap text-text">
                  {turn.answer || t("empty")}
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                {turn.status === "incomplete" ? (
                  <Badge tone="warning">{t("incomplete")}</Badge>
                ) : null}
                {turn.toolsUsed.length ? (
                  <span>
                    {t("basedOn")}{" "}
                    {turn.toolsUsed
                      .map((x) => t(`tools.${x}` as Parameters<typeof t>[0]))
                      .join(", ")}
                  </span>
                ) : (
                  <span>{t("noData")}</span>
                )}
              </div>
            </div>
          </li>
        ))}
        {pending ? (
          <li
            className="flex max-w-[95%] items-center gap-3 rounded-2xl px-4 py-3 text-sm text-muted surface-raised"
            data-testid="assistant-thinking"
          >
            <span className="flex gap-1" aria-hidden="true">
              {[0, 1, 2].map((d) => (
                <span
                  key={d}
                  className="size-2 animate-bounce rounded-full bg-accent"
                  style={{ animationDelay: `${d * 150}ms` }}
                />
              ))}
            </span>
            {t("working")}
          </li>
        ) : null}
      </ol>
      <div ref={endRef} />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <label htmlFor="assistant-question" className="sr-only">
          {t("questionLabel")}
        </label>
        <textarea
          id="assistant-question"
          name="question"
          rows={3}
          maxLength={2000}
          value={question}
          placeholder={t("placeholder")}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(question);
            }
          }}
          className="w-full resize-y rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-sm text-text placeholder:text-muted/60 focus:border-accent focus:outline-none"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted">{t("remaining", { count: remaining })}</p>
          <Button type="submit" disabled={pending || !question.trim()} data-testid="assistant-ask">
            {t("ask")}
          </Button>
        </div>
      </form>
    </div>
  );
}
