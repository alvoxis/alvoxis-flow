import { type ReactNode } from "react";
import { Card } from "@/components/ui/card";

export function KpiCard({
  label,
  hint,
  children,
  tone = "default",
}: {
  label: string;
  hint: string;
  children: ReactNode;
  tone?: "default" | "danger";
}) {
  return (
    <Card className="flex flex-col gap-3">
      <p className="text-sm font-medium text-muted">{label}</p>
      <div
        className={
          tone === "danger"
            ? "tabular space-y-0.5 text-2xl font-semibold text-danger"
            : "tabular space-y-0.5 text-2xl font-semibold text-text"
        }
      >
        {children}
      </div>
      <p className="mt-auto text-xs text-muted">{hint}</p>
    </Card>
  );
}
