# Authentication and sessions

Stage 2. Email/password and Google sign-in, email verification, password reset, database sessions
with a devices page, TOTP two-factor authentication (mandatory for owners and admins), rate limiting
and security audit events.

## Library decision: Better Auth 1.7

| Requirement                               | Better Auth 1.7                                        | Auth.js v5 (NextAuth)                                     | Lucia / hand-rolled                    |
| ----------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------- |
| Email + password, verification, reset     | Built in; reset/verification tokens stored hashed      | Credentials provider only; reset and verification are DIY | DIY (Lucia is deprecated as a library) |
| Google OAuth/OIDC (state, PKCE, redirect) | Built in                                               | Built in                                                  | Via `arctic`; DIY wiring               |
| Database sessions, list / revoke          | Built in (we use our own service on the same table)    | DB sessions not available with the Credentials provider   | DIY                                    |
| TOTP 2FA + recovery codes                 | `twoFactor` plugin (encrypted secret, account lockout) | Not provided                                              | DIY                                    |
| Rate limiting                             | Built in, per path, database storage                   | Not provided                                              | DIY                                    |
| Drizzle + PostgreSQL                      | Official adapter; our own schema and migrations        | Adapter available                                         | —                                      |
| Maintenance                               | Active, frequent security releases                     | Active, v5 still beta-labelled for a long time            | —                                      |

Better Auth covers every requirement with audited, maintained code, while Auth.js would leave
password reset, verification, 2FA and rate limiting to us. Its known gaps were found during the audit
and are closed in this repository (next section) and covered by integration tests.

## Gaps in the library and how they are closed

| Gap (Better Auth 1.7.10)                                                              | Mitigation                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The 2FA plugin only intercepts `/sign-in/email` — **Google sign-in would bypass 2FA** | Each session carries `two_factor_verified_at`. `requireUser` rejects a session of a 2FA user without it (`two_factor_challenge_required`); the user completes a step-up challenge. |
| TOTP codes can be replayed within their validity window                               | `two_factor_used_codes`: an HMAC of (user, code) is claimed atomically before verification; a second use fails with `CODE_ALREADY_USED`.                                           |
| Recovery codes are stored in plain text by default                                    | `storeBackupCodes: "encrypted"`.                                                                                                                                                   |
| "Trust this device" skips 2FA for 30 days                                             | `trustDevice` is forced to `false` on every verification.                                                                                                                          |
| Owners/admins can switch 2FA off                                                      | `/two-factor/disable` is refused when the user holds a role that requires 2FA (`TWO_FACTOR_REQUIRED_FOR_ROLE`).                                                                    |
| Rate limiting is production-only and in memory by default                             | Enabled in every environment, stored in `auth_rate_limits` (shared by all instances).                                                                                              |
| Without a client IP all visitors share one rate-limit bucket                          | `TRUSTED_IP_HEADER` is required for real deployments (env validation fails otherwise).                                                                                             |
| Built-in `/list-sessions`, `/revoke-*`, OTP-by-email and `/delete-user` endpoints     | Disabled. Session management goes through our own server actions, which check ownership in SQL.                                                                                    |

## Architecture

```
Browser ── /api/auth/*  (Better Auth handler: sign-in/up, verify, reset, OAuth, 2FA)
   │        └─ hooks in src/server/auth/auth.ts: replay guard, 2FA policy, session 2FA flag, audit, emails
   │
   ├─ pages/actions/API ── requireUser()  (src/server/auth/session.ts)
   │                          ├─ session valid and not expired, user not disabled
   │                          └─ 2FA-enabled user ⇒ session must be 2FA-verified
   │                      ── requireCompanyAccess()  (unchanged from stage 1)
   │                          └─ membership active, company not archived, role 2FA requirement, permissions
   └─ proxy.ts: locale only — no auth decisions at the edge
```

- **Server enforcement only.** UI checks are convenience; `requireUser` and `requireCompanyAccess` run
  on every page load, server action and API route. A disabled user's sessions are deleted on their
  next request; new sessions for disabled users are refused in `session.create.before`.
