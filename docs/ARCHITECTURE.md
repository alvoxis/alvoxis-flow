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

Company record modules follow one pattern: a service in `src/modules/<name>/server/` (permission
check, validation with every finding at once, optimistic `version`, archive instead of delete, an
audit entry with field names only), route handlers under `/api/companies/[companyId]/…`, a page
under `/companies/[companyId]/…` plus a navigation entry that picks the company. Shared pieces:
`src/server/records/errors.ts` (mapped once in `apiError`) and `src/features/records/api.ts` (the
client side). Modules:

- `counterparties` — customers and suppliers (one record may be both; `customers.*` and
  `suppliers.*` permissions apply per role). Unique registration number among active records.
  Choosing a customer in the document editor copies its details into the draft's buyer (and sets
  an invoice's due date from the payment term); documents keep their own copy.
- `products` — goods and services (`products.view` / `products.manage`): SKU unique among active
  products, net prices with up to 4 decimals in EUR or PLN, an optional default tax category (an
  active category of the same company, enforced by a composite foreign key), stock tracking for
  goods. "Add from catalog" in the document editor adds a line with the name, unit and — on priced
  documents in the same currency — the sale price and tax category.
- `inventory` — warehouses and the stock ledger (`inventory.view` / `inventory.manage`). A balance
  is the sum of a product's movements in a warehouse; `stock_movements` is append-only (trigger,
  like `audit_logs`). Receipts, issues, transfers (two movements with one `groupId`) and counts (the
  difference is written as an adjustment). Every change that can lower a balance locks the
  affected products (`FOR UPDATE`, in id order) and is refused below zero; the arithmetic runs in
  PostgreSQL `numeric`. A warehouse holding stock cannot be archived; a product with movements
  keeps stock tracking on. `applyStockChanges` is the one entry point for other modules
  (production).
- `production` — bills of materials and production orders (`production.view` /
  `production.manage`). An order (`PRD-YYYY-NNNN`, numbered under a per-company advisory lock)
  copies its component totals from the bill when it is planned. Completing it consumes the
  components and adds the product through `applyStockChanges` in one transaction (refused while
  stock is short; the movements share the order id); completed and cancelled orders are final.
  Production roles move stock this way without `inventory.manage`.
- `payroll` — employees, rates per country and monthly runs (`payroll.view` / `payroll.manage`).
  A calculation aid, not a tax declaration: rates (employee social, employer social, income tax,
  health insurance) are company settings whose built-in starting values must be checked by the
  accountant; special regimes, progressive brackets and caps are not modelled. The pure
  calculation (`modules/payroll/domain/calculate.ts`) works in integer cents and rounds half up.
  A run copies names, countries, currencies and rates into its lines; a gross amount can be
  changed for one month (kept on recalculation); an approved run is final. CSV export with BOM,
  formula-injection-safe cells. Audit entries never carry names or amounts.
- `analytics` — read-only figures of a calendar year (`analytics.view` + `documents.view`):
  net sales of issued invoices and credit notes per month and currency (never converted), top
  customers by buyer, top lines by description, and — only with their own permission — stock
  value, payroll employer cost of approved months and production order counts.
- Settings (`/companies/[id]/settings`) — links to the settings pages the role may open and the
  members list (`members.view`); with `members.manage` roles can be changed and members
  suspended. Nobody changes their own membership, only owners manage owners, and the last active
  owner stays (company memberships are locked while this is checked).
- Invitations (`company_invitations`, migration `0020`) — `members.manage` invites an email address
  with a role; the owner role only by owners. The link (`/[locale]/invitations/[token]`, valid 7 days)
  is emailed and shown once to the inviter, so it can be shared when email is not configured; only
  the token's SHA-256 hash is stored. A signed-in user whose verified email equals the invited
  address accepts it and becomes an active member; inviting an address again replaces the open
  invitation. Audit entries never carry the invited address.
- Subscriptions (`company_billing`, `billing_events`, `company_access_grants`; migrations `0021`,
  `0022`; `src/modules/billing`) — one plan, **ALVOXIS Flow at €9.99 per month, no trial**
  (`plans.ts`). Owners (`billing.manage`) subscribe on `/companies/[id]/billing` through Stripe
  Checkout and manage the card in the Stripe customer portal, so card data never reaches the
  application. The price is found by lookup key `alvoxis_flow_monthly`, and checkout refuses a
  price that is not exactly 999 EUR cents per month. The webhook (`/api/billing/webhook`) verifies
  the signature, records each event id once in `billing_events` in the same transaction, and
  re-reads the subscription from Stripe, so duplicates and out-of-order events change nothing.
  Access (`access.ts`): `active`/`trialing` and `past_due` (grace while Stripe retries) are paid;
  anything else is **read-only** when enforcement is on — `requireCompanyAccess` withholds the
  `PAID_PERMISSIONS` (creating and changing business records and documents, and the assistant; company,
  member, role and billing management stay) and the API
  answers `402 subscription_required`. Viewing, exports and billing stay available, so nobody is
  locked out of their data. Operators can grant time-limited internal access
  (`company_access_grants`, audited).
