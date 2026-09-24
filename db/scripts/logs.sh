#!/usr/bin/env bash
#
# Follow the database log. Statements slower than 200ms and every lock wait land
# here — see the command flags in docker-compose.yml.
#
#   npm run db:logs
#   npm run db:logs -- --since 10m

. "$(dirname "$0")/_lib.sh"

require_docker
if [ "$#" -eq 0 ]; then
    exec docker compose -f "$COMPOSE_FILE" logs -f --tail=100 "$SERVICE"
fi
exec docker compose -f "$COMPOSE_FILE" logs "$@" "$SERVICE"