- **Owners/admins without 2FA** can sign in and reach their account pages (to enrol), but every
  company operation fails with `two_factor_enrollment_required` until enrolment completes. This
  enforces the requirement without locking out the only owner.
- **Enrolment** becomes active only after the first TOTP code is verified. Completing it marks the
  current session verified and signs out all other sessions.
- **Mail** goes through `src/server/notifications/mailer.ts` (`disabled` | `file` | `smtp`). With
  `disabled` the UI states that email is not configured; nothing pretends to have been sent.
- **Google**: the button is shown only when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.
  Better Auth handles state, PKCE and the callback; secrets never leave the server.

### Security policy

| Item               | Value                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Password hashing   | scrypt (N=16384, r=16, p=1, 64-byte key, random salt) via `node:crypto` — OWASP-acceptable; Argon2id would add a native dependency |
| Password length    | 12–128 characters                                                                                                                  |
| Session cookie     | `alvoxis.session_token`, HttpOnly, SameSite=Lax, Secure (and `__Secure-` prefix) on HTTPS; no client-side cookie cache             |
| Session lifetime   | 7 days, extended at most once per hour of activity                                                                                 |
| Reset token        | 1 hour, single use, stored hashed; all sessions revoked after reset                                                                |
| Verification token | 24 hours, stored hashed                                                                                                            |
| Password change    | Always revokes all other sessions                                                                                                  |
| Enumeration        | Sign-up and reset requests answer identically for known and unknown addresses (an email goes to the existing account owner)        |
| 2FA                | TOTP (RFC 6238, 30 s), 10 encrypted single-use recovery codes, replay guard, account lockout after 10 failures (15 min)            |
| CSRF               | Better Auth origin checks on `/api/auth/*`; server actions use Next.js origin checks; SameSite=Lax cookies                         |

Rate limits (per client IP, per window): sign-in 5/min, sign-up 5/5 min, reset request 3/5 min,
reset 5/5 min, resend verification 3/5 min, 2FA verification 5/min, change password 5/5 min.

### Audit events

Written to `audit_logs` (company `null`), never containing passwords, tokens, codes or secrets:
`auth.session_created`, `auth.sign_in_failed`, `auth.sign_in_two_factor_pending`, `auth.sign_up_existing_email`,
`auth.email_verified`, `auth.password_reset_completed`, `auth.password_changed`,
`auth.session_revoked`, `auth.other_sessions_revoked`, `auth.two_factor_enrollment_started`,
`auth.two_factor_enabled`, `auth.two_factor_verified`, `auth.two_factor_failed`,
`auth.two_factor_recovery_code_used`, `auth.two_factor_code_replay_blocked`,
`auth.two_factor_recovery_codes_regenerated`, `auth.two_factor_disabled`,
`auth.two_factor_reset_by_operator`.

## Database

Migrations `drizzle/0005_auth.sql` (additive: `auth_sessions`, `auth_accounts`, `auth_verifications`,
`two_factors`, `auth_rate_limits`, `two_factor_used_codes`; `users.email_verified`, `users.image`) and
`drizzle/0006_auth_email_verified_sync.sql` (backfills `email_verified` from the existing
`email_verified_at` and keeps both in sync with a trigger). Nothing existing is dropped or renamed.

## Environment variables

