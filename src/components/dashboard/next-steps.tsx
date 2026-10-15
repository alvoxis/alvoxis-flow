import { useTranslations } from "next-intl";
import { Card, CardHeader } from "@/components/ui/card";

const STEPS = ["createCompany", "inviteTeam", "addCustomers", "firstInvoice"] as const;

export function NextSteps() {
  const t = useTranslations("dashboard.nextSteps");
  return (
    <Card>
      <CardHeader title={t("title")} />
      <ol className="space-y-3">
        {STEPS.map((step, i) => (
          <li key={step} className="flex items-center gap-3 text-sm">
            <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-accent/50 bg-accent-soft text-xs font-semibold text-violet-200">
              {i + 1}
            </span>
            <span className="text-text">{t(step)}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
