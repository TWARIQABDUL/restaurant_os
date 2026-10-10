// server/src/routes/lookup.ts — milestone 28: "Did you mean nyama?" (project/ErrorPages.dc.html, "Store not found").
//
//   GET /api/lookup/store?near=nyamaa     the live store whose address is closest to what was typed, or null
//
// PUBLIC, because the person who typed a wrong address has no session. What it can tell a stranger is that a store exists at an
// address — which is already public, since every live store is a website — and it only ever offers ONE, only a live (active) one, and
// only if it is within two typos of what was typed: it is a spell-checker, not a search box, so it cannot be used to list stores.
// A suspended or pending store is never suggested: that would disclose it exists to somebody who has just been told it does not.

import { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { db } from '../db/index.ts';

const router = Router();

/** Edit distance, capped: anything past `max` is "far", and stops the work early. */
export function distance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]!);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

router.get(
  '/store',
  asyncHandler(async (req, res) => {
    const near = typeof req.query['near'] === 'string' ? req.query['near'].toLowerCase().slice(0, 63) : '';
    if (!/^[a-z0-9-]{2,63}$/.test(near)) {
      res.json({ slug: null, name: null });
      return;
    }
    // A band of lengths, not a scan of every store: two typos move the length by at most two.
    const { rows } = await db.query<{ slug: string; name: string }>(
      `SELECT slug, name FROM stores WHERE status = 'active' AND char_length(slug) BETWEEN $1 AND $2 AND slug <> $3 LIMIT 2000`,
      [Math.max(2, near.length - 2), near.length + 2, near],
    );
    let best: { slug: string; name: string; d: number } | null = null;
    for (const r of rows) {
      const d = distance(near, r.slug);
      if (d <= 2 && (best === null || d < best.d)) best = { ...r, d };
    }
    res.json(best === null ? { slug: null, name: null } : { slug: best.slug, name: best.name });
  }),
);

export default router;
