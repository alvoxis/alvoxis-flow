# Deployment and recovery

The repository has no deploy scripts, but the Vercel project `alvoxis-flow` is connected to it
through Vercel's Git integration, which deploys it automatically:

- every push to the **production branch** creates a **production deployment**. In this project the
  production branch is **`production`** (Vercel → Project → Settings → Environments → Production →
  Branch Tracking; Vercel's default would be `main`). The `production` branch is protected and is
  only updated through a release PR from `main`;
- every other branch, **including `main`**, and every pull request gets a **preview deployment**
  (the Vercel bot links it on the PR). Merging a PR to `main` therefore does **not** change
  production. Preview deployments use only variables scoped to Preview.

Environment variables apply only to deployments created after they change: after editing one,
redeploy. This document records the intended process; it will be finalised (and tested) in the
infrastructure stage before any commercial launch.

For a temporary, private test copy on free tiers (synthetic data only), see
[TEST-ENVIRONMENT.md](TEST-ENVIRONMENT.md).

## Build artefact

`pnpm build` produces a Next.js **standalone** server in `.next/standalone` (plus `.next/static` and
`public/`). It runs with `node server.js` on any Node 22 host or container. A platform such as Vercel
can also build the repository directly.

## Required configuration (production)

- `DATABASE_URL` — managed PostgreSQL (16 or newer) with TLS, automated backups and point-in-time
  recovery (PITR). CI tests PostgreSQL 16 (`ci.yml`) and 18 (`node24.yml`); the current Neon
  production project runs 18.
- `APP_URL` — public HTTPS origin.
- `BETTER_AUTH_SECRET` — ≥ 32 random characters, kept stable (rotating it signs everyone out and makes
  enrolled 2FA unreadable).
- `TRUSTED_IP_HEADER` — the client-IP header set by the reverse proxy, plus `TRUSTED_PROXIES` (proxy
  CIDRs) when the proxy appends to it. The app must only be reachable through that proxy.
- `EMAIL_TRANSPORT=smtp` with `EMAIL_FROM` and `SMTP_*`; optionally `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`.
  Details and the operator 2FA-reset procedure: [auth/AUTHENTICATION.md](auth/AUTHENTICATION.md).
- `STRIPE_SECRET_KEY` for subscriptions: a **restricted key** (`rk_live_…`) is enough. It needs
  write access to Customers, Checkout Sessions, Customer portal and Subscriptions (cancel at period
  end / resume), and read access to Prices and Invoices. In the same Stripe mode create:
  - one recurring price with the lookup key **`alvoxis_flow_monthly`**: **€9.99 per month** (999
    EUR cents, monthly, no trial). Checkout refuses a price with any other amount, currency or
    interval, so a misconfigured price never charges a customer;
  - a customer-portal configuration;
  - a webhook endpoint `https://<APP_URL host>/api/billing/webhook` with the events
    `checkout.session.completed`, `customer.subscription.created`, `…updated`, `…deleted`,
    `…paused`, `…resumed`, `invoice.paid`, `invoice.payment_failed` and
    `invoice.payment_action_required`. Its signing secret goes into `STRIPE_WEBHOOK_SECRET`.
    Events are verified (HMAC, 5-minute tolerance), stored once in `billing_events` (idempotent)
    and the subscription is re-read from Stripe, so retries and out-of-order delivery are safe.
- `SUBSCRIPTION_ENFORCEMENT` — defaults to on whenever `STRIPE_SECRET_KEY` is set: companies
  without an active (or past-due) subscription become read-only (API answers `402`). Set `off` to
  keep everything open, e.g. on a preview without Stripe.
- `ANTHROPIC_API_KEY` for the AI assistant (optional `ANTHROPIC_MODEL`, default `claude-opus-5-5`;
  `AI_MONTHLY_REQUESTS_PER_COMPANY`, default 300). Without the key the assistant says it is not
  configured. Requests and token counts are recorded in `ai_usage`; questions and answers are not.
- `CONTACT_EMAIL` — the address shown on the public contact page (no address is invented when it is
  unset). The legal pages are **drafts** and must be reviewed by a lawyer before launch.
- Operator access: `pnpm admin:grant --email <email> --operator "<name>" --reason "<ticket>"`
  (run with the production `DATABASE_URL`; `--revoke` removes it). The operator area
  `/[locale]/admin` also requires 2FA on the account and a 2FA-verified session; all actions are
  audited.
- Secrets are stored in the hosting platform's secret manager, never in the repository.

## Release procedure (target)

1. Feature PRs are merged to `main` with CI green (format, lint, typecheck, unit, integration, build,
   e2e, migration drift check). This creates a preview deployment only.
2. Open a release PR `main` → `production`, check exactly what it brings (it contains everything
   merged to `main` since the last release) and wait for CI.
3. Take/verify a database snapshot.
4. If the release contains migrations, apply them **before** merging the release PR: run the
   production migration workflow (below), which runs `pnpm db:migrate` (one transaction; Drizzle
   records applied migrations in `drizzle.__drizzle_migrations`).
5. Merge the release PR: Vercel creates the production deployment. Check `GET /api/health` returns
   `200 {"status":"ok"}`.
6. Rollback: promote the previous production deployment in Vercel (the schema stays, see below).

Migrations must be **backward compatible with the previously deployed version** (expand → migrate data →
contract over separate releases), so the application can be rolled back without rolling back the schema.

## Production database migrations without a terminal

`.github/workflows/neon-production-migrations.yml` runs `pnpm db:migrate` against the Neon
production project from GitHub's runners; `pnpm db:seed` (the idempotent permission catalog sync)
runs in the same run only when the input `run_seed` is set to true (default false). It is the same
checked workflow as the test one ([TEST-ENVIRONMENT.md](TEST-ENVIRONMENT.md)) with its own names:

- GitHub environment `neon-production` (restrict deployment branches to `main`; the workflow runs
  from `main`, which already contains the migrations of the release PR);
- secret `NEON_PRODUCTION_DATABASE_URL`: the **direct** Neon string (Connect → pooling off),
  pasted unchanged (`sslmode=require` is tightened to `verify-full`);
- variable `NEON_PRODUCTION_DB_HOST`: that direct endpoint host (`ep-….neon.tech`), not a secret;
- run it from `main` with the confirmation `migrate-neon-production`.

It refuses to start if the host is not exactly `NEON_PRODUCTION_DB_HOST`, is pooled, or carries
other query parameters; drizzle applies only the migrations not yet recorded, in one transaction,
so a re-run changes nothing. The app itself uses the **pooled** string in Vercel's `DATABASE_URL`.

## Diagnosing configuration

`GET /api/health` answers `503 {"database":"not_configured","invalid":[…]}` when the server
environment fails validation; `invalid` lists only the variable **names** to fix (never values).
`"database":"unavailable"` means the configuration is valid but the database does not answer.

## Rollback and recovery

- Application: redeploy the previous build.
- Database: forward-fix migrations are preferred. For data loss/corruption, restore via PITR to a new
  instance, verify, then switch `DATABASE_URL`. Restore drills must be performed and documented before
  launch.
- Before every migration run, in addition to the platform snapshot:
  `pg_dump -Fc -d "$DATABASE_URL" -f pre-release.dump` (keep it encrypted, with the release).
  Restore into a **new** database: `createdb <new> && pg_restore -d <new> pre-release.dump`, check row
  counts and `drizzle.__drizzle_migrations`, then switch `DATABASE_URL`. A failed `pnpm db:migrate`
  needs no restore — it runs in one transaction and leaves the schema unchanged (tested).
- `audit_logs` is append-only by design; it is never modified during recovery.

## Health checks

`GET /api/health` → `200` when configuration is valid and the database answers, otherwise `503` with
`database: "not_configured" | "unavailable"`. No connection details are exposed.
