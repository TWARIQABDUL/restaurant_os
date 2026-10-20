// server/src/middleware/writeFreeze.ts — milestone 30's cutover hook: freezing writes on the old system
// while the final ETL run and reconciliation report happen, without taking reads down too.
//
// WRITE_FREEZE=on refuses every mutating request (POST/PUT/PATCH/DELETE) with 503. Read live on every
// request, the same pattern as the messaging transport seam (messaging/transport.ts) and the storage
// drivers (MEDIA_STORE/PRIVATE_STORE) — flipping the env var takes effect without a restart, which matters
// when the whole point is a short, precisely-timed window. GET/HEAD/OPTIONS always pass through: a load
// balancer's health check and read-only browsing have no reason to go down during a freeze that is only
// about writes.
//
// SHARED BETWEEN THE LEGACY APP (server/src/app.js) AND THE NEW ONE (server/src/api/app.ts) ON PURPOSE.
// Cutover's freeze step is "stop the OLD system's writes" — but a future maintenance window on the new
// server, after cutover, needs exactly the same switch, and two copies of this logic would drift.

import type { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function writeFreezeActive(): boolean {
  return (process.env.WRITE_FREEZE ?? 'off').trim().toLowerCase() === 'on';
}

export function writeFreeze(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method) || !writeFreezeActive()) {
    next();
    return;
  }
  res.status(503).json({
    error: 'WRITE_FREEZE',
    message: 'Vendlyfy is briefly read-only for a scheduled migration. Try again shortly.',
  });
}
