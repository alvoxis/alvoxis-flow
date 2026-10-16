# Document system

Unified model for **invoices, proforma invoices, credit notes and delivery notes**. Derived from the
structural analysis in [INVOICE-ANALYSIS.md](INVOICE-ANALYSIS.md), but not a copy of any old template.

> Nothing in this module claims legal or tax compliance. Tax treatment, mandatory invoice content and
> rounding rules per country must be verified against official sources and effective dates and then
> encoded as explicit, reviewed country profiles.

## Code layout

```
src/modules/documents/
  domain/    pure TypeScript: types, totals, numbering, validation, derivations, input schema
  server/    server-only services (DB, permissions, audit): drafts, issuing, credit notes, import
  pdf/       React-PDF template, fonts, document-language formatting and labels
  import/    PDF text extraction, heuristic parser, duplicate detection, review → draft
  sample/    FICTITIOUS sample documents (previews, tests, `pnpm docs:samples`)
src/server/db/schema/documents.ts   tables; drizzle/0002–0004 migrations
```

## Data model

| Concept       | Representation                                                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Document      | `type` (invoice · proforma · credit_note · delivery_note), `status` (draft · issued), `language`, `currency`, dates (issue, due, supply, valid-until), seller/buyer/deliver-to **snapshots**, bank-account snapshots, buyer reference (PO), payment terms, notes, footer |
| Line          | kind (item · charge), description, signed quantity (≤4 dp), unit, unit price (≤4 dp, null on delivery notes), discount %, **tax category snapshot**, weight, `sourceLineId` (credit notes)                                                                               |
| Tax category  | `code`, `kind` (standard · zero_rated · exempt · reverse_charge · outside_scope), `ratePercent`, `label`, explanatory `note` — defined by the company, frozen on each line                                                                                               |
| Totals        | per-line nets, **tax summary per category** (taxable amount, tax amount, note), net/tax/gross totals, optional converted totals                                                                                                                                          |
| Relation      | credits · converted_from · delivers · replaces → other document of the same company                                                                                                                                                                                      |
| Exchange rate | `{from, to, rate, rateDate, source}` snapshot; never re-applied after issue                                                                                                                                                                                              |

Amounts are decimal strings in the domain and `NUMERIC` in PostgreSQL. All arithmetic uses
`decimal.js` through `Money`.

## Calculation

- Line net = quantity × unit price × (1 − discount %), rounded to 2 dp (half away from zero).
- Tax per category: `per_group` (default — rate applied to the category's summed nets) or
  `per_line`. Which policy applies is an accounting decision; both are tested.
- Non-`standard` kinds never produce tax. A `standard` category with 0 % is **rejected**: the
  examples showed bare "0%" without a reason, so the user must pick an explicit treatment.
- Charges such as shipping are ordinary lines with their own tax category.
- Credit notes have negative quantities, so their totals are negative.

## Currencies

- One currency per document (EUR or PLN); totals in different currencies are never added.
- Converted totals (e.g. tax in PLN for an EUR invoice) come only from an attached rate snapshot
  showing rate, date and source. Net and tax are converted, gross is their sum.
- Credit notes inherit the invoice's currency **and rate snapshot**; issuing re-checks both.
- Converting a proforma into an invoice does **not** carry the rate over: the invoice needs its own.

## Numbering

Series per company and document type with a pattern of literal text and tokens
`{seq}`, `{seq:N}`, `{yyyy}`, `{yy}`, `{mm}` and a reset policy (`never` · `yearly`). Examples:
`{seq:2}/{yyyy}` → `01/2025`, `INV-{yyyy}-{seq:4}` → `INV-2026-0001`.

Numbers are allocated **only when a document is issued**, inside the issuing transaction, using an
atomic counter row. Drafts have no number; failed issues release the number (no gaps); concurrent
issues are serialised. `(company, type, number)` is unique.

## Seller details

The company profile (`/companies/[id]/profile`) is the only source of the seller's identity:
official name (legal name, else display name), registration number, VAT number and registered
address (country = company country). It is applied when any draft is created or edited (manual,
derived, credit note, import) and again **when the document is issued**, so the issued snapshot
holds the profile as it was at that moment. Only the draft's contact fields (email, phone,
contact person) are kept; a client cannot supply another seller identity. Without a street line
in the profile, issuing is blocked (`seller.address.required`) and no number is used. Later
profile changes never affect issued documents (immutable rows and hashed snapshots); the buyer is
likewise frozen as entered on the draft.

## Lifecycle, immutability and corrections

```
draft ──(validate, allocate number, compute totals, snapshot + SHA-256)──▶ issued (immutable)
  ▲ edit with optimistic version check, every save audited
```

