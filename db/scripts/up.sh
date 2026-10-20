#!/usr/bin/env bash
#
# Start the local database and prove it is usable. Safe to re-run.
# Any arguments are passed through to db/scripts/verify.sh.

. "$(dirname "$0")/_lib.sh"

require_docker

# If the port is taken by something that is NOT our container, say so now.
# Without this, compose fails with a bind error that reads like a docker problem.
if [ "$(container_state)" != "running" ] && host_port_open; then
    die "something is already listening on ${HOST_ADDR}:${HOST_PORT}, and it is not this container.
      Stop it, or change the published port in docker-compose.yml.
      (Port 5432 on this machine is already in use by another Postgres — that is why this one is on ${HOST_PORT}.)"
fi

step "Starting ${PG_IMAGE} (project 'vendlyfy', volume 'vendlyfy_pgdata')"
info "the first run pulls the image and initialises the data directory; that takes a minute"
# --wait-timeout must exceed the healthcheck start_period in docker-compose.yml,
# or a slow first run reports a failure that isn't one.
# Scoped to "$SERVICE" (postgres) on purpose: docker-compose.yml also has an opt-in minio
# service (decided 2026-10-20), and an unscoped `up --wait` would wait on it too — the whole
# point of "not started by db:up" in its own header comment.
compose up -d --wait --wait-timeout 300 "$SERVICE" \
    || die "the container did not become healthy within 300s. Run: npm run db:logs"

exec bash "$(dirname "$0")/verify.sh" "$@"
