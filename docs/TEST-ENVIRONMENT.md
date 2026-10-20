# Temporary test environment (Vercel Hobby + Neon Free + Mailtrap Sandbox)

A private, temporary HTTPS copy of ALVOXIS Flow for manual testing from a phone or laptop, at an
expected cost of €0. It is **not** production and must never hold real customer, invoice or bank
data: use synthetic data only (fictitious companies, `example.test` addresses, IBANs such as
`LV80BANK0000435195001` that only pass the checksum).

The repository has no deploy scripts, but once the Vercel project is connected (§7) Vercel deploys
it automatically: a push to the project's **production branch** creates a **production
deployment**, and every other branch and PR gets a preview deployment (see
[DEPLOYMENT.md](DEPLOYMENT.md)). Vercel's default production branch is `main`; the main ALVOXIS
Flow project uses a separate `production` branch. Every step below is done by the account owner in
the providers' dashboards; the application code is used unchanged.

| Part               | Service                     | Why                                                                    |
| ------------------ | --------------------------- | ---------------------------------------------------------------------- |
| App (Next.js, TLS) | Vercel, Hobby plan          | Builds this repository directly; HTTPS on a `*.vercel.app` domain      |
| PostgreSQL         | Neon, Free plan (EU region) | Managed Postgres; the app connects with `DATABASE_URL`                 |
| Email              | Mailtrap Email Sandbox      | Catches every message in a test inbox; nothing reaches real recipients |

## 1. Accounts (created by the owner)

1. **Vercel** (Hobby). Connect GitHub with access to `alvoxis/alvoxis-flow` only.
2. **Neon** (Free). No credit card is needed for the Free plan.
3. **Mailtrap** (free plan; Email Sandbox / Email Testing).

Use a password manager and enable two-factor sign-in on all three accounts and on GitHub.

## 2. What the application requires

The server validates its environment on first use (`src/config/env.ts`) and refuses to run
misconfigured. For a deployment that is not on `localhost` with `NODE_ENV=production` (Vercel sets
`NODE_ENV=production` for its builds and functions):

- `APP_URL` must be `https://…`;
- `TRUSTED_IP_HEADER` is required (per-client rate limits);
- `EMAIL_TRANSPORT=file` is refused; `smtp` needs `SMTP_HOST` and `EMAIL_FROM`.

Sign-up requires a verified email address (`requireEmailVerification`), so the SMTP settings are
needed before anyone can sign in. Auth rate limits are stored in the database
(`auth_rate_limits`), so they work across serverless instances.

## 3. Environment variables

Set these in Vercel → Project → Settings → Environment Variables, scoped to **Production** only
(see §4). Names are exactly those in `.env.example`; values below are descriptions, not values.

| Variable             | Value for the test environment                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`       | Neon **pooled** connection string (host contains `-pooler`), with `sslmode=verify-full` (see §5)       |
| `APP_URL`            | The production URL of the Vercel project, e.g. `https://<project-name>.vercel.app` (no trailing slash) |
| `BETTER_AUTH_SECRET` | New random value, ≥ 32 characters, generated only for this environment (see §4)                        |
| `TRUSTED_IP_HEADER`  | `x-real-ip` (see below)                                                                                |
| `EMAIL_TRANSPORT`    | `smtp`                                                                                                 |
| `EMAIL_FROM`         | A test sender, e.g. `ALVOXIS Flow Test <no-reply@example.test>`                                        |
| `SMTP_HOST`          | `sandbox.smtp.mailtrap.io`                                                                             |
| `SMTP_PORT`          | `2525` (Mailtrap also offers `25`, `465`, `587`)                                                       |
| `SMTP_SECURE`        | `false` for 2525/587 (the connection is upgraded with STARTTLS); `true` only with port 465             |
| `SMTP_USER`          | Mailtrap sandbox SMTP username                                                                         |
| `SMTP_PASSWORD`      | Mailtrap sandbox SMTP password                                                                         |
| `LOG_LEVEL`          | Optional, default `info`                                                                               |