- Database triggers block any UPDATE/DELETE of issued documents and their lines, and inserting
  documents directly as issued (imported historical documents excepted, see roadmap).
- The issued **snapshot** (canonical JSON) is the source of truth for display and PDF re-rendering;
  `verifyDocumentIntegrity` recomputes its hash.
- Corrections never edit the original: issue a **credit note** (partial or full) referencing the
  invoice, and if needed a **replacement invoice** (`replaces` relation).
- Credit-note limits: per original line, credited quantity and amount across all _issued_ credit
  notes may not exceed the original. Checked when the draft is built and again at issue time with
  the invoice row locked.
- Permissions: `documents.create` (drafts, import), `documents.approve` (issue),
  `documents.view` (read), `company.manage` (numbering series). All checks are server-side.

## Validation

`validateDocument` returns issues with stable codes, a path and a severity. Errors block issuing;
warnings (e.g. missing seller identifier, tax note recommended, no bank account) do not.
Untrusted input is shape-checked with Zod (`draftInputSchema`) before business validation.

## PDF rendering

- One template for all four types, rendered server-side with React-PDF.
- Labels, dates and numbers follow the **document language** (`en`, `ru`, `lv`, `lt`, `et`),
  independent of the UI language.
- Shows: tax summary per category, tax notes, converted totals with rate provenance, relation to
  the original document, payment details (invoices/proformas), signature fields (delivery notes),
  draft watermark, document fingerprint and page numbers.
- Noto Sans (SIL OFL 1.1, `assets/fonts/`) covers Baltic and Polish diacritics and Cyrillic.
- `pnpm docs:samples [dir] [lang]` renders the fictitious samples for visual review.

## PDF import (review first)

1. `previewPdfImport` checks size/type, extracts the text layer keeping row layout, and parses it.
   **Nothing is created.** Only the file hash and finding codes are audited.
2. Every value carries a confidence and the text it came from. Findings instead of guesses:
   arithmetic mismatches, ambiguous dates (`02/03/2026`) and amounts (`1,234`), identifier label
   mismatches, unlabelled identifiers, unexplained 0 % tax, missing tax line, multiple currencies,
   invalid IBAN checksums. Possible tax/legal statements are shown, never interpreted.
3. Duplicates in the same company: identical file (certain), same number + date (certain), same
   number or party + date + total (likely), date + total (possible).
4. `createDraftFromImport` re-analyses the file on the server and creates a **draft** only when the
   user has acknowledged every warning/error finding and likely duplicate, confirmed parties and
   dates, and chosen the tax category explicitly.

Scanned PDFs without a text layer are reported as unreadable (OCR is not implemented).

## Tax categories (company catalog)

Each company keeps its own catalog in `tax_categories` (`code`, `kind`, `ratePercent`, `label`,
`note`). New companies start with an **empty** catalog: ALVOXIS Flow ships no categories or rates
and no country rules (LV/LT/EE/PL) — which treatment and rate apply is the company's decision.
Creating and editing needs `tax_categories.manage` (owner, administrator, accountant; migration
0011 grants it to those system roles of existing companies); listing needs `documents.view`.

- `code`, `kind` and `ratePercent` never change after creation; a new rate or treatment is a new
  category. Only `label` and `note` can be edited (with `expectedVersion`). Codes are unique per
  company, archived ones included. Categories are archived, never deleted.
- Checks on create are the existing technical consistency rules (`validateTaxCategory`: known
  kind, rate 0–<100 with ≤ 2 decimals, `standard` > 0 %, other kinds 0 %, note recommended), also
  enforced by a database check. They are not country tax rules.
- Draft lines send `taxCategoryId`; the server builds the line snapshot from the catalog. Inline
  category objects, unknown ids and other companies' ids are refused (422,
  `line.taxCategory.unknown`); a database foreign key `(tax_category_id, company_id)` also keeps
  categories within the company. Archived categories cannot be newly assigned (422,
  `line.taxCategory.archived`); a draft that already uses one keeps it but cannot be issued until
  an active category is chosen.
- Issuing locks the referenced categories (`FOR SHARE`; archiving takes `FOR UPDATE`), refreshes
  `label`/`note` from the catalog into the snapshot and refuses archived categories and lines from
  before the catalog (`line.taxCategory.unlinked`, an explicit choice is required) — in the same
  transaction, before a number is allocated. The catalog link is not part of the issued snapshot.
- Issued documents are never affected by later catalog changes (frozen snapshot, hash, triggers).
- Credit notes keep the original invoice lines' snapshots: categories in the request are ignored,
  and issuing refuses lines that differ from the invoice (`creditNote.taxCategoryMismatch`).
  Invoices derived from a proforma or replacing an invoice keep the source line's category while
  it is active; otherwise they need an explicit choice.
