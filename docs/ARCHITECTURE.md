# Architecture

## Shape: modular monolith

One Next.js application, one PostgreSQL database, organised by module. Microservices would add
deployment, consistency and observability cost without benefit at this scale. Module boundaries are
kept explicit so a module can be extracted later if a real need appears (e.g. a background worker for
integrations and notifications, planned as a separate process sharing the codebase).

```
Browser ──► Next.js (React Server Components, Route Handlers, Server Actions)
              │  proxy.ts: locale negotiation only (no auth decisions)
              ▼
           src/server/**  ── authorization (requireCompanyAccess) ── tenancy ── audit
              ▼
           PostgreSQL (Drizzle ORM, SQL migrations)
```

Rules:

- `src/server/**` is server-only. ESLint blocks importing the DB layer from components/app files;
  `server-only` guards the DB client at runtime.
- **Authorization lives on the server.** UI may hide controls, but every tenant-scoped operation must
  first obtain a `CompanyContext` from `requireCompanyAccess(db, actor, companyId, permission)`.
- Secrets are read only through `getServerEnv()`; nothing secret uses `NEXT_PUBLIC_`.

## Feature modules

Larger features live in `src/modules/<name>/` with a fixed internal layout:
`domain/` (pure, framework-free logic usable anywhere), `server/` (server-only services that call
`requireCompanyAccess` and write audit entries), and feature-specific folders (e.g. `pdf/`,
`import/`). The first module is `documents` — see [documents/DOCUMENT-SYSTEM.md](documents/DOCUMENT-SYSTEM.md).

The package is an ES module (`"type": "module"`); some dependencies (React-PDF) only expose ESM
entry points.

## Multi-tenancy

- `companies` is the tenant root; tenant-owned tables carry `company_id`.
- A user may belong to several companies through `memberships` (one role per membership).
- `requireCompanyAccess` checks: active membership, company not archived, user not disabled, role's 2FA
  requirement against the **session's** 2FA state, and the required permissions. Non-membership and
  non-existence return the same `ForbiddenError` (no tenant enumeration).
- Database-level guarantees:
  - composite FK `memberships(role_id, company_id) → roles(id, company_id)`: a membership can never
    reference another company's role;
  - `role_permissions.permission_key → permissions.key`: only catalogued permissions can be granted;
  - case-insensitive unique, lower-cased emails;
  - `audit_logs` is append-only (trigger blocks UPDATE/DELETE/TRUNCATE).
- `tenantFilter(column, ctx)` is the required filter helper for tenant-scoped queries.
- **Planned defence in depth (stage 3):** PostgreSQL Row-Level Security on tenant data tables, with the
  application connecting as a non-owner role and setting `app.company_id` per transaction.

## Authentication

Better Auth serves `/api/auth/*`; every page, server action and API route resolves the user with
`requireUser` (`src/server/auth/session.ts`), which validates the database session, rejects disabled
users and requires a 2FA-verified session for users with 2FA enabled. Company access then goes through
the unchanged `requireCompanyAccess`, which receives the session's 2FA state. Details, policies and
residual risks: [auth/AUTHENTICATION.md](auth/AUTHENTICATION.md).

## Roles and permissions

Permission keys are defined in code (`src/server/auth/permissions.ts`) and mirrored in the
`permissions` table (`pnpm db:seed`). Each company receives its own copies of the six system roles
(owner, administrator, accountant, manager, warehouse employee, production employee) from templates and
may customise them; changing templates never alters existing companies. Owners and administrators are
flagged `requires_two_factor`.

## Money and currencies

- `Money` (decimal.js, 40 significant digits) refuses JS numbers, refuses mixing currencies, and only
  rounds when asked, with an explicit rounding mode. Persist as `NUMERIC` + currency code.
- Each document has its own currency (EUR or PLN). There is **no company base currency**; dashboards show
  totals per currency and never add different currencies together.
- `ExchangeRate` carries `rate`, `rateDate` and `source` (reference provider or manual entry with user).
  Approved documents will store a snapshot of the rate applied and are never silently recalculated.
- No tax, VAT, customs or payroll rules exist in the code yet. Rounding modes and rates are mechanisms,
  not compliance claims; country rules must be verified against official sources and effective dates.

## Internationalisation

- Locales `en` (source), `ru`, `lv`, `lt`, `et`; URLs are always prefixed (`/lv/...`).
- Messages use ICU syntax with CLDR plural categories per language.
- Tests enforce: identical key sets, no empty strings, same ICU arguments, and that non-English catalogs
  are actually translated.
- Formatting of money/dates uses `Intl` with locale-specific tags; amounts are passed as decimal strings.
- Translations were written by the developer and **need review by native speakers** before launch.

## PWA

Web app manifest + icons; a service worker (production only) that caches only offline fallback pages and
icons. Business data and HTML pages are deliberately not cached on devices.

## Key dependency decisions

| Decision                         | Why                                                                                                                                                                         | Trade-off                                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Next.js 16 App Router            | Server Components keep data and secrets on the server; one deployable                                                                                                       | Framework churn; `middleware` renamed to `proxy`                                                      |
| Drizzle 0.45 over Prisma         | Plain, reviewable SQL migrations; easy custom SQL (triggers, RLS); no binary engine. Prisma's `latest` tag currently points to an 8.0 release candidate                     | Smaller ecosystem; Drizzle 1.0 is in RC — upgrade planned when stable                                 |
| TypeScript 5.9 (not 7)           | typescript-eslint supports `<6.1`                                                                                                                                           | Revisit when tooling supports TS 7                                                                    |
| ESLint 9                         | `eslint-config-next` and plugins are validated on 9                                                                                                                         | ESLint 10 later                                                                                       |
| next-intl 4                      | Mature App Router support, ICU, typed messages                                                                                                                              | —                                                                                                     |
| decimal.js                       | Correct decimal arithmetic, no native deps                                                                                                                                  | Slower than integers-in-minor-units; acceptable at document scale                                     |
| @react-pdf/renderer 4.9 for PDFs | Server-side, pure JS, React components, embedded fonts                                                                                                                      | A page-level `lineHeight` with custom fonts drops page numbers (worked around; covered by a test)     |
| unpdf (pdf.js) for PDF text      | Same engine for import and for testing our own output                                                                                                                       | Text layer only — scanned PDFs need OCR later                                                         |
| Better Auth 1.7                  | Email/password, verification, reset, Google OAuth, DB sessions, TOTP 2FA and rate limiting built in; Drizzle adapter — see [auth/AUTHENTICATION.md](auth/AUTHENTICATION.md) | Library gaps (2FA bypass via OAuth, TOTP replay, plain recovery codes) closed in our hooks and tested |
