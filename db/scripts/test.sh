#!/usr/bin/env bash
#
# Runs every database test suite: db/scripts/test-*.sh, in name order.
#
# Globbed rather than listed so a new suite is picked up by CI the moment it
# exists — a suite someone forgot to add to the workflow is a suite that does not
# run.
#
#   npm run db:test

set -uo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FAILED=""
for suite in "$SELF_DIR"/test-*.sh; do
    name="$(basename "$suite")"
    if ! bash "$suite"; then
        FAILED="$FAILED $name"
    fi
done

printf '\n════════════════════════════════════════\n'
if [ -n "$FAILED" ]; then
    printf 'FAILED:%s\n' "$FAILED"
    exit 1
fi
printf 'Every database suite passed.\n'
