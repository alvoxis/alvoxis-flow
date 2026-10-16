#!/bin/bash
# Behaviour test for session-start.sh. Uses a throw-away cluster in a temp directory on its own
# port and socket, plus a temp .env with a fixture password, so real databases are never touched.
# Run (cloud session, as root): bash .claude/hooks/test-session-start.sh
set -uo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/session-start.sh"
PG_BIN="${ALVOXIS_PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT=55432
FIXTURE_PASSWORD="hook-test-fixture-password-not-secret"
TMP="$(mktemp -d)"
chmod 755 "$TMP"
chown postgres "$TMP"
DATA="$TMP/pg/data"
FAILS=0

cleanup() {
  [ -f "$DATA/postmaster.pid" ] && su postgres -c "$PG_BIN/pg_ctl -D $DATA -m fast stop" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

run_hook() {
  ALVOXIS_HOOK_FORCE=1 ALVOXIS_HOOK_SKIP_DEPS=1 ALVOXIS_PG_BIN="$PG_BIN" ALVOXIS_PG_DATA="$DATA" \
    ALVOXIS_PG_PORT=$PORT ALVOXIS_PG_SOCKET="$TMP" ALVOXIS_ENV_FILE="$TMP/.env" bash "$HOOK"
}
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; FAILS=$((FAILS + 1)); fi; }
sql() { su postgres -c "$PG_BIN/psql -h $TMP -p $PORT -U postgres -d $1 -Atc \"$2\""; }
oids() { sql postgres "SELECT string_agg(datname || ':' || oid, ',' ORDER BY datname) FROM pg_database WHERE datname LIKE 'alvoxis%'"; }
write_env() {
  printf 'DATABASE_URL=postgres://postgres:%s@%s:%s/alvoxis_flow\nTEST_DATABASE_URL=postgres://postgres:%s@localhost:%s/alvoxis_flow_test\n' \
    "$FIXTURE_PASSWORD" "$1" "$PORT" "$FIXTURE_PASSWORD" "$PORT" >"$TMP/.env"
}

# 1. No cluster and no .env: clear error, nothing created.
out="$(run_hook)"
check "no .env: reports an error" '[[ "$out" == *"ERROR: no cluster"* ]]'
check "no .env: creates nothing" '[ ! -e "$DATA" ]'

# 2. Non-local DATABASE_URL: refused, nothing created.
write_env db.example.com
out="$(run_hook)"
check "non-local URL: refused" '[[ "$out" == *"not this local server"* ]]'
check "non-local URL: creates nothing" '[ ! -e "$DATA" ]'

# 3. Ambiguous data directory: left untouched.
mkdir -p "$DATA" && echo keep >"$DATA/unrelated.txt" && chown -R postgres "$TMP/pg"
write_env localhost
out="$(run_hook)"
check "ambiguous directory: reported" '[[ "$out" == *"is not a PostgreSQL cluster"* ]]'
check "ambiguous directory: file kept, no cluster" '[ "$(cat "$DATA/unrelated.txt")" = keep ] && [ ! -f "$DATA/PG_VERSION" ]'
rm -rf "$TMP/pg"

# 4. No cluster with a local .env: cluster and the three databases are created.
out="$(run_hook)"
check "fresh: cluster created and running" '[ -f "$DATA/PG_VERSION" ] && "$PG_BIN/pg_isready" -q -h "$TMP" -p $PORT'
check "fresh: databases created" '[ "$(sql postgres "SELECT count(*) FROM pg_database WHERE datname IN ('"'"'alvoxis_flow'"'"','"'"'alvoxis_flow_test'"'"','"'"'alvoxis_flow_e2e'"'"')")" = 3 ]'
check "password never printed" '[[ "$out" != *"$FIXTURE_PASSWORD"* ]]'
sql alvoxis_flow "CREATE TABLE hook_marker (v text); INSERT INTO hook_marker VALUES ('kept')" >/dev/null
before="$(oids)"

# 5. Running again: nothing changes.
out="$(run_hook)"
check "rerun: server left alone" '[[ "$out" == *"running on port $PORT (unchanged)"* ]]'
check "rerun: same databases (same OIDs)" '[ "$(oids)" = "$before" ]'

# 6. Server stopped: the existing cluster is started, data preserved.
su postgres -c "$PG_BIN/pg_ctl -D $DATA -m fast stop" >/dev/null
out="$(run_hook)"
check "stopped: existing cluster started" '[[ "$out" == *"starting existing cluster"* ]] && "$PG_BIN/pg_isready" -q -h "$TMP" -p $PORT'
check "stopped: data and databases preserved" '[ "$(sql alvoxis_flow "SELECT v FROM hook_marker")" = kept ] && [ "$(oids)" = "$before" ]'

# 7. A missing database is recreated without touching the others.
sql postgres "DROP DATABASE alvoxis_flow_e2e" >/dev/null
out="$(run_hook)"
check "missing database: only that one created" '[[ "$out" == *"database alvoxis_flow_e2e: created"* ]] && [ "$(sql alvoxis_flow "SELECT v FROM hook_marker")" = kept ]'

# 8. Outside cloud sessions the hook does nothing.
check "not remote: no-op" '[ -z "$(CLAUDE_CODE_REMOTE= bash "$HOOK")" ]'

echo
if [ $FAILS -eq 0 ]; then echo "session-start hook: all checks passed"; else echo "session-start hook: $FAILS check(s) failed"; exit 1; fi
