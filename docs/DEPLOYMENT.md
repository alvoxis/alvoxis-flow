# Deployment and recovery

The repository has no deploy scripts, but the Vercel project `alvoxis-flow` is connected to it
through Vercel's Git integration, which deploys it automatically:

- every push to the **production branch** creates a **production deployment**. With Vercel's
  default configuration that branch is `main`, so **merging a PR to `main` deploys it to
  production**. The branch is set in Vercel → Project → Settings → Environments → Production →
  Branch Tracking;
- every other branch and every pull request gets a **preview deployment** (the Vercel bot links it
  on the PR). Preview deployments use only variables scoped to Preview.

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
- Secrets are stored in the hosting platform's secret manager, never in the repository.

## Release procedure (target)

1. CI green on the PR (format, lint, typecheck, unit, integration, build, e2e, migration drift check).
2. Take/verify a database snapshot.
3. Apply migrations: `pnpm db:migrate` (migrations run in a transaction; Drizzle records applied ones
   in `drizzle.__drizzle_migrations`).
4. Deploy the application; check `GET /api/health` returns `200 {"status":"ok"}`.

While `main` is Vercel's production branch, merging to `main` **is** step 4: steps 2–3 must
happen before a PR with a migration is merged. With a separate production branch, merging to `main`
only creates a preview deployment, and production is deployed by updating that branch.

Migrations must be **backward compatible with the previously deployed version** (expand → migrate data →
contract over separate releases), so the application can be rolled back without rolling back the schema.

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
