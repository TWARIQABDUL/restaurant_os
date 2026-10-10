// server/src/routes/storeExports.ts — milestone 28: the dialog that exports orders (project/PrintExports.dc.html, "CSV export").
//
//   GET /api/stores/:storeId/exports/orders?range=today|week|month|last_month&cols=items,customer,phone,payment,rider
//   GET …/exports/orders?…&count=1        {rows} — the dialog's "About 540 rows", without building the file
//
// orders.read, because that is who sees these orders on screen. AUDITED AS A SENSITIVE ACTION (see repositories/orderExport.ts): a CSV
// leaves the screen and cannot be un-read, so who took it, how big it was and whether it carried phone numbers is on the record.
// The customers export (M24) already exists and is its own route; the board's "same dialog for orders, customers, ledger and admin
// tables" is one dialog on the client over these endpoints — the ledger's and the admin tables' are not built.

import { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { badRequest, withTransaction } from '../db/index.ts';
import { authOf, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import * as exportOrders from '../repositories/orderExport.ts';

const router = Router({ mergeParams: true });

router.get(
  '/orders',
  requireStorePermission('orders.read'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const range = req.query['range'];
    if (typeof range !== 'string' || !(exportOrders.RANGES as readonly string[]).includes(range)) throw badRequest('Choose a period.', 'INVALID_RANGE');
    const cols = exportOrders.parseColumns(req.query['cols']);

    res.setHeader('Cache-Control', 'no-store');
    if (req.query['count'] === '1') {
      res.json({ rows: await exportOrders.count(storeId, range as exportOrders.Range) });
      return;
    }

    const file = await exportOrders.build(storeId, range as exportOrders.Range, cols);
    await withTransaction(
      (tx) =>
        tx.query(`SELECT audit('sensitive', 'export_orders', $1, $2, $3, $4, 'store', $3, $5::inet, $6)`, [
          `Exported ${file.rows} ${file.rows === 1 ? 'order' : 'orders'} (${range.replace('_', ' ')})${cols.includes('phone') ? ' · including customer phone numbers' : ''}`,
          authOf(req).context.userId, storeId, `columns: ${cols.join(', ')}`, req.ip ?? null, req.get('user-agent')?.slice(0, 300) ?? null,
        ]),
      { label: 'audit export_orders', retries: 0 },
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.csv);
  }),
);

export default router;
