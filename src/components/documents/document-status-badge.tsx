import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";

export function DocumentStatusBadge({ status }: { status: "draft" | "issued" }) {
  const t = useTranslations("documents.status");
  return (
    <span data-testid="document-status" data-status={status}>
      <Badge tone={status === "issued" ? "success" : "neutral"}>{t(status)}</Badge>
    </span>
  );
}
