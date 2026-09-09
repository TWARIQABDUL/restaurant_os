const supabase = require('../config/supabase');

/**
 * Stock reservation helpers.
 *
 * The check-and-decrement lives in a Postgres function (see
 * supabase/inventory.sql + option-sizes.sql) so it is atomic — two shoppers
 * racing for the last unit cannot both succeed. It is generic over the table
 * ('menu_items' for products, 'add_ons' for single-choice options like a
 * size). Rows with `track_inventory = false` are ignored throughout, which is
 * the default.
 */

/** Shape lines for the reserve/release functions: [{id, quantity}]. */
function toLines(items, idKey) {
  return (items || [])
    .filter((i) => i && i[idKey] && Number(i.quantity) > 0)
    .map((i) => ({ id: i[idKey], quantity: Number(i.quantity) }));
}

/**
 * Thrown when a tracked product/option doesn't have enough stock. Carries the
 * name so the caller can tell the customer exactly what's short.
 */
class InsufficientStockError extends Error {
  constructor(name) {
    super(`Not enough stock for ${name}`);
    this.name = 'InsufficientStockError';
    this.productName = name;
  }
}

async function rpcReserve(tenantId, table, lines) {
  if (lines.length === 0) return;
  const { error } = await supabase.rpc('reserve_stock', {
    p_tenant_id: tenantId,
    p_table: table,
    p_lines: lines,
  });
  if (error) {
    const match = /INSUFFICIENT_STOCK:(.*)/.exec(error.message || '');
    if (match) throw new InsufficientStockError(match[1].trim());
    console.error(`reserve_stock(${table}) failed:`, error);
    throw new Error('Could not reserve stock');
  }
}

async function rpcRelease(tenantId, table, lines) {
  if (lines.length === 0) return;
  const { error } = await supabase.rpc('release_stock', {
    p_tenant_id: tenantId,
    p_table: table,
    p_lines: lines,
  });
  if (error) console.error(`release_stock(${table}) failed — stock may be understated:`, error);
}

/**
 * Atomically hold stock for an order: products first, then any single-choice
 * options (sizes). If the options can't be held, the product hold is rolled
 * back before throwing, so a failed reservation leaves nothing decremented.
 *
 * @param menuItems  [{ menu_item_id, quantity }]
 * @param addonItems [{ add_on_id, quantity }]
 * @throws {InsufficientStockError}
 */
async function reserveStock(tenantId, menuItems, addonItems = []) {
  const menuLines = toLines(menuItems, 'menu_item_id');
  const addonLines = toLines(addonItems, 'add_on_id');

  await rpcReserve(tenantId, 'menu_items', menuLines);
  try {
    await rpcReserve(tenantId, 'add_ons', addonLines);
  } catch (err) {
    await rpcRelease(tenantId, 'menu_items', menuLines);
    throw err;
  }
}

/** Put stock back (order failed to persist, or was rejected/cancelled). Best effort. */
async function releaseStock(tenantId, menuItems, addonItems = []) {
  await rpcRelease(tenantId, 'menu_items', toLines(menuItems, 'menu_item_id'));
  await rpcRelease(tenantId, 'add_ons', toLines(addonItems, 'add_on_id'));
}

/** Product lines of an existing order, for releasing its hold. */
async function linesForOrder(orderId) {
  const { data, error } = await supabase
    .from('order_items')
    .select('menu_item_id, quantity')
    .eq('order_id', orderId);
  if (error) {
    console.error('Failed to read order items for stock release:', error);
    return [];
  }
  return data || [];
}

/** Option lines of an existing order, for releasing its hold. */
async function addonLinesForOrder(orderId) {
  const { data, error } = await supabase
    .from('order_item_addons')
    .select('add_on_id, quantity, order_items!inner(order_id)')
    .eq('order_items.order_id', orderId);
  if (error) {
    console.error('Failed to read order option lines for stock release:', error);
    return [];
  }
  return (data || []).map((r) => ({ add_on_id: r.add_on_id, quantity: r.quantity }));
}

/** Can this product/option be bought right now? */
function isPurchasable(item) {
  if (!item) return false;
  if (!item.available) return false;
  if (!item.track_inventory) return true;
  return (item.stock_quantity ?? 0) > 0;
}

/** Attach derived stock flags for the client. Works for products and options. */
function withStockFlags(item) {
  if (!item) return item;
  const tracked = !!item.track_inventory;
  return {
    ...item,
    in_stock: isPurchasable(item),
    low_stock:
      tracked &&
      item.stock_quantity > 0 &&
      item.stock_quantity <= (item.low_stock_threshold ?? 0),
  };
}

module.exports = {
  reserveStock,
  releaseStock,
  linesForOrder,
  addonLinesForOrder,
  isPurchasable,
  withStockFlags,
  InsufficientStockError,
};