Leave unset: `TRUSTED_PROXIES` (Vercel sends a single client address), `BETTER_AUTH_SECRETS`
(no key rotation needed), `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (Google sign-in hidden),
`EMAIL_FILE_DIR`, `TEST_DATABASE_URL`, `PDF_FONTS_DIR` (fonts ship with the build).

**Why `x-real-ip`.** Vercel documents that it overwrites `x-forwarded-for` with the public IP of the
client and does not forward external values ("to prevent IP spoofing"), and that `x-real-ip` is
identical to it. The app only accepts a single-value header without `TRUSTED_PROXIES`
(see [auth/AUTHENTICATION.md](auth/AUTHENTICATION.md#client-ip-behind-a-proxy)), and a Vercel
deployment is only reachable through Vercel's edge, which is the condition that document sets.

## 4. Handling secrets safely

- Secrets live **only** in the provider dashboards (Vercel environment variables). Never put them in
  the repository, `.env.example`, issues, PR text, screenshots or chat messages.
- Generate `BETTER_AUTH_SECRET` locally, paste it directly into Vercel, and do not reuse it anywhere
  (not the local `.env`, never a future production value):
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
  Keep it stable while testing: changing it signs everyone out and makes enrolled 2FA unreadable.
- Mark the variables as sensitive if Vercel offers it for the environment, so their values cannot be
  read back from the dashboard.
- Scope them to **Production** only. Preview deployments (one per pushed branch) then do not get the
  test database or SMTP credentials; their pages answer 500 (`Invalid server environment`), which
  is expected. A preview that should work needs its own Preview-scoped values (another database or
  Neon branch, its own secret) — never the production ones.
- In Neon, use the connection string of a role and database created for this test project only.
- If a secret leaks: rotate it at the provider (Neon: reset the role password; Mailtrap: reset the
  SMTP credentials; `BETTER_AUTH_SECRET`: replace it — test users must sign in and enrol 2FA again),
  update the Vercel variable and redeploy.

## 5. Database (Neon)

1. Create a Neon project in an EU region (e.g. Frankfurt) with PostgreSQL 16 or newer (CI tests 16
   and 18). Keep the test and production databases in separate Neon projects.
2. In **Connect**, copy two connection strings for the same database and role:
   - **pooled** (host with `-pooler`) → Vercel `DATABASE_URL` (serverless functions open many
     short connections);
   - **direct** (host without `-pooler`) → only for running migrations from your computer. Neon
     recommends direct connections for schema migrations; its pooler runs in transaction mode.
3. In both strings use `sslmode=verify-full` instead of `sslmode=require` (the `pg` driver of this
   project otherwise prints a deprecation warning and will change the meaning of `require`). A
   `channel_binding=require` parameter, if present, can be removed.
4. Apply the migrations and the permission catalog from a checkout of the `main` commit you will
   deploy, with the **direct** string. Enter it without echo, so it stays out of shell history and
   out of the local `.env` (an exported variable takes precedence over `.env`, which the scripts
   also load):

   ```sh
   read -rs DATABASE_URL && export DATABASE_URL   # paste the direct Neon string, press Enter
   pnpm db:migrate                                # applies drizzle/*.sql in one transaction
   pnpm db:seed                                   # syncs the permission catalog
   unset DATABASE_URL
   ```

   Both are idempotent and can be re-run after later merges (migrations first, then deploy). There
   is no demo-data script: test data is entered through the app (§8), synthetic only.

   Never run these commands against a production database.

5. Optional: create a Neon branch (e.g. `before-test`) right after migrating, so the database can be
   reset to an empty, migrated state later (§10).

### Without a computer: the manual GitHub Actions workflow

`.github/workflows/neon-test-migrations.yml` runs the same two commands (`pnpm db:migrate`, then
`pnpm db:seed`) on GitHub's runners, so step 4 can be done from a phone. It only starts by hand
(Actions → "Neon test database migrations" → Run workflow), only from `main`, and only after typing
`migrate-neon-test`; it never deploys.

1. In GitHub → Settings → Environments, create `neon-test`, restrict its deployment branches to
   `main` (optionally add yourself as required reviewer), and add there:
   - the secret `NEON_TEST_DATABASE_URL`: the **direct** Neon string (Connect → pooling off, host
     without `-pooler`), pasted unchanged. Neon's default `sslmode=require` is accepted and
     tightened to `sslmode=verify-full` before any connection; `verify-full` also works. Besides
     `sslmode` only `channel_binding` may appear in its query;
   - the variable `NEON_TEST_DB_HOST`: the same direct endpoint host (`ep-….neon.tech`), not a
     secret.
2. Run the workflow. Before any connection it refuses to continue unless the confirmation matches,
   the secret and the variable are set, the URL's host equals `NEON_TEST_DB_HOST` exactly, no
   pooled host is used, and `sslmode` is `require` or `verify-full` (always used as
   `verify-full`). The check is `scripts/ci/neon-test-url.ts` (tested in
   `tests/unit/neon-test-url.test.ts`). GitHub masks the secret in logs; the scripts
   print only success or the error (a connection error can name the host, never the password).
3. Use only the test project's string here, never production.

## 6. Email (Mailtrap Email Sandbox)

1. In Mailtrap, open Email Sandbox (Email Testing), use the default inbox (or create one), and open
   its **SMTP** credentials.
2. Copy host, port, username and password into the Vercel variables of §3.
3. All messages the app sends (verification, password reset, notifications) appear in that inbox and
   are not delivered to the addresses used. Use `…@example.test` addresses when signing up.

The free sandbox plan has a small monthly message limit (check the current number on Mailtrap's
pricing page). When it is used up, sign-up verification mails no longer arrive until the next period.

## 7. Vercel project

1. **Add New → Project**, import `alvoxis/alvoxis-flow`. Vercel detects Next.js and pnpm
   (`packageManager` in `package.json`); keep the default build settings. Node.js must satisfy
   `engines.node` (`>=22.12.0`): choose Node.js 22.x or newer in the project's build settings.
2. Before the first deploy, enter the variables of §3. The project name determines the production
   domain; if the domain Vercel assigns differs from `APP_URL`, correct `APP_URL` and redeploy.
3. Project → Settings → Functions: choose a function region close to the Neon database (e.g.
   Frankfurt, `fra1`). The default is Washington, D.C. (`iad1`).
4. Project → Settings → Deployment Protection: enable **Vercel Authentication** with
   **All Deployments**. "Standard Protection" leaves production domains public; "All Deployments"
   also protects the production domain and is available on all plans. Visitors then sign in to
   Vercel before they reach the app; on Hobby only the account owner (plus at most one external user)
   has access. Do not create shareable bypass links.
5. Production code always comes from `main`. Prefer a separate production branch (Settings →
   Environments → Production → Branch Tracking) that is only updated from `main` through a release
   PR; `main` and PR branches then get preview deployments only, and new migrations (§5) are run
   before the release PR is merged. If the project keeps Vercel's default (`main` as the production
   branch), merging to `main` deploys to production, so run new migrations before merging a PR that
   adds one.

## 8. Checks after deployment

Use synthetic data throughout. On a phone, also check that pages fit without horizontal scrolling.

1. **HTTPS and health:** open `https://<project>.vercel.app/api/health` (after the Vercel sign-in)
   → `200 {"status":"ok"}`. `503` with `database: "unavailable"` or `"not_configured"` → §11.
   The browser shows a valid certificate; `http://` redirects to `https://`.
