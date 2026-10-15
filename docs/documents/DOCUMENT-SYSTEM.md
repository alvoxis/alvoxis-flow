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

## Not implemented yet

UI and HTTP endpoints (they need authentication — stage 2), company profile as the source of
seller/bank snapshots and tax categories, payment status, importing historical issued documents
with their original numbers, e-invoicing formats (e.g. structured XML required in some countries),
country profiles for mandatory content, and OCR.
