const supabase = require('../config/supabase');

/**
 * Per-product variants (sizes, colours) are `add_ons` rows with `menu_item_id`
 * set. They are always single-choice and always track their own stock.
 *
 * `syncVariants` reconciles a product's variant rows against the list the
 * seller submitted from the product form:
 *   - rows with an `id` are updated
 *   - rows without an `id` are inserted
 *   - existing rows the seller dropped are soft-removed (available = false)
 *     rather than deleted, so past orders keep their variant reference.
 */
async function syncVariants(tenantId, menuItemId, dimension, variants) {
  const label = (dimension || 'size').trim().toLowerCase() || 'size';
  const incoming = Array.isArray(variants) ? variants : [];

  const { data: existing } = await supabase
    .from('add_ons')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('menu_item_id', menuItemId);

  const existingIds = new Set((existing || []).map((r) => r.id));
  const keptIds = new Set();

  for (const v of incoming) {
    const name = String(v.name || '').trim();
    if (!name) continue;

    const row = {
      tenant_id: tenantId,
      menu_item_id: menuItemId,
      name,
      price: Math.max(0, parseFloat(v.price) || 0),
      category: label,
      product_category: null,
      single_choice: true,
      track_inventory: true,
      stock_quantity: Math.max(0, parseInt(v.stock_quantity, 10) || 0),
      low_stock_threshold: Math.max(0, parseInt(v.low_stock_threshold, 10) || 5),
      available: true,
    };

    if (v.id && existingIds.has(v.id)) {
      keptIds.add(v.id);
      await supabase.from('add_ons').update(row).eq('id', v.id).eq('tenant_id', tenantId);
    } else {
      await supabase.from('add_ons').insert(row);
    }
  }

  const toRemove = [...existingIds].filter((id) => !keptIds.has(id));
  if (toRemove.length > 0) {
    await supabase.from('add_ons').update({ available: false }).in('id', toRemove);
  }
}

module.exports = { syncVariants };