2. **Sign-up:** register with `tester1@example.test` and a 12+ character password; the
   verification email arrives in Mailtrap; the link opens the app on `APP_URL` and verifies the
   address.
3. **Sign-in / sign-out**, and "forgot password" (the reset mail arrives in Mailtrap).
4. **2FA:** enable TOTP in the account settings with an authenticator app, store the recovery
   codes, sign out and in again with a code. Owners and administrators must have 2FA to work in a
   company (`ROLES_REQUIRING_2FA`).
5. **Company:** create a fictitious company and complete the seller profile (fictitious legal
   name, registration and VAT numbers, address).
6. **Tax categories:** add a category with values agreed for testing (the app supplies none); edit
   its label; archive and restore one.
7. **Bank accounts:** add two accounts with checksum-valid fictitious IBANs (e.g.
   `LV80BANK0000435195001`, `LT121000011101001000`); try an invalid IBAN (expect an error); set a
   default; archive one.
8. **Document:** New document → invoice, currency, buyer, the default bank account preselected;
   add lines with a tax category; save; issue; the number is assigned and the page is read-only.
9. **PDF:** open and download the PDF of the draft (watermark "not issued", no number) and of the
   issued invoice (number, seller and bank details as issued). Edit the bank account afterwards:
   the issued PDF does not change.

