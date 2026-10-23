# Roadmap

Stages are sequential unless noted; each ends with tests, documentation and a reviewed PR.
Status as of 23 October 2026 (production release `9d397ff`).

| #   | Stage                                 | Status          | What exists / what is missing                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Foundation**                        | Done            | Structure, tooling, CI, env validation, i18n (5 languages), UI shell, identity/tenancy/permission schema, authorization guard, money module                                                                                                                                                            |
| 2   | **Authentication & sessions**         | Done            | Better Auth ([auth/AUTHENTICATION.md](auth/AUTHENTICATION.md)): email/password, Google, email verification, password reset, DB sessions with revocation, TOTP 2FA (mandatory for owner/admin), rate limiting, auth audit events                                                                        |
| 3   | **Company & team management**         | Partly          | Done: create company, company profile, member list, role changes, suspend/reactivate, last-owner protection, invitations by email. Missing: custom roles UI, audit log viewer, **PostgreSQL RLS** (defence in depth)                                                                                   |
| 4   | **Master data**                       | Done            | Customers and suppliers, products and services (format checks only — no claim of legal validation of registration/VAT numbers)                                                                                                                                                                         |
| 5   | **Exchange rates**                    | Not started     | Only manual rate snapshots on a document. Missing: reference source with provenance and date, manual correction with audit                                                                                                                                                                             |
| 6a  | **Document foundation**               | Done            | Data model, totals and tax summary, numbering, validation, immutable issued documents, credit notes, PDF rendering, PDF import ([documents/DOCUMENT-SYSTEM.md](documents/DOCUMENT-SYSTEM.md))                                                                                                          |
| 6b  | **Documents UI & API**                | Mostly          | Done: draft editor, issue, PDF, import review, tax categories, bank accounts, customer/product pickers, sending by email. Missing: **payment status**, historical import with original numbers, **verified country tax rules and mandatory content (LV/LT/EE/PL)**, e-invoicing formats where required |
| 7   | **Notifications & background jobs**   | Not started     | Only transactional emails (auth, invitations, documents). Missing: in-app/email/Telegram notifications, digests, background worker                                                                                                                                                                     |
| 8   | **Inventory & production**            | Partly          | Done: warehouses, append-only stock ledger, stock operations, bills of materials, production orders. Missing: valuation method (to be decided with accountants), landed costs                                                                                                                          |
| 9   | **Subscriptions**                     | Not started     | Stripe (test mode first); Basic €6.99, Pro AI €12.99, Business €19.99; 2-day trial with **no automatic paid conversion without explicit consent**                                                                                                                                                      |
| 10  | **Claude API assistant**              | Not started     | Server-side only; permission-checked tools; actions with financial consequences need explicit confirmation; audit trail                                                                                                                                                                                |
| 11  | **Accounting integrations & exports** | Not started     | Per-system adapters, sync only where the external API supports it; idempotency and conflict handling                                                                                                                                                                                                   |
| 12  | **Payroll**                           | Calculation aid | Employees, rates per country, monthly runs, CSV. Not a declaration tool: rules must be verified with official sources and professionals before it is more than an aid                                                                                                                                  |
| 13  | **Analytics & reports**               | Basic           | Net sales per month and currency, top customers and lines, stock value, payroll cost, production counts. Missing: reports (VAT, receivables, margins), exports                                                                                                                                         |
| 14  | **Launch readiness**                  | Not started     | See below                                                                                                                                                                                                                                                                                              |

## Before real customers

Required before anyone outside the team uses the product with real data, in this order:

1. **Documentation** — README and roadmap reflect the real state (this file).
2. **Legal** — privacy policy, terms of service, cookie notice; GDPR processes (records of processing,
   data processing agreement, data export and deletion requests, breach procedure). Needs a lawyer.
3. **Tax and mandatory invoice content** — VAT rules and mandatory content per country (LV, LT, EE,
   PL), verified against official sources with effective dates; KSeF readiness for Poland.
4. **Real email** — production SMTP verified end to end: sign-up verification, password reset,
   invitations, documents.
5. **Payments** — stage 9.
6. **Security and operations** — PostgreSQL RLS; monitoring, error tracking and alerts; backups with a
   documented and rehearsed restore.

After 1–6 a closed beta with a limited group is reasonable. Later, but planned: payment status and the
rest of the document flow, native-speaker review of ru/lv/lt/et, exchange rates with provenance,
reports, notifications and background jobs, the AI assistant, accounting integrations, full payroll,
an external security audit and load testing.
