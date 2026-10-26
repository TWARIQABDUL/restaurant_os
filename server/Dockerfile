# server/Dockerfile — the new pg-only API server (server/src/api), not the legacy server/src/server.js.
#
# Build from the REPO ROOT, not from server/:
#
#   docker build -f server/Dockerfile -t vendlyfy-api .
#
# server/'s code reaches into packages/core by relative path (server/src/db/rows.ts imports
# '../../../packages/core/src/generated/database.ts'), not as an installed package — there is no
# workspace link, just a path that has to resolve inside the image the same way it does on disk.
# A context of server/ alone can never see packages/core, so root is the only context that works.
#
# No compile step: Node 22.18+ strips TypeScript's type syntax natively, the same way
# `npm run api:start` runs server/src/api/server.ts directly on a dev machine.

FROM node:22-alpine

WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY packages/core/src ./packages/core/src
COPY server/src ./server/src

ENV NODE_ENV=production
WORKDIR /app/server

EXPOSE 5100
CMD ["node", "src/api/server.ts"]
