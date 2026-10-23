# ALVOXIS Flow

Business management SaaS for small and medium businesses in **Latvia, Lithuania, Estonia and Poland**:
invoicing, customers & suppliers, products, inventory, production, payroll and analytics.

> **Status: closed beta preparation — not yet for real customers.** Working today: accounts with
> email verification, Google sign-in, sessions and TOTP 2FA; companies, roles, member invitations;
> documents (drafts, issue with numbering, credit notes, PDF, PDF import, sending by email);
> customers and suppliers; products; inventory (append-only stock ledger); production (bills of
> materials, production orders); payroll as a **calculation aid**; basic analytics.
>
> **Not ready for real use yet:** verified country tax rules and mandatory invoice content
> (LV/LT/EE/PL), legal documents (privacy policy, terms, cookie notice, GDPR processes), payments and
> subscriptions, monitoring and alerting, documented restore drills, PostgreSQL RLS. The full list
> and order is in [docs/ROADMAP.md](docs/ROADMAP.md#before-real-customers).

## Stack

| Concern       | Choice                                                          |
| ------------- | --------------------------------------------------------------- |
| Runtime       | Node.js 22 LTS, pnpm 10                                         |
| Web framework | Next.js 16 (App Router, React 19, Server Components)            |
| Language      | TypeScript 5.9 (strict, `noUncheckedIndexedAccess`)             |
| Styling       | Tailwind CSS 4 (dark theme, purple accent tokens)               |
| i18n          | next-intl 4 — `en`, `ru`, `lv`, `lt`, `et`                      |
| Database      | PostgreSQL 16 + Drizzle ORM 0.45 (SQL migrations in `drizzle/`) |
| Validation    | Zod 4                                                           |
| Auth          | Better Auth 1.7 (email/password, Google, TOTP 2FA, DB sessions) |
| Money         | decimal.js via `src/lib/money` (no floats)                      |
| Tests         | Vitest 4 (unit + integration), Playwright (e2e)                 |
| CI            | GitHub Actions                                                  |

Rationale and trade-offs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Local development

Prerequisites: Node.js ≥ 22.12, pnpm 10 (`corepack enable`), and PostgreSQL 16 (local install or Docker).

```bash
pnpm install
cp .env.example .env            # local placeholders only — never commit .env

# Database (option A: Docker)
docker compose up -d postgres   # creates alvoxis_flow and alvoxis_flow_test
# (option B: an existing PostgreSQL 16 — create both databases yourself)

pnpm db:migrate                 # apply SQL migrations
pnpm db:seed                    # sync the permission catalog (idempotent)
pnpm dev                        # http://localhost:3000 → redirects to /en
```

## Environment variables

Validated with Zod in [`src/config/env.ts`](src/config/env.ts). Validation is lazy (on first server
use), so `pnpm build` does not need a database, but any server code that needs configuration fails
fast with a list of problems (values are never echoed).

| Variable                                    | Required                             | Purpose                                                                               |
| ------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`                              | yes (runtime)                        | PostgreSQL connection string. Server-only.                                            |
| `TEST_DATABASE_URL`                         | integration tests                    | Disposable DB; **its schema is dropped** by the test setup. Name must contain `test`. |
| `APP_URL`                                   | no (default `http://localhost:3000`) | Public base URL.                                                                      |
| `LOG_LEVEL`                                 | no (default `info`)                  | `fatal`…`debug`.                                                                      |
| `BETTER_AUTH_SECRET`                        | yes (runtime)                        | ≥ 32 random characters; signs sessions, encrypts 2FA data. Server-only.               |
| `TRUSTED_IP_HEADER`                         | real deployments                     | Client-IP header set by your reverse proxy (rate limiting, device list).              |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | optional                             | Enables Google sign-in (both or neither).                                             |
| `EMAIL_TRANSPORT` (+ `EMAIL_*`, `SMTP_*`)   | no (default `disabled`)              | `file` writes mails to `tmp/mail` for local development; `smtp` for real delivery.    |
| `STRIPE_SECRET_KEY`                         | for subscriptions                    | Stripe secret or restricted key; unset hides subscriptions. Previews: test keys only. |

Setup steps for Google OAuth and SMTP: [docs/auth/AUTHENTICATION.md](docs/auth/AUTHENTICATION.md).
All secrets are server-only variables and never use the `NEXT_PUBLIC_` prefix. With
`EMAIL_TRANSPORT=file`, open the newest JSON file in `tmp/mail` to follow verification and reset links.

## Database

- Schema: [`src/server/db/schema/`](src/server/db/schema). Migrations: [`drizzle/`](drizzle) (reviewed SQL, committed).
- Change the schema → `pnpm db:generate` → review the generated SQL → commit. CI fails if schema and migrations drift.
- Custom SQL (triggers, policies) uses `pnpm drizzle-kit generate --custom --name <name>`.
- `pnpm db:studio` opens Drizzle Studio.

## Testing

```bash
pnpm test               # unit tests (money, env, permissions, i18n catalog parity, formatting)
pnpm test:integration   # PostgreSQL tests: tenant isolation, authorization, constraints, audit log
pnpm build && pnpm test:e2e   # Playwright on desktop, tablet and mobile viewports
pnpm check              # format check + lint + typecheck + unit tests
pnpm docs:samples       # render the fictitious sample documents to tmp/sample-documents
```

If Playwright's bundled browser is not installed, either run `pnpm exec playwright install chromium` or
point `PLAYWRIGHT_CHROMIUM_EXECUTABLE` at an existing Chromium binary.

## Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Vercel deploys every branch as a preview; the
`production` branch (updated only through a release PR from `main`) is the production deployment.

## Project layout

```
src/
  app/                 Next.js routes ([locale]/ pages, api/health, manifest)
  components/          UI (layout shell, dashboard, primitives)
  config/env.ts        server environment schema
  features/            feature logic usable by UI (dashboard document figures, client models)
  modules/             domain modules: documents (model, services, PDF, import), counterparties,
                       products, inventory, production, payroll, analytics
  i18n/                locales, routing, request config
  lib/money/           decimal money, currencies, exchange-rate provenance
  server/              server-only code: db, auth/permissions, tenancy, audit
  proxy.ts             locale negotiation (Next.js 16 "proxy", formerly middleware)
messages/              translation catalogs (en is the source of truth)
assets/fonts/          Noto Sans for PDFs (SIL Open Font License, see OFL.txt)
drizzle/               SQL migrations
tests/                 unit, integration, e2e
```
