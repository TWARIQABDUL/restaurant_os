# Shared helpers for the db:* scripts. Sourced, not executed.
#
# Single source of truth: every value below that verification asserts on is read
# out of docker-compose.yml, so editing the compose file is enough — there is no
# second copy here to forget.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
SERVICE="postgres"

# --- read from docker-compose.yml -------------------------------------------
yaml_value() { sed -n "s/^[[:space:]]*$1:[[:space:]]*\"\{0,1\}\([^\"]*\)\"\{0,1\}[[:space:]]*$/\1/p" "$COMPOSE_FILE" | head -1; }

PG_IMAGE="$(sed -n 's|^[[:space:]]*image:[[:space:]]*\(postgres:[^[:space:]]*\).*|\1|p' "$COMPOSE_FILE" | head -1)"
PG_MAJOR="${PG_IMAGE#postgres:}"; PG_MAJOR="${PG_MAJOR%%.*}"
HOST_ADDR="$(sed -n 's|^[[:space:]]*-[[:space:]]*"\([0-9.]*\):[0-9]*:5432".*|\1|p' "$COMPOSE_FILE" | head -1)"
HOST_PORT="$(sed -n 's|^[[:space:]]*-[[:space:]]*"[0-9.]*:\([0-9]*\):5432".*|\1|p' "$COMPOSE_FILE" | head -1)"
OWNER_ROLE="$(yaml_value POSTGRES_USER)"
OWNER_PASSWORD="$(yaml_value POSTGRES_PASSWORD)"
DB_NAME="$(yaml_value POSTGRES_DB)"

# --- read from db/bootstrap/local.sql ---------------------------------------
BOOTSTRAP_FILE="$REPO_ROOT/db/bootstrap/local.sql"
APP_ROLE="$(sed -n "s|^[[:space:]]*CREATE ROLE \([a-z_]*\) LOGIN PASSWORD.*|\1|p" "$BOOTSTRAP_FILE" | head -1)"
APP_PASSWORD="$(sed -n "s|^[[:space:]]*CREATE ROLE [a-z_]* LOGIN PASSWORD '\([^']*\)'.*|\1|p" "$BOOTSTRAP_FILE" | head -1)"

for _v in PG_IMAGE PG_MAJOR HOST_ADDR HOST_PORT OWNER_ROLE OWNER_PASSWORD DB_NAME APP_ROLE APP_PASSWORD; do
    if [ -z "${!_v:-}" ]; then
        echo "FAIL: could not read $_v out of docker-compose.yml / db/bootstrap/local.sql." >&2
        echo "      Those files were edited in a way db/scripts/_lib.sh cannot parse. Fix the parser, not the guess." >&2
        exit 1
    fi
done

OWNER_URL="postgresql://${OWNER_ROLE}:${OWNER_PASSWORD}@${HOST_ADDR}:${HOST_PORT}/${DB_NAME}"
APP_URL="postgresql://${APP_ROLE}:${APP_PASSWORD}@${HOST_ADDR}:${HOST_PORT}/${DB_NAME}"

# --- output ------------------------------------------------------------------
info() { printf '  %s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }
ok()   { printf '  [ok]   %s\n' "$*"; }
bad()  { printf '  [FAIL] %s\n' "$*" >&2; }
note() { printf '  [note] %s\n' "$*"; }
die()  { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

# --- docker ------------------------------------------------------------------
compose() { ( cd "$REPO_ROOT" && docker compose -f "$COMPOSE_FILE" "$@" ); }

require_docker() {
    command -v docker >/dev/null 2>&1 || die "docker is not on PATH."
    docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) is not available. The v1 'docker-compose' binary is not supported."
    docker info >/dev/null 2>&1 || die "the docker daemon is not reachable. Start Docker and try again."
}

container_id()    { compose ps -q "$SERVICE" 2>/dev/null || true; }
container_state() { local id; id="$(container_id)"; [ -n "$id" ] && docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null || echo "absent"; }
container_health(){ local id; id="$(container_id)"; [ -n "$id" ] && docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || echo "absent"; }

# TCP reachability from THIS host, through the published port. Docker Desktop
# forwards the port from a VM, so only a connect from the host proves the
# mapping works — an in-container check would not.
host_port_open() { timeout 3 bash -c ": < /dev/tcp/${HOST_ADDR}/${HOST_PORT}" 2>/dev/null; }

# psql inside the container, but over TCP to 127.0.0.1, so password
# authentication is exercised rather than trust-on-unix-socket.
psql_as() {
    local role="$1" password="$2"; shift 2
    compose exec -T -e "PGPASSWORD=${password}" "$SERVICE" \
        psql -h 127.0.0.1 -U "$role" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"
}
scalar_as() { local role="$1" password="$2" sql="$3"; psql_as "$role" "$password" -tAc "$sql"; }
