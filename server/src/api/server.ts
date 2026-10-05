// server/src/api/server.ts — milestone 11. The new server's entrypoint.
//
//   node src/api/server.ts        (npm run api:start, or api:dev to watch)
//
// Boot order matters, and each step exists because of a failure it prevents:
//
//   1. .env is loaded, so a local run needs no exported variables.
//   2. The configuration is asserted — the connection string and the JWT secret —
//      BEFORE anything connects, so a misconfiguration is one readable message.
//   3. The database is pinged. A server that accepts traffic and only then discovers it
//      cannot reach Postgres answers 500 to real users; this one refuses to start.
//   4. Every permission the routes require is checked against role_permissions. A
//      misspelt permission string would otherwise mean 403 for everybody, which reads
//      as a broken role rather than a typo.
//   5. Then, and only then, it listens.
//
// Shutdown drains: the listener stops accepting, in-flight requests finish, the pool
// closes. Without it a deploy kills a transaction mid-commit — which Postgres handles
// correctly, but the caller never learns which way it went.

// FIRST, and the comment in that file says why: it loads server/.env before any module
// that reads process.env has initialised.
import './env.ts';
import { createApp, REQUIRED_PERMISSIONS } from './app.ts';
import { assertDatabaseConfig, closePool, ping } from '../db/index.ts';
import { assertSessionConfig } from '../auth/sessionToken.ts';
import { assertPermissionsExist } from '../middleware/authorize.ts';
import { startSettlementLoop, stopSettlementLoop } from '../jobs/settlement.ts';
import { startKycRetentionLoop, stopKycRetentionLoop } from '../jobs/kycRetention.ts';

const PORT = Number(process.env.API_PORT ?? process.env.PORT ?? '5100');

/** How long in-flight requests get before the process stops waiting for them. */
const SHUTDOWN_GRACE_MS = Number(process.env.API_SHUTDOWN_GRACE_MS ?? '10000');

async function main(): Promise<void> {
  assertDatabaseConfig();
  assertSessionConfig();

  try {
    await ping();
  } catch (err) {
    console.error(
      '\nRefusing to start — cannot reach the database.\n\n' +
        `  ${err instanceof Error ? err.message : String(err)}\n\n` +
        '  Is the container up? `npm run db:up` at the repository root.\n',
    );
    process.exit(1);
  }

  try {
    await assertPermissionsExist(REQUIRED_PERMISSIONS);
  } catch (err) {
    console.error(`\nRefusing to start — ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const app = createApp();
  // Milestone 23: escrow release, automatic payouts, payout reconciliation. See jobs/settlement.ts.
  startSettlementLoop();
  // Milestone 26: deletes face videos once a case is decided. See jobs/kycRetention.ts.
  startKycRetentionLoop();
  const server = app.listen(PORT, () => {
    console.log(`[api] listening on ${PORT} — Postgres, no supabase-js`);
  });

  // Keep-alive sockets otherwise hold the process open past the grace period.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] ${signal} — draining`);

    const forceExit = setTimeout(() => {
      console.error('[api] in-flight requests did not finish in time; exiting anyway');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    // Do not let the timer itself keep the event loop alive.
    forceExit.unref();
    stopSettlementLoop();
    stopKycRetentionLoop();

    server.close(() => {
      void closePool()
        .then(() => {
          clearTimeout(forceExit);
          console.log('[api] closed');
          process.exit(0);
        })
        .catch((err: unknown) => {
          console.error('[api] error closing the pool:', err);
          process.exit(1);
        });
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('[api] failed to start:', err);
  process.exit(1);
});
