import "server-only";
import { z } from "zod";
import {
  type BankAccountView,
  listBankAccounts,
} from "@/modules/documents/server/bank-account-service";
import { type DocumentListQuery, EMPTY_DOCUMENT_QUERY } from "@/features/documents/list-query";
import {
  getDocument,
  type listDocuments,
  listRelatedDocuments,
  searchDocuments,
  type StoredDocument,
} from "@/modules/documents/server/document-service";
import { DocumentNotFoundError } from "@/modules/documents/server/errors";
import {
  listTaxCategories,
  type TaxCategoryView,
} from "@/modules/documents/server/tax-category-service";
import { hasPermission, requireCompanyAccess } from "@/server/auth/authorization";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";

/** What the current user may do with documents of the company (decided by requireCompanyAccess). */
export interface DocumentPermissions {
  canEdit: boolean;
  canIssue: boolean;
  /** tax_categories.manage: may open the catalog to add categories (links in hints). */
  canManageTaxCategories: boolean;
}

export type DocumentListItem = Awaited<ReturnType<typeof listDocuments>>[number];

type Denied = { status: "two_factor_required" } | { status: "not_found" };

export type DocumentsListPageData =
  | {
      status: "ok";
      /** One page of documents matching the query. */
      documents: DocumentListItem[];
      /** All documents matching the query (for paging and the "nothing found" state). */
      total: number;
      permissions: DocumentPermissions;
      /** Whether the company has at least one active tax category (empty-catalog hint). */
      hasTaxCategories: boolean;
    }
  | Denied;

export type DocumentPageData =
  | {
      status: "ok";
      document: StoredDocument;
      permissions: DocumentPermissions;
      /** Active categories offered in the line picker (archived ones are never offered). */
      taxCategories: TaxCategoryView[];
      /** Active company bank accounts offered in the account picker (drafts only). */
      bankAccounts: BankAccountView[];
      /**
       * Credit notes of an issued invoice (null for other documents). Loaded separately: if it
       * fails, the invoice is still shown, with a notice instead of the list.
       */
      creditNotes: { status: "ok"; items: DocumentListItem[] } | { status: "error" } | null;
    }
  | Denied;

export type NewDocumentPageData =
  { status: "ok"; permissions: DocumentPermissions; bankAccounts: BankAccountView[] } | Denied;

async function permissionsFor(user: AuthenticatedUser, companyId: string) {
  const ctx = await requireCompanyAccess(getDb(), toActor(user), companyId, "documents.view");
  return {
    canEdit: hasPermission(ctx, "documents.create"),
    canIssue: hasPermission(ctx, "documents.approve"),
    canManageTaxCategories: hasPermission(ctx, "tax_categories.manage"),
  };
}

/** Error class only: messages may carry business data and stay out of the logs. */
function errName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function denied(err: unknown): Denied {
  if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
  // Non-members, archived companies, missing permission and unknown documents look the same.
  if (err instanceof ForbiddenError || err instanceof DocumentNotFoundError)
    return { status: "not_found" };
  throw err;
}

/** Documents list page (documents.view); newest first. */
export async function documentsListData(
  user: AuthenticatedUser,
  companyId: string,
  query: DocumentListQuery = EMPTY_DOCUMENT_QUERY,
): Promise<DocumentsListPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  try {
    const permissions = await permissionsFor(user, companyId);
    const { documents, total } = await searchDocuments(getDb(), toActor(user), companyId, query);
    const hasTaxCategories =
      (await listTaxCategories(getDb(), toActor(user), companyId)).length > 0;
    return { status: "ok", documents, total, permissions, hasTaxCategories };
  } catch (err) {
    return denied(err);
  }
}

/** One document (documents.view); issued documents come from their frozen snapshot. */
export async function documentPageData(
  user: AuthenticatedUser,
  companyId: string,
  documentId: string,
): Promise<DocumentPageData> {
  if (!z.uuid().safeParse(companyId).success || !z.uuid().safeParse(documentId).success)
    return { status: "not_found" };
  try {
    const permissions = await permissionsFor(user, companyId);
    const document = await getDocument(getDb(), toActor(user), companyId, documentId);
    const taxCategories = await listTaxCategories(getDb(), toActor(user), companyId);
    const bankAccounts =
      document.status === "draft" ? await listBankAccounts(getDb(), toActor(user), companyId) : [];
    let creditNotes: Extract<DocumentPageData, { status: "ok" }>["creditNotes"] = null;
    if (document.status === "issued" && document.draft.type === "invoice") {
      try {
        const items = await listRelatedDocuments(
          getDb(),
          toActor(user),
          companyId,
          documentId,
          "credits",
        );
        creditNotes = { status: "ok", items };
      } catch (err) {
        console.error("[documents] credit notes of an invoice could not be loaded", errName(err));
        creditNotes = { status: "error" };
      }
    }
    return { status: "ok", document, permissions, taxCategories, bankAccounts, creditNotes };
  } catch (err) {
    return denied(err);
  }
}

/** "New document" page (documents.view; creating needs documents.create, API-enforced). */
export async function newDocumentPageData(
  user: AuthenticatedUser,
  companyId: string,
): Promise<NewDocumentPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  try {
    const permissions = await permissionsFor(user, companyId);
    const bankAccounts = await listBankAccounts(getDb(), toActor(user), companyId);
    return { status: "ok", permissions, bankAccounts };
  } catch (err) {
    return denied(err);
  }
}
