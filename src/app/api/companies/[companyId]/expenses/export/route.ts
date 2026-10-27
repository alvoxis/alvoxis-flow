import { headers } from "next/headers";
import { z } from "zod";
import { allExpenses, expenseQuerySchema } from "@/modules/finance/server/expense-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { csvResponse, csvText, toCsv } from "@/server/http/csv";
import { invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/** The filtered expenses as CSV (finance.view; same filters as the list, all pages). */
export async function GET(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const query = expenseQuerySchema
      .omit({ page: true, sort: true })
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    const rows = await allExpenses(db, toActor(user), id.data, query);
    const body = toCsv(
      [
        "date",
        "category",
        "description",
        "supplier",
        "currency",
        "net",
        "tax",
        "tax_recoverable",
        "gross",
        "cost",
        "status",
        "due_date",
        "paid_on",
        "payment_method",
        "reference",
        "source",
      ],
      rows.map((e) => [
        e.expenseDate,
        e.category,
        csvText(e.description),
        csvText(e.supplierName),
        e.currency,
        e.netAmount,
        e.taxAmount,
        e.taxRecoverable ? "yes" : "no",
        e.grossAmount,
        e.costAmount,
        e.status,
        e.dueDate ?? "",
        e.paidOn ?? "",
        e.paymentMethod ?? "",
        csvText(e.reference),
        e.source,
      ]),
    );
    return csvResponse(`expenses-${new Date().toISOString().slice(0, 10)}.csv`, body);
  } catch (err) {
    return invalidBody(err);
  }
}