## 9. Free-tier limits and when a paid plan is needed

Figures as published by the providers at the time of writing; check their pricing pages before
relying on them.

- **Vercel Hobby:** personal, **non-commercial** use only (Vercel's fair-use guidelines); Vercel may
  disable Hobby projects at its discretion. Functions run at most 300 s; about 4 h of active CPU
  and 360 GB-h of provisioned memory per month are included. Usage over a limit pauses the feature
  until the 30-day period ends — there is no bill and no option to buy more on Hobby. Password
  protection is a paid add-on (not needed: Vercel Authentication is used).
- **Neon Free:** 1 GB storage per project, 100 compute-unit hours per project per month, up to
  10 branches; compute scales to zero after 5 minutes idle, so the first request after a pause is
  slower. It is meant here for synthetic test data only, not as a backed-up production database.
- **Mailtrap sandbox:** one inbox and a small monthly message quota on the free plan; mail is never
  delivered to real recipients (which is the point for testing).

A paid plan, or a different setup, is required for: any commercial use or real customers (Vercel
Pro or other hosting), a production database with backups and point-in-time recovery
(see [DEPLOYMENT.md](DEPLOYMENT.md)), real email delivery from a verified sending domain (SPF, DKIM,
DMARC), more testers than Hobby's access protection allows, or usage above the quotas above.
Moving to paid services needs a separate decision; nothing here creates one.

## 10. Cleaning up test data

- **Reset the database:** in Neon, restore the database branch to the `before-test` state (Neon's
  branch restore), or delete the project and repeat §5. Neon also allows deleting the whole project when testing ends.
- **Mailtrap:** clean the sandbox inbox; delete it or reset its credentials when done.
- **Vercel:** remove the environment variables and delete the project (this removes the
  `*.vercel.app` deployments), or at least keep Deployment Protection on.
- **Locally:** nothing to clean — the test secrets were never written to `.env` or the repository.

## 11. When a deployment fails

| Symptom                                                  | Where to look / what to do                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Build fails                                              | Vercel build log. The same `pnpm build` runs in CI on every PR; compare with the last green CI run of that commit.                               |
| Pages answer 500, log shows `Invalid server environment` | The log lists variable names and the rule (never the values). Fix the variable in Vercel and redeploy (variables apply to new deployments only). |
| `/api/health` → `503 database: "unavailable"`            | Wrong or paused Neon string, `sslmode`, or Neon quota used up. Check the string (pooled host), Neon's project status and usage.                  |
| Errors about missing tables or columns                   | Migrations were not applied to this database: run §5 step 4 for the deployed commit.                                                             |
| No verification email                                    | `EMAIL_TRANSPORT`, `SMTP_*`, `EMAIL_FROM`; Mailtrap quota; function logs show `[mailer] SMTP delivery … failed`.                                 |
| Links in emails point to the wrong host / sign-in loops  | `APP_URL` does not match the domain in the browser.                                                                                              |
| Sign-in limited for everyone at once                     | `TRUSTED_IP_HEADER` missing or wrong (all visitors share one rate-limit bucket).                                                                 |

To go back, make the previous successful deployment the production deployment again in the Vercel
dashboard (Vercel's rollback), or redeploy an earlier commit. Migrations are additive and backward
compatible ([DEPLOYMENT.md](DEPLOYMENT.md#release-procedure-target)), so the previous app version
runs on the migrated schema; schema changes are never rolled back by hand.

## 12. Test Mode on preview deployments (the `alvoxis-flow` project)

The project `alvoxis-flow` has a production deployment with its own database; all its environment
variables are scoped to **Production**. Preview deployments (every branch and PR, including
`main`) get **their own** values, scoped to **Preview**, pointing to the separate Neon project
`alvoxis-flow-test`. Until they exist a preview answers `503` on `/api/health` with
`"database":"not_configured"` — safe: it cannot reach any database.

### What the application enforces on a preview (`VERCEL_ENV=preview`)

The server refuses to start (pages answer 500, `/api/health` lists only the variable **names**)
unless:

- `PREVIEW_DATABASE_HOST` is set and `DATABASE_URL` points to exactly that host (the pooled and
  the direct host of one Neon endpoint count as the same). A production connection string copied
  into Preview by mistake is therefore refused, not used;
- `APP_URL`, when set, is this preview's own URL (`VERCEL_BRANCH_URL` or `VERCEL_URL`) and never
  the production domain (`VERCEL_PROJECT_PRODUCTION_URL`). When `APP_URL` is **not** set, the
  branch URL is used, so every branch's preview has the right sign-in origin and email links;
- with `EMAIL_TRANSPORT=smtp`, `SMTP_HOST` is an email sandbox (`sandbox.smtp.mailtrap.io`), so
  a preview can never email real people.

Every page shows the yellow **"Test environment"** banner on a preview (or with `APP_TEST_MODE=1`;
never on production). The banner is the only thing "test mode" changes: authentication, email
verification, 2FA for owners/administrators, roles and company isolation work exactly as in
production. There is no test account, no shared password and no bypass.

### Neon (test project `alvoxis-flow-test`)

- Branch `main`: the clean, migrated baseline (13 migrations, permission catalog, no data).
- Branch `before-test`, child of `main`: the **working** database of the previews. It can be
  returned to the clean baseline with Neon's "Reset from parent" when a test round is over.
- Never branch the production project: a Neon branch copies its data.

### Steps for the owner

1. **Neon → `alvoxis-flow-test` → branch `before-test` → Connect** (database `neondb`, role
   `neondb_owner`):
   - copy the **pooled** connection string (host with `-pooler`) for Vercel;
   - note the host of the **direct** string (pooling off, `ep-….neon.tech`, no `-pooler`), it is
     not a secret.
     In both strings use `sslmode=verify-full` (replace `require`); `channel_binding` may be removed.
2. **Vercel → Project `alvoxis-flow` → Settings → Environment Variables → Add**, for each row:
   environment **Preview only** (untick Production and Development), all branches. Mark the secrets
   **Sensitive**. Never copy or change a Production value.

   | Variable                | Value                                                       |
   | ----------------------- | ----------------------------------------------------------- |
   | `DATABASE_URL`          | pooled string of `before-test` (secret)                     |
   | `PREVIEW_DATABASE_HOST` | the `before-test` endpoint host (direct form, not a secret) |
   | `BETTER_AUTH_SECRET`    | a **new** random value (§4), used nowhere else (secret)     |
   | `TRUSTED_IP_HEADER`     | `x-real-ip`                                                 |
   | `EMAIL_TRANSPORT`       | `smtp`                                                      |
   | `EMAIL_FROM`            | `ALVOXIS Flow Test <no-reply@example.test>`                 |
   | `SMTP_HOST`             | `sandbox.smtp.mailtrap.io`                                  |
   | `SMTP_PORT`             | `2525`                                                      |
   | `SMTP_SECURE`           | `false`                                                     |
   | `SMTP_USER`             | Mailtrap Email Sandbox inbox user (secret)                  |
   | `SMTP_PASSWORD`         | Mailtrap Email Sandbox inbox password (secret)              |

   Do **not** add `APP_URL` for Preview. On a preview the server uses the branch URL Vercel
   provides (`VERCEL_BRANCH_URL`), so every branch's preview gets its own sign-in origin; one
   `APP_URL` for all previews would be wrong for every branch but one, and the server refuses an
   `APP_URL` that is not the preview's own URL. `/api/health` lists `APP_URL` only if Vercel gave
   no branch URL ("Automatically expose System Environment Variables" switched off). Open the
   preview through its **branch URL**; sign-in from a per-deployment URL
   (`alvoxis-flow-<hash>-alvoxis1.vercel.app`) is refused as a foreign origin.

   Sign-up needs the verification email, so the sandbox inbox (§6) is required to create test
   users. Use the **Email Sandbox** SMTP credentials (`sandbox.smtp.mailtrap.io`); the server
   refuses any other SMTP host on a preview, including Mailtrap's real sending host.

3. **GitHub → Settings → Environments → `neon-test`** (create it if missing):
   - Deployment branches and tags → **Selected branches and tags** → add `main`;
   - optionally **Required reviewers** → yourself (every run then waits for your approval);
   - Environment secrets → `NEON_TEST_DATABASE_URL` = the **direct** string of `before-test`;
   - Environment variables → `NEON_TEST_DB_HOST` = its direct host.

   Only the two manual workflows that declare `environment: neon-test` (migrations, test data)
   can read them; both refuse a URL whose host is not `NEON_TEST_DB_HOST`.

4. **Vercel → Deployments →** the latest deployment of the branch to test (`main`, or a pull
   request's branch) **→ ⋯ → Redeploy** (variables apply to new deployments only), then open
   `https://alvoxis-flow-git-<branch>-alvoxis1.vercel.app/api/health` → `200 {"status":"ok"}`.
   While something is missing it answers `503` and lists only the **names** of the variables to
   fix. These steps need the code of this section on that branch (the preview checks and the
   branch URL); older code requires `APP_URL` instead.

The Neon branch name plays no part in any of this: connection strings and hosts contain the
endpoint id (`ep-…`), not the branch name, so renaming the branch changes nothing here.

### Proving the preview uses the test database

Sign up on the preview with an `…@example.test` address (verification mail in Mailtrap), enable
2FA, create a company `Preview Proof SIA`. Neon → `alvoxis-flow-test` → `before-test` → Tables →
`companies` must show it. The production project is not opened for this check.

### Synthetic test data (optional, repeatable)

GitHub → Actions → **"Neon test database — synthetic test data"** → Run workflow (from `main`),
confirmation `seed-neon-test-data`, `owner_email` = an existing test user (`…@example.test`).
It adds two fictitious companies of that owner (31 and 3 documents: EUR and PLN invoices, drafts,
a proforma, a delivery note, a full and a partial credit note) through the regular services, so
every business rule applies. Running it again changes nothing. It refuses any host other than
`NEON_TEST_DB_HOST`, non-`@example.test` owners and users that do not exist. Locally:
`pnpm db:test-data` with `TEST_DATA_CONFIRM`, `TEST_DATA_DB_HOST`, `TEST_DATA_OWNER_EMAIL`
(`scripts/seed-test-data.ts`).

### Repeatable test round

1. Optional reset: Neon → `before-test` → **Reset from parent** (back to the clean baseline; all
   test users and data are deleted).
2. Sign up `tester1@example.test` and `tester2@example.test`; enable 2FA for both.
3. Optional: run the test-data workflow for `tester1@example.test`.
4. Follow §8 with synthetic data, then: search, filters, sorting and paging; a full and a partial
   credit note and the links between invoice and credit note; PDF import of an app-generated sample
   PDF (`pnpm docs:samples <dir> en`), never a real invoice. `tester2` must not see `tester1`'s
   companies or documents (open a copied document URL: 404).
5. Phone checks: the menu, the dashboard and the documents list, portrait and landscape.

Roles other than owner cannot be assigned in the app yet (no invitations), so they are covered by
the automated tests only.

## Sources

- Vercel: [Hobby plan](https://vercel.com/docs/plans/hobby),
  [fair use](https://vercel.com/docs/limits/fair-use-guidelines),
  [Deployment Protection](https://vercel.com/docs/deployment-protection),
  [Vercel Authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication),
  [request headers](https://vercel.com/docs/headers/request-headers),
  [function regions](https://vercel.com/docs/functions/configuring-functions/region).
- Neon: [plans](https://neon.com/docs/introduction/plans),
  [connection pooling](https://neon.com/docs/connect/connection-pooling).
- Mailtrap: [Email Sandbox setup](https://docs.mailtrap.io/email-sandbox/setup),
  [pricing](https://mailtrap.io/pricing/).
