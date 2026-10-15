# Analysis of real invoice examples

Three real documents supplied by the product owner were analysed to inform the document model.
**The originals are confidential and are not stored in this repository.** This file records only their
structure; names, addresses, registration/VAT numbers, bank accounts, people and order references are
intentionally omitted. No test, fixture, screenshot or sample uses data from them.

|                        | Example A                                                               | Example B                                               | Example C                                          |
| ---------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| Type                   | Invoice                                                                 | Proforma invoice                                        | Invoice                                            |
| Producer               | Spreadsheet export                                                      | "Print to PDF"                                          | Spreadsheet-like template                          |
| Seller                 | Latvian SIA (seller 1)                                                  | Latvian SIA (seller 1)                                  | Latvian SIA (seller 2)                             |
| Buyer                  | Foreign (non-EU), a vessel c/o its agent                                | Foreign (non-EU), vessel master c/o agent               | Foreign (non-EU) company                           |
| Number format          | `NN/YYYY` (zero-padded, 2 digits)                                       | `N/YYYY`                                                | `NNN-S/YYYY` (sequence + sub-number)               |
| Issue date             | yes (`DD.MM.YYYY`)                                                      | yes                                                     | yes                                                |
| Due date               | "To be paid before" (+10 days)                                          | **none**                                                | "To be paid before" (+4 days)                      |
| Payment terms text     | none                                                                    | none                                                    | "Prepayment"                                       |
| Currency               | EUR (symbol per amount)                                                 | EUR (only in column headers)                            | EUR (symbol per amount)                            |
| Decimal format         | `1 234,56`                                                              | `1234.56`                                               | `1234.56`                                          |
| Line columns           | Qty, Description, Unit price, Total                                     | Description, Pcs, Weight kg (empty), Price, Total price | Qty, Description, Unit price, Total                |
| Unit of measure        | not shown                                                               | "Pcs" header                                            | not shown                                          |
| Lines                  | 4                                                                       | 1                                                       | 17                                                 |
| Subtotal               | yes                                                                     | no (only "Total")                                       | yes                                                |
| Shipping row           | yes (empty, "-")                                                        | no                                                      | yes (empty)                                        |
| Tax presentation       | "0%" + empty tax amount                                                 | **no tax line at all**                                  | "0%" without tax amount                            |
| Tax explanation        | none                                                                    | free-text statement about goods status in transit       | none                                               |
| Buyer VAT number       | no                                                                      | no                                                      | yes (non-EU format)                                |
| Buyer registration no. | no                                                                      | no                                                      | field present but empty                            |
| Seller identifier      | labelled "Reg. Nr." but value has a VAT-number shape (`LV` + 11 digits) | same                                                    | unlabelled `LV` + 11 digits                        |
| Seller addresses       | one address block, **two different postcodes**                          | legal address + actual address                          | one address                                        |
| Bank details           | bank name, SWIFT, IBAN                                                  | bank **(former) brand name**, IBAN, no SWIFT            | bank name, SWIFT, IBAN                             |
| External reference     | "Notes:" holds an order/PO reference                                    | "P.O. Number"                                           | "Comments" (empty)                                 |
| Signature              | "prepared electronically, valid without signature"                      | named director signature block                          | "prepared electronically, valid without signature" |
| Other                  | logo, highlighted due date                                              | —                                                       | logo, "Thank you" note                             |

Arithmetic was checked independently: every line total equals quantity × unit price, and all
subtotals/totals equal the sum of their lines. All amounts had at most 2 decimals, so no rounding effect
was observable.

## Common fields

Seller identity and bank block · buyer block · document number · issue date · lines
(quantity, description, unit price, line total) · subtotal/total · EUR currency · tax rate
indicator (A, C).

## Differences and gaps that the new system must handle

1. **Tax**: "0%" appears without a tax amount and without a reason; Example B shows no tax line but a
   free-text note. The examples do not tell us whether a 0% means zero-rated supply, exemption,
   reverse charge or out-of-scope. ALVOXIS Flow therefore models the _treatment_ (kind), _rate_,
   _amount_ and an _explanatory note_ separately and **never infers treatment from the examples**.
2. **Identifiers**: registration number and VAT number are mixed up or unlabelled. The model keeps
   them as distinct, labelled fields; import flags ambiguous identifiers instead of guessing.
3. **Payment terms**: due date and terms are optional and inconsistent → explicit `dueDate` and
   `paymentTerms` fields; proformas get an optional validity date.
4. **Numbering**: three different formats, including a sub-number → configurable numbering series
   with pattern tokens; imported historical documents keep their original number.
5. **Number/date formatting** differs per document → formatting derives from the selected _document
   language_, not from the template.
6. **Units / weight**: an empty weight column and implicit units → optional unit and weight per line;
   delivery notes show quantities and weights, not prices.
7. **References**: PO / order references were stored in "Notes" → dedicated `buyerReference` field.
8. **Charges**: an always-present "Shipping" row → charges are ordinary lines (kind `charge`) with their
   own tax category, not a special total.
9. **Stale bank name / inconsistent postcodes** → seller details come from the company profile and are
   snapshotted at issue; the import review flags inconsistencies.
10. **Signature vs. "valid without signature"** → a per-company footer text; no legal claim is made
    by the software about signature requirements.

None of these observations is a statement about legal requirements in LV, LT, EE or PL. Mandatory
invoice content per country must be verified against official sources and effective dates before
validation rules claim compliance.
