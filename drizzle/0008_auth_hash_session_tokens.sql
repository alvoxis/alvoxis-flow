-- Store session tokens as SHA-256 digests (see src/server/auth/session-token-store.ts). Existing
-- sessions keep working: the cookie still carries the plain token, and the app looks up its digest.
-- Idempotent: rows that already hold a digest are left alone. Not reversible by design — rolling
-- the application back to a release without hashing signs users out once (they sign in again).
UPDATE auth_sessions
SET token = 'sha256:' || translate(rtrim(encode(sha256(convert_to(token, 'UTF8')), 'base64'), '='), '+/', '-_')
WHERE token NOT LIKE 'sha256:%';
