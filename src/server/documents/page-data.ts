import "server-only";
import { z } from "zod";
import {
  getDocument,
  listDocuments,
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
      documents: DocumentListItem[];
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
    }
  | Denied;

async function permissionsFor(user: AuthenticatedUser, companyId: string) {
  const ctx = await requireCompanyAccess(getDb(), toActor(user), companyId, "documents.view");
  return {
    canEdit: hasPermission(ctx, "documents.create"),
    canIssue: hasPermission(ctx, "documents.approve"),
    canManageTaxCategories: hasPermission(ctx, "tax_categories.manage"),
  };
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
): Promise<DocumentsListPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  try {
    const permissions = await permissionsFor(user, companyId);
    const documents = (await listDocuments(getDb(), toActor(user), companyId)).reverse();
    const hasTaxCategories =
      (await listTaxCategories(getDb(), toActor(user), companyId)).length > 0;
    return { status: "ok", documents, permissions, hasTaxCategories };
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
    return { status: "ok", document, permissions, taxCategories };
  } catch (err) {
    return denied(err);
  }
}