- Import decisions name categories by id (`defaultTaxCategoryId`, per-line `taxCategoryId`).

## HTTP API

Thin route handlers over `document-service` (session → `requireUser` → `requireCompanyAccess`
inside the service; no business logic in the routes):

| Method and path (`/api/companies/{companyId}/documents…`)  | Permission          | Body                         |
| ---------------------------------------------------------- | ------------------- | ---------------------------- |
| `GET …/documents`                                          | `documents.view`    | —                            |
| `POST …/documents` (create draft, 201)                     | `documents.create`  | draft input                  |
| `GET …/documents/{documentId}`                             | `documents.view`    | —                            |
| `PATCH …/documents/{documentId}`                           | `documents.create`  | `{ expectedVersion, draft }` |
| `DELETE …/documents/{documentId}` (drafts only)            | `documents.create`  | —                            |
| `POST …/documents/{documentId}/issue`                      | `documents.approve` | `{ expectedVersion }`        |
| `GET …/documents/{documentId}/pdf` (`?download=1` to save) | `documents.view`    | —                            |

| Method and path (`/api/companies/{companyId}/tax-categories…`) | Permission              | Body                                            |
| -------------------------------------------------------------- | ----------------------- | ----------------------------------------------- |
| `GET …/tax-categories` (`?includeArchived=1`)                  | `documents.view`        | —                                               |
| `POST …/tax-categories` (201)                                  | `tax_categories.manage` | `{ code, kind, ratePercent, label, note? }`     |
| `PATCH …/tax-categories/{categoryId}`                          | `tax_categories.manage` | `{ expectedVersion, label?, note?, archived? }` |

Tax categories add `409 code_taken` (duplicate code) and `404 not_found` (no such category in
this company); changing `code`, `kind` or `ratePercent` is a 422.

| Method and path (`/api/companies/{companyId}/bank-accounts…`) | Permission       | Body                                                                  |
| ------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------- |
| `GET …/bank-accounts` (`?includeArchived=1`)                  | `documents.view` | —                                                                     |
| `POST …/bank-accounts` (201)                                  | `company.manage` | `{ iban, label?, bankName?, bic?, isDefault? }`                       |
| `PATCH …/bank-accounts/{accountId}`                           | `company.manage` | `{ expectedVersion, label?, bankName?, bic?, isDefault?, archived? }` |

Bank accounts add `409 iban_taken` (another active account of the company has this IBAN) and
`404 not_found`; an invalid IBAN (ISO 13616 checksum) or BIC (8 or 11 characters, format only) is
a 422 (`bankAccount.iban.invalid`, `bankAccount.bic.invalid`); changing the IBAN is a 422.

`GET …/documents/{documentId}/pdf` returns `application/pdf` (`Content-Disposition: inline`, or
`attachment` with `?download=1`; `Cache-Control: private, no-store`). Issued documents are rendered
only from their frozen snapshot (content, totals, number and fingerprint as issued — later profile
or catalog changes never appear); the file is named after the number. Drafts render their last
saved content with the "not issued" watermark and no number (`draft-<type>-<id>.pdf`). Errors are
the usual JSON answers (401/403/404/400).

`GET …/documents` returns `{ documents: [{ id, type, status, number, issueDate, currency,
grossTotal, buyerName }] }`, ordered by issue date. `buyerName` is the buyer's name stored on the
document row (`buyer->>'name'`); issued rows are immutable, so it is the name in the frozen
snapshot. `grossTotal` is stored for issued documents only (`null` for drafts). There is no search,
filter or sort by buyer.

Responses: `400 invalid_request` (malformed path or non-JSON body), `401 unauthenticated` /
`two_factor_challenge_required`, `403 forbidden` (non-member, archived company, missing
permission — identical whether or not the company exists) or `two_factor_enrollment_required`,
`404 not_found` (no such document in this company), `409 version_conflict` (stale
`expectedVersion`), `409 invalid_state` with a `code` (e.g. `document.alreadyIssued`,
`document.notDraft`), `422 validation_failed` with `issues` (`{ code, severity, path }`; shape
errors use `input.*` codes, blocking business rules use the `validateDocument` codes). Issuing is
one transaction, so a refused or failed issue never uses a number, and a repeated issue is a 409
that keeps the original number.

## UI

