import { headers } from "next/headers";
import { z } from "zod";
import { getCalculation } from "@/modules/costing/server/costing-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { csvResponse, csvText, toCsv } from "@/server/http/csv";
import { apiError, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; calculationId: string }> };
const pathSchema = z.object({ companyId: z.uuid(), calculationId: z.uuid() });

/** One saved calculation as CSV: its lines, totals and pricing (products.view). */
export async function GET(_request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const c = await getCalculation(db, toActor(user), path.data.companyId, path.data.calculationId);
    const r = c.result;
    const rows: string[][] = r.lines.map((l) => [
      l.category,
      csvText(l.label),
      l.total,
      l.perUnit,
      l.share,
      l.needsVerification ? "yes" : "no",
    ]);
    rows.push(["total", csvText(c.name), r.totalCost, r.unitCost, "100.00", ""]);
    if (r.pricing)
      rows.push([
        "pricing",
        csvText(
          `price ${r.pricing.salePrice}; margin % ${r.pricing.marginPercent ?? ""}; markup % ${r.pricing.markupPercent ?? ""}`,
        ),
        r.pricing.expectedProfit,
        r.pricing.profitPerUnit,
        "",
        "",
      ]);
    return csvResponse(
      `cost-${c.id.slice(0, 8)}.csv`,
      toCsv(
        [
          "category",
          "label",
          `total_${r.currency}`,
          "per_unit",
          "share_percent",
          "needs_verification",
        ],
        rows,
      ),
    );
  } catch (err) {
    return apiError(err);
  }
}
