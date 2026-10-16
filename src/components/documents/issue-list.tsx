import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { type ApiIssue, lineIndexOf } from "@/features/documents/editor-model";

/** Server findings, translated by code; unknown codes (e.g. input shape errors) get a generic text. */
export function IssueList({ issues }: { issues: readonly ApiIssue[] }) {
  const t = useTranslations("documents");
  if (issues.length === 0) return null;
  const sorted = [...issues].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1,
  );
  return (
    <section aria-labelledby="document-checks" className="space-y-2" data-testid="document-issues">
      <h3 id="document-checks" className="text-sm font-semibold text-text">
        {t("checksTitle")}
      </h3>
      <ul className="space-y-1.5">
        {sorted.map((issue, i) => {
          const key = `issues.${issue.code}` as Parameters<typeof t>[0];
          const line = lineIndexOf(issue.path);
          return (
            <li
              key={`${issue.code}-${issue.path}-${i}`}
              className="flex flex-wrap items-start gap-2 text-sm"
              data-testid="document-issue"
              data-code={issue.code}
              data-severity={issue.severity}
            >
              <Badge tone={issue.severity === "error" ? "danger" : "warning"}>
                {t(`severity.${issue.severity}`)}
              </Badge>
              <span className="min-w-0 flex-1 text-text">
                {line !== null ? `${t("lineN", { n: line + 1 })}: ` : null}
                {t.has(key) ? t(key) : t("issueGeneric")}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
