# ALVOXIS Flow — working notes for Claude Code

Business SaaS for LV/LT/EE/PL: Next.js 16 (App Router), TypeScript strict, Drizzle + PostgreSQL 16,
Better Auth, next-intl (en, ru, lv, lt, et). Details: [README](README.md),
[architecture](docs/ARCHITECTURE.md), [auth](docs/auth/AUTHENTICATION.md),
[documents](docs/documents/DOCUMENT-SYSTEM.md), [deployment](docs/DEPLOYMENT.md).

## Standing rules (always apply, no need to repeat them in prompts)

- Never merge a PR, deploy to production or create paid services without the user's explicit
  permission for that specific action. Work on a branch, open a PR; never push to `main`.
- Never weaken branch protection, skip/disable tests or required CI checks, or rewrite history.
- Never log or print passwords, tokens, session/OAuth secrets, 2FA codes or key material.
- Real invoices and customer/bank data are confidential: never copy them into the repo, tests,
  fixtures, screenshots or logs. Use synthetic data only.
- Commit only placeholders to `.env.example`; real secrets live only in the platform's secret store.
- Tenant isolation: company data only through `requireCompanyAccess`; users via `requireUser`.

## Local environment (cloud session)

- The SessionStart hook (`.claude/hooks/session-start.sh`) prepares this at session start: runs
  `pnpm install` only when `node_modules` is missing or older than the lockfile; leaves a running
  Postgres alone, starts the existing cluster, creates a cluster only where none exists and only
  missing localhost databases. It never drops data, migrates or runs tests. Read its
  `[session-start]` lines first; `ERROR:` lines need a manual look. Its own test:
  `bash .claude/hooks/test-session-start.sh` (temp cluster on port 55432).
- Manual Postgres start: `su postgres -c "setsid /usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/alvoxis-dev/data -l /var/lib/postgresql/alvoxis-dev/log -o '-p 5432 -k /tmp' start"`
  (check with `pg_isready -h /tmp`). Databases: `alvoxis_flow` (dev), `alvoxis_flow_test`
  (integration; its schema is dropped), `alvoxis_flow_e2e` (e2e; recreate freely). New databases
  are empty: `pnpm db:migrate && pnpm db:seed` when needed.
- `.env` is git-ignored (local placeholders); `DATABASE_URL`/`TEST_DATABASE_URL` point to localhost.
- E2E browser: `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
- E2E like CI: `E2E_DATABASE_URL=<…/alvoxis_flow_e2e> CI=1`, after `pnpm db:migrate && pnpm db:seed`.

## Commands

`pnpm format:check` · `pnpm lint` · `pnpm typecheck` · `pnpm test` (unit) ·
`pnpm test:integration` · `pnpm build` · `pnpm test:e2e` · `pnpm drizzle-kit check` +
`pnpm drizzle-kit generate` (must leave `drizzle/` unchanged) · `pnpm db:migrate` · `pnpm db:seed`.
Single test: `pnpm vitest run --project integration <file> -t "<name>"`.

## Conventions

- `.tsx` files must not import `@/server/db/*` or `pg` (ESLint); load data in `src/server/**`.
- Migrations are additive SQL in `drizzle/`; custom ones via `drizzle-kit generate --custom`.
- Operator scripts that import `server-only` modules run with `--require ./scripts/support/server-only-shim.cjs`.
- New UI text needs keys in all 5 `messages/*.json` (the i18n tests enforce it).

## Running checks (efficient, never weaker)

1. While working: only the relevant tests (`vitest run <file>`, `-t`) plus `pnpm typecheck`.
2. Before each push: one full local run matching the change —
   - code: format, lint, typecheck, unit, integration, drizzle drift check;
   - UI, runtime, auth or migrations: additionally `pnpm build` and e2e (fresh e2e database);
   - docs only: `pnpm format:check`; the full suite runs in CI.
3. After pushing, confirm with CI instead of re-running unchanged suites locally.
4. A failure is fixed and the affected checks are re-run; required CI checks are never reduced.

## GitHub (MCP tools)

- For status use narrow calls: `pull_request_read` with `get_check_runs` (CI on HEAD),
  `get_review_comments`/`get_reviews` (feedback). Use `get` only when the PR body or merge
  state is actually needed. Wait for CI with notifications/one background wait, not polling.
- Update a PR description once, when the work is finished, and only if it changed.

## Reports

Use five short sections: 1) status, 2) what changed, 3) tests that passed (exact counts), 4) remaining risks or blockers, 5) next step. Do not repeat unchanged information from the previous
report; link the PR/docs instead. Never claim measured savings or results that were not measured.
