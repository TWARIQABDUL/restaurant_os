#!/usr/bin/env bash
#
# Destroy the local database volume and rebuild from nothing: this is what
# re-runs db/bootstrap/local.sql, which Postgres only executes on an empty data
# directory.
#
#   npm run db:reset          asks for confirmation
#   npm run db:reset -- -y    doesn't (what CI uses, via DB_RESET_YES=1 too)
#
# Confirmation is required rather than assumed: the same command run against a
# DATABASE_URL pointing somewhere real is the kind of accident that only needs
# to happen once. It refuses outright when there is no terminal to ask.

. "$(dirname "$0")/_lib.sh"

ASSUME_YES="${DB_RESET_YES:-0}"
for arg in "$@"; do
    case "$arg" in
        -y|--yes) ASSUME_YES=1 ;;
        *) die "unknown argument: $arg (accepts -y / --yes)" ;;
    esac
done

require_docker

step "This DESTROYS the local database"
info "volume  : vendlyfy_pgdata (all local data, gone)"
info "target  : ${HOST_ADDR}:${HOST_PORT}/${DB_NAME}"
info "rebuilds: an empty database with db/bootstrap/local.sql applied"

if [ "$ASSUME_YES" != "1" ]; then
    [ -t 0 ] || die "refusing to reset without a terminal to confirm at. Pass -y or set DB_RESET_YES=1."
    printf '\n  Type the database name (%s) to continue: ' "$DB_NAME"
    read -r answer
    [ "$answer" = "$DB_NAME" ] || die "aborted — nothing was destroyed."
fi

step "Removing container and volume"
compose down -v --remove-orphans
ok "volume removed"

# --expect-empty: a reset that left tables behind did not reset.
exec bash "$(dirname "$0")/up.sh" --expect-empty