- `finance` — invoice payments (`document_payments`) and expenses (`expenses`), migration `0024`,
  permissions `finance.view` / `finance.manage` (`0023` grants them to existing roles). A payment
  belongs to an issued invoice in its currency and may not exceed the open balance (row lock on
  the document); voiding keeps the row. Balances and ageing buckets come from
  `domain/receivables.ts`. Expenses carry category, supplier, net + VAT, status, due date and an
  optional recurrence; CSV export.
- `dashboard` — `/companies/[id]/dashboard`: revenue, expenses, result, gross profit, cash in/out,
  receivables, payables and stock value for a period (presets or a custom range) compared with the
  previous period of the same length, plus monthly charts and recent activity. Every figure is a
  query over the company's own records; amounts in other currencies are listed separately, never
  converted.
- `costing` — the cost calculator (`domain/calculate.ts`, pure decimal arithmetic): cost lines
  per unit or per batch (purchase, delivery, insurance, customs, packaging, materials, piecework,
  overhead, other), quantity, sale price or target margin, scenarios; saved calculations
  (`cost_calculations`, migration `0025`) and CSV.
- `reports` — `/api/companies/[id]/reports/[report]` (JSON or `?format=csv`): profit and loss,
  receivables ageing, expenses by category, VAT summary (output VAT of issued documents and input
  VAT of expenses — a summary, not a declaration), product margins and stock.
- `ai` — the assistant (`/companies/[id]/assistant`, permission `ai.use`). The server calls the
  Claude API with a manual tool loop; the tools (`tools.ts`) are **read-only** and run through the
  same services and permission checks as the user, scoped to the current company, so the model sees
  nothing the user could not. The prompt tells it to answer only from tool results and say when data
  is missing. Per-company monthly limits and token accounting in `ai_usage`; the content of
  questions and answers is not stored or logged.
- `admin` — the operator area `/[locale]/admin` (not linked, `noindex`, 404 for everyone else):
  users, companies, subscription counts, payment failures, AI usage and estimated cost, health and
  configuration flags, recent billing/admin events, and internal access grants. Requires a
  `platform_admins` row (granted only with `pnpm admin:grant`), 2FA on the account and a
  2FA-verified session. Every view and action is audited.
- Public website (`src/app/[locale]/(public)`) — landing, features, pricing, FAQ, about, contact
  and legal drafts (privacy, terms, subscription terms, cookies; each marked as a draft needing legal
  review). `src/proxy.ts` shows the landing page at `/{locale}` to visitors without a session
  cookie; this is presentation only, every app page still checks the session. `sitemap.ts` and
  `robots.ts` list the public pages; app pages are `noindex`.
- Themes — dark by default with a light theme (`:root[data-theme="light"]` token overrides in
  `globals.css`). The choice is stored in `localStorage` and applied by an inline script before
  the first paint; animations are CSS only and respect `prefers-reduced-motion`.

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

## UI components

- Shared primitives live in `src/components/ui` and use the app's own colour tokens from
  `src/app/globals.css` (`bg`, `surface`, `surface-2`, `border`, `text`, `muted`, `accent`, …). The app
  is dark-only.
- Interactive overlays use **Base UI** (`@base-ui/react`) in the shadcn/ui "base" pattern: the code is in
  the repository (`alert-dialog.tsx`, `toast.tsx`), restyled with our tokens. Base UI handles focus
  trapping and return, Esc, scroll lock and hiding the rest of the page from assistive technology.
- `components.json` records the shadcn setup (`base-nova`). **Do not accept the CSS that `shadcn init` or
  `shadcn add` writes into `globals.css` unreviewed**: its tokens reuse our names (`border`, `accent`,
  `muted`) with other meanings and would restyle every screen. Add component code, then map it to our
  tokens.
- `cn()` (`src/lib/utils.ts`) is clsx + tailwind-merge, for components whose `className` overrides
  defaults.
- Base UI layout requirements: the app is wrapped in `.root` (`isolation: isolate`) and `body` is
  `position: relative` (backdrops cover the area under the iOS 26 Safari toolbars).
- `prefers-reduced-motion: reduce` turns transitions and animations off globally.
- Toasts are for confirmations that need no action; errors and messages with links stay in inline
  alerts next to their form. `<Toaster />` is **not** mounted globally: add it to the layout or page of
  the routes that show toasts, so its code loads only there (no screen uses toasts yet).
- Dialog behaviour is covered by e2e tests with axe (`@axe-core/playwright`); an optional, non-blocking
  workflow (`webkit.yml`) runs the dialog and navigation tests on WebKit with an iPhone profile.

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
