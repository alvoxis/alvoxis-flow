import { useTranslations } from "next-intl";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { type DocumentStatus } from "@/features/dashboard/types";

const TONE: Record<DocumentStatus, BadgeTone> = {
  draft: "neutral",
  approved: "accent",
  sent: "accent",
  paid: "success",
  overdue: "danger",
  delivered: "success",
};

export function StatusBadge({ status }: { status: DocumentStatus }) {
  const t = useTranslations("documentStatus");
  return <Badge tone={TONE[status]}>{t(status)}</Badge>;
}