`/{locale}/companies/{companyId}/documents` lists the company's documents (number, buyer — cut with an ellipsis, full name in the tooltip — type, status,
issue date, total — the total is stored for issued documents only). A document page shows issued
documents read-only from their snapshot, with the assigned number. Drafts open in an editor
(dates, buyer, lines, payment terms and notes) that saves with `PATCH` and issues with
`POST …/issue` after an explicit confirmation; issuing is disabled while there are unsaved
changes. The pages load data through `src/server/documents/page-data.ts` (the same
`document-service` calls and `requireCompanyAccess`); `documents.create` / `documents.approve`
only decide which controls are shown, the API enforces them. Validation findings, totals and
numbers are always the server's; the editor shows `issues` translated by code
(`documents.issues.*`, generic text for unknown codes) and maps 409/401/403/404 answers to
messages (a version conflict offers a reload). Non-members, archived companies and missing
`documents.view` get 404; roles that need 2FA without it see the 2FA notice.

### PDF

The document page offers "Open PDF" (new tab) and "Download PDF" for issued documents, and a
watermarked preview for drafts in the editor (with a note when there are unsaved changes, since
the PDF shows the last saved version). The links use the PDF endpoint above; anyone who can see the
document page may get its PDF.

### Creating and deleting drafts

Users with `documents.create` get a "New document" action on the list
(`/{locale}/companies/{companyId}/documents/new`): type (invoice, proforma or delivery note;
credit notes come from an issued invoice), document language (default: the interface language),
currency (EUR or PLN, **no default** — it must be chosen), issue date (default: today's calendar
date in the browser's time zone, editable) and buyer name. The form sends only these fields with
`lines: []` to `POST …/documents`; the server adds the seller from the company profile. The
editor then opens for lines and explicit tax categories. Drafts can be deleted from the editor and
from their list row, each after a confirmation; afterwards the list shows a confirmation message.
Issued documents never show the action, and the API refuses it anyway (409; another company's
document is a 404). Both actions are hidden without `documents.create` and enforced by the API.

### Bank accounts

A company keeps several bank accounts (`company_bank_accounts`, migration 0012): IBAN (stored
normalized, the account's identity — never changed), optional BIC, bank name and label, a default
flag (at most one per company) and `archived_at` (accounts are archived, never deleted; one active
account per IBAN). The database enforces these with partial unique indexes and format checks.

Documents reference an account by id (`documents.bank_account_id`, composite FK to the same
company). The draft input takes `bankAccountId` (an id, `null` for none, or omitted to keep the
current choice); inline `bankAccounts` input is refused. The server copies the account's details
into the draft's `bankAccounts`, refreshes them on issue under a `FOR SHARE` lock (archiving takes
`FOR UPDATE`) and freezes them in the snapshot; the link itself is not part of the snapshot, so
editing or archiving an account never changes issued documents. Another company's or an unknown
id is a 422 `bankAccount.unknown`; newly choosing an archived account is a 422
`bankAccount.archived`; a draft whose account was archived since is kept but cannot be issued
(blocking issue `bankAccount.archived`, no number used). Drafts with details entered before
accounts existed keep them unlinked until an account is chosen. Invoices derived from a proforma
or a replaced invoice link the source's account if it is still active; credit notes keep the
invoice's details.

`/{locale}/companies/{companyId}/bank-accounts` lists the accounts (table on wide screens, cards on
phones). With `company.manage` (owner, administrator) users add accounts, edit label/bank
name/BIC, set the default and archive (with confirmation) or restore; other roles with
`documents.view` see it read-only. The "New document" form (not for delivery notes) and the
editor offer the active accounts with the default preselected for new documents and a "No bank
details" option; the document page shows the bank details.

### Tax categories in the UI

`/{locale}/companies/{companyId}/tax-categories` lists the catalog (a table on wide screens, cards
on phones) and, with `tax_categories.manage`, lets the user add categories, edit `label`/`note`
and archive (with confirmation) or restore them; code, treatment and rate are read-only after
creation. It offers no categories or rates of its own. Other roles with `documents.view` see it
read-only; without access the page is a 404. Links come from the company list and from the
empty-catalog hints on the documents list and in the editor.

In the editor, each invoice/proforma line has a picker of **active** categories with no default;
new lines start without a category (the server blocks issuing until one is chosen). Credit-note
lines show the invoice's category and cannot change it. Lines with an archived category or with
pre-catalog tax data show a warning. Pre-catalog data is never lost on save: when a line is
resubmitted with its own id and no category, `updateDraft` keeps the snapshot stored on that line
of the same draft (read from the database, not the request); ids of other drafts are ignored.
"Restore previous value" undoes a choice before saving; an explicit choice that is saved replaces
the old snapshot, and the server never rolls it back.

## Not implemented yet

Payment status, importing historical issued documents
with their original numbers, e-invoicing formats (e.g. structured XML required in some countries),
country profiles for mandatory content, and OCR.