| Variable                                                 | Required                   | Notes                                                                                                                                                                                                    |
| -------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                                     | yes                        | ≥ 32 random characters (`openssl rand -base64 48`). Signs cookies, encrypts 2FA secrets and recovery codes. Rotating it invalidates sessions and **makes enrolled 2FA unreadable** — see recovery below. |
| `APP_URL`                                                | yes in production          | Public origin; must be `https://` for real deployments. Used for links and OAuth redirects.                                                                                                              |
| `TRUSTED_IP_HEADER`                                      | yes for real deployments   | Header your reverse proxy sets with the client IP, e.g. `x-forwarded-for` or `cf-connecting-ip`. Only set it when a trusted proxy overwrites it.                                                         |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`               | optional (both or neither) | Enables Google sign-in.                                                                                                                                                                                  |
| `EMAIL_TRANSPORT`                                        | no (default `disabled`)    | `smtp` for real delivery; `file` for development/tests only (refused for real deployments).                                                                                                              |
| `EMAIL_FROM`, `SMTP_HOST`                                | with `smtp`                | e.g. `ALVOXIS Flow <no-reply@your-domain>`.                                                                                                                                                              |
| `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` | with `smtp`                | 587 + `false` (STARTTLS) or 465 + `true`.                                                                                                                                                                |
| `EMAIL_FILE_DIR`                                         | with `file`                | Default `tmp/mail` (git-ignored).                                                                                                                                                                        |

## Manual setup

### Google sign-in

1. Google Cloud Console → APIs & Services → **OAuth consent screen**: choose External, app name
   "ALVOXIS Flow", support email, scopes `openid`, `email`, `profile`. Publish (or add test users).
2. **Credentials → Create credentials → OAuth client ID** → Web application.
3. Authorized JavaScript origin: `${APP_URL}` (e.g. `https://app.example.com`; `http://localhost:3000`
   for development).
4. Authorized redirect URI: **`${APP_URL}/api/auth/callback/google`**.
5. Put the client ID and secret into the hosting platform's secret manager as `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`. Never commit them. Restart the app; the Google button appears.

A Google account is linked to an existing user only when Google reports the address as verified **and**
the local account's address is already verified (library default `requireLocalEmailVerified`), which
prevents pre-registration account takeover.

### Email (SMTP)

Use any transactional provider with SMTP (e.g. a provider's EU region). Verify the sending domain
(SPF, DKIM, DMARC), then set `EMAIL_TRANSPORT=smtp`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`,
`SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`. Without email, users cannot verify their address or reset
passwords, and the UI says so.

## Operator procedure: user lost the authenticator and all recovery codes

1. Verify the person's identity out of band (e.g. a call-back to the company's registered contact).
   Record the ticket.
2. Run against the production database:
   `DATABASE_URL=… pnpm auth:reset-2fa user@example.com "TICKET-123 identity verified by <name>"`
3. The script removes the TOTP secret and recovery codes, revokes all the user's sessions and writes
   `auth.two_factor_reset_by_operator` to the audit log. Owners/admins must enrol again before any
   company data is accessible.

If `BETTER_AUTH_SECRET` is lost or rotated, enrolled users cannot complete 2FA: reset each affected
user with the same procedure.

## Rollback

- Application: redeploy the previous build. The stage 2 migrations are additive, so the previous
  version runs against the new schema.
- Schema: no down-migration is needed. If one is ever required, drop the six `auth_*`/`two_factor*`
  tables, the trigger `users_sync_email_verified_at` and its function, and the columns
  `users.email_verified` and `users.image` — after a snapshot.

## Residual risks and limitations

- Session tokens are stored unhashed in `auth_sessions` (library behaviour). A database read leak would
  expose live sessions; mitigated by DB access control, TLS and short-ish lifetimes. Revisit when the
  library supports hashed session tokens.
- Rate limiting is per IP. There is no per-account sign-in lockout for passwords (2FA has one);
  distributed guessing against one account is limited only by the 12-character minimum and scrypt.
- `TRUSTED_IP_HEADER` must only name a header that the proxy overwrites; otherwise clients can spoof
  their IP and evade rate limits.
- No breached-password check (e.g. HIBP k-anonymity) yet.
- The new-sign-in email does not include geolocation.
- `pnpm audit` (2026-10-16) reports two advisories, neither in the application runtime:
  a moderate esbuild (≤ 0.24.2) dev-server issue through `drizzle-kit` (the app never runs esbuild's
  dev server), and a high `braces` stack-exhaustion DoS through `eslint-config-next` (lint-time only,
  repository-controlled glob patterns; no patched version published yet). Better Auth, nodemailer and
  uqr have no open advisories.
- Translations of the new screens are machine-quality and need native-speaker review before launch.
