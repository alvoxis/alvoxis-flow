#!/bin/bash
# SessionStart hook for Claude Code cloud sessions (ALVOXIS Flow).
#
# Makes the local development environment usable without manual diagnosis:
#   1. node_modules: installs with the lockfile only when missing or out of date.
#   2. PostgreSQL: leaves a running server alone; starts an existing stopped cluster; creates a
#      cluster only where none exists; creates missing local databases. It never drops, resets
#      or overwrites anything, never runs migrations or tests, and only touches localhost.
#   3. Anything ambiguous is reported as "ERROR:" and left untouched.
#
# Credentials come from the git-ignored .env (local placeholders); they are never printed.
# Paths are overridable for the hook's own test (.claude/hooks/test-session-start.sh).
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ] && [ "${ALVOXIS_HOOK_FORCE:-}" != "1" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
PG_BIN="${ALVOXIS_PG_BIN:-/usr/lib/postgresql/16/bin}"
PG_DATA="${ALVOXIS_PG_DATA:-/var/lib/postgresql/alvoxis-dev/data}"
PG_LOG="${ALVOXIS_PG_LOG:-$(dirname "$PG_DATA")/log}"
PG_PORT="${ALVOXIS_PG_PORT:-5432}"
PG_SOCKET="${ALVOXIS_PG_SOCKET:-/tmp}"
PG_OS_USER="${ALVOXIS_PG_OS_USER:-postgres}"
ENV_FILE="${ALVOXIS_ENV_FILE:-$PROJECT_DIR/.env}"
SKIP_DEPS="${ALVOXIS_HOOK_SKIP_DEPS:-0}"
E2E_DB="alvoxis_flow_e2e"

say() { echo "[session-start] $*"; }
problem() { echo "[session-start] ERROR: $*"; STATUS=1; }
STATUS=0

as_pg() {
  # Runs a command as the PostgreSQL OS user (root in cloud sessions, else as-is).
  if [ "$(id -un)" = "$PG_OS_USER" ]; then "$@"; else su "$PG_OS_USER" -s /bin/bash -c "$(printf '%q ' "$@")"; fi
}

# --- 1. Dependencies -------------------------------------------------------------------------
check_deps() {
  cd "$PROJECT_DIR" || return
  if ! command -v pnpm >/dev/null 2>&1; then
    problem "pnpm is not installed; dependencies were not checked"
    return
  fi
  local marker="node_modules/.modules.yaml"
  if [ -f "$marker" ] && [ "$marker" -nt pnpm-lock.yaml ] && [ "$marker" -nt package.json ]; then
    say "dependencies: up to date (no install)"
    return
  fi
  say "dependencies: missing or older than the lockfile -> pnpm install --frozen-lockfile"
  if ! pnpm install --frozen-lockfile --reporter=silent; then
    problem "pnpm install failed; run it manually to see the error"
  fi
}

# --- 2. PostgreSQL ---------------------------------------------------------------------------
# Reads host, port, database and password of a postgres:// URL from .env (never printed).
read_url() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 1
  python3 - "$ENV_FILE" "$key" <<'PY'
import sys, urllib.parse
path, key = sys.argv[1], sys.argv[2]
for line in open(path, encoding="utf-8"):
    line = line.strip()
    if line.startswith(key + "="):
        u = urllib.parse.urlparse(line.split("=", 1)[1].strip().strip('"').strip("'"))
        if u.scheme not in ("postgres", "postgresql"):
            sys.exit(1)
        print(u.hostname or "", u.port or 5432, u.path.lstrip("/"), urllib.parse.unquote(u.password or ""), sep="\t")
        sys.exit(0)
sys.exit(1)
PY
}

is_local() { [ "$1" = "localhost" ] || [ "$1" = "127.0.0.1" ] || [ "$1" = "::1" ]; }

server_ready() { "$PG_BIN/pg_isready" -q -h "$PG_SOCKET" -p "$PG_PORT"; }

