// server/src/routes/health.ts — milestone 11.
//
// Liveness that actually checks the thing that matters.
//
// app.js' /api/health answers 200 unconditionally — it proves the process is running
// and nothing else, so a database outage reads as healthy and a load balancer keeps
// sending traffic into it. This one runs a query.

import { Router } from 'express';
import { ping } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';

const router = Router();

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const started = process.hrtime.bigint();
    try {
      await ping();
    } catch (err) {
      // 503, not 500: the process is fine and the answer may be different in a second.
      // The message is deliberately generic — a connection string in a health response
      // is a gift to whoever is scanning.
      console.error('[api] health check failed:', err instanceof Error ? err.message : err);
      res.status(503).json({ status: 'degraded', database: 'unreachable' });
      return;
    }

    res.json({
      status: 'ok',
      database: 'ok',
      databaseMs: Number(Number(process.hrtime.bigint() - started) / 1e6).toFixed(1),
      timestamp: new Date().toISOString(),
    });
  }),
);

export default router;
