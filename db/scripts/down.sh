#!/usr/bin/env bash
#
# Stop the local database. THE DATA IS KEPT — the named volume survives.
# Use db:reset to destroy it.

. "$(dirname "$0")/_lib.sh"

require_docker

step "Stopping the database"
compose down --remove-orphans
ok "stopped. Volume 'vendlyfy_pgdata' kept — npm run db:reset destroys it."