start_cluster() {
  mkdir -p "$(dirname "$PG_LOG")"
  as_pg "$PG_BIN/pg_ctl" -D "$PG_DATA" -l "$PG_LOG" -w -t 30 -o "-p $PG_PORT -k $PG_SOCKET" start >/dev/null
}

create_cluster() {
  # Only for a data directory that does not exist or is empty; needs the local password from .env.
  local password="$1"
  local parent
  parent="$(dirname "$PG_DATA")"
  mkdir -p "$parent" && chown "$PG_OS_USER" "$parent" 2>/dev/null
  local pwfile
  pwfile="$(mktemp)" && chmod 600 "$pwfile" && printf '%s\n' "$password" >"$pwfile" && chown "$PG_OS_USER" "$pwfile" 2>/dev/null
  as_pg "$PG_BIN/initdb" -D "$PG_DATA" -U postgres --pwfile="$pwfile" --auth-local=peer --auth-host=scram-sha-256 >/dev/null
  local rc=$?
  rm -f "$pwfile"
  return $rc
}

ensure_database() {
  local name="$1"
  [[ "$name" =~ ^[a-z0-9_]+$ ]] || { problem "unexpected database name in .env; skipped"; return; }
  local exists
  exists="$(as_pg "$PG_BIN/psql" -h "$PG_SOCKET" -p "$PG_PORT" -U postgres -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '$name'")" || {
    problem "could not query databases"
    return
  }
  if [ "$exists" = "1" ]; then
    say "database $name: present"
  elif as_pg "$PG_BIN/createdb" -h "$PG_SOCKET" -p "$PG_PORT" -U postgres "$name"; then
    say "database $name: created (empty; run pnpm db:migrate && pnpm db:seed when needed)"
  else
    problem "could not create database $name"
  fi
}

check_postgres() {
  if [ ! -x "$PG_BIN/pg_ctl" ]; then
    problem "PostgreSQL 16 binaries not found in $PG_BIN; database checks skipped"
    return
  fi

  local main test password="" dbs=()
  if main="$(read_url DATABASE_URL)"; then
    IFS=$'\t' read -r host port db password <<<"$main"
    if ! is_local "$host" || [ "$port" != "$PG_PORT" ]; then
      problem "DATABASE_URL in .env is not this local server; PostgreSQL left untouched"
      return
    fi
    dbs+=("$db")
  fi
  if test="$(read_url TEST_DATABASE_URL)"; then
    IFS=$'\t' read -r host port db _ <<<"$test"
    if is_local "$host" && [ "$port" = "$PG_PORT" ]; then dbs+=("$db" "$E2E_DB"); else problem "TEST_DATABASE_URL is not local; skipped"; fi
  fi

  if server_ready; then
    say "postgres: running on port $PG_PORT (unchanged)"
  elif [ -f "$PG_DATA/PG_VERSION" ]; then
    say "postgres: stopped -> starting existing cluster $PG_DATA"
    if ! start_cluster; then
      problem "existing cluster did not start; see $PG_LOG (nothing was changed)"
      return
    fi
  elif [ -d "$PG_DATA" ] && [ -n "$(ls -A "$PG_DATA" 2>/dev/null)" ]; then
    problem "$PG_DATA is not empty but is not a PostgreSQL cluster; left untouched - inspect it manually"
    return
  elif [ -z "$password" ]; then
    problem "no cluster at $PG_DATA and no local DATABASE_URL in .env; copy .env.example to .env and set local values, then start a new session"
    return
  else
    say "postgres: no cluster yet -> creating one at $PG_DATA"
    if ! create_cluster "$password" || ! start_cluster; then
      problem "could not create or start a new cluster; see $PG_LOG"
      return
    fi
  fi

  if [ ${#dbs[@]} -eq 0 ]; then
    say "no .env database settings; databases not checked"
    return
  fi
  local name
  for name in "${dbs[@]}"; do ensure_database "$name"; done
}

if [ "$SKIP_DEPS" != "1" ]; then check_deps; fi
check_postgres
[ "$STATUS" -eq 0 ] && say "environment ready" || say "environment needs attention (see ERROR lines); the session continues"
# Never block the session; problems are reported above.
exit 0
