# Temporary test environment (Vercel Hobby + Neon Free + Mailtrap Sandbox)

A private, temporary HTTPS copy of ALVOXIS Flow for manual testing from a phone or laptop, at an
expected cost of €0. It is **not** production and must never hold real customer, invoice or bank
data: use synthetic data only (fictitious companies, `example.test` addresses, IBANs such as
`LV80BANK0000435195001` that only pass the checksum).

Nothing in this repository deploys automatically. Every step below is done by the account owner in
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
  test database or SMTP credentials.
- In Neon, use the connection string of a role and database created for this test project only.
- If a secret leaks: rotate it at the provider (Neon: reset the role password; Mailtrap: reset the
  SMTP credentials; `BETTER_AUTH_SECRET`: replace it — test users must sign in and enrol 2FA again),
  update the Vercel variable and redeploy.

## 5. Database (Neon)

1. Create a Neon project in an EU region (e.g. Frankfurt) with PostgreSQL 16 or newer.
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
   `main` (optionally add yourself as required reviewer), and add the secret
   `NEON_TEST_DATABASE_URL` there: the **direct** Neon string (host without `-pooler`, with
   `sslmode=verify-full`). A repository secret with the same name also works, without these gates.
2. Run the workflow. It refuses to start without the secret, with a non-Neon or pooled host, or
   without `sslmode`. GitHub masks the secret in logs; the scripts print only success or the
   error (a connection error can name the host, never the password).
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
5. Deploy from `main` only. Merging to `main` creates a new production deployment, so run new
   migrations (§5) before merging a PR that adds one.

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
