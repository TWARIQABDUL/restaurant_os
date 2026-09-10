const express = require('express');
const { body, validationResult } = require('express-validator');
const supabase = require('../config/supabase');
const { authenticate, authorize } = require('../middleware/auth');
const { withStockFlags } = require('../services/stock');
const { syncVariants } = require('../services/variants');

// Stock fields sellers can set on a product.
const STOCK_FIELDS = ['track_inventory', 'stock_quantity', 'low_stock_threshold', 'sku'];

const router = express.Router();

// GET /api/menu — Purchasable products for the storefront (public)
router.get('/', async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const { category, search } = req.query;

    let query = supabase
      .from('menu_items')
      .select('*, add_ons:menu_item_addons ( add_on_id )')
      .eq('tenant_id', tenantId)
      .eq('available', true)
      .order('category')
      .order('name');

    if (category) {
      query = query.eq('category', category);
    }

    if (search) {
      // Cap the pattern: a leading-wildcard ILIKE can't use an index, so an
      // unbounded one is a cheap way to make the database work hard.
      query = query.ilike('name', `%${String(search).slice(0, 100)}%`);
    }

    query = query.limit(Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500));

    const { data: items, error } = await query;

    if (error) {
      console.error('Menu fetch error:', error);
      return res.status(500).json({ error: 'Failed to fetch menu' });
    }

    res.json({ items: (items || []).map(withStockFlags) });
  } catch (err) {
    console.error('Menu error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/menu/categories — List distinct categories
router.get('/categories', async (req, res) => {
  try {
    const tenantId = req.tenant.id;

    const { data, error } = await supabase
      .from('menu_items')
      .select('category')
      .eq('tenant_id', tenantId)
      .eq('available', true);

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch categories' });
    }

    const categories = [...new Set(data.map(item => item.category))].sort();
    res.json({ categories });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/menu/manage — Every product for the store, including hidden and
// out-of-stock ones. The public list above only returns purchasable items, so
// sellers need their own view to manage stock. Declared before /:id so the
// literal path wins.
router.get('/manage', authenticate, authorize('admin', 'manager'), async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const { data: items, error } = await supabase
      .from('menu_items')
      .select('*, variants:add_ons!add_ons_menu_item_id_fkey ( id, name, price, category, stock_quantity, low_stock_threshold, track_inventory, available )')
      .eq('tenant_id', tenantId)
      .order('category')
      .order('name');

    if (error) {
      console.error('Product manage fetch error:', error);
      return res.status(500).json({ error: 'Failed to fetch products' });
    }

    const withVariants = (items || []).map((it) => ({
      ...withStockFlags(it),
      variants: (it.variants || [])
        .filter((v) => v.available)
        .map(withStockFlags)
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
    res.json({ items: withVariants });
  } catch (err) {
    console.error('Product manage error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/menu/:id/stock — Adjust stock without touching anything else.
// Accepts either an absolute `stock_quantity` or a relative `delta`.
router.patch('/:id/stock', authenticate, authorize('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenant.id;
    const { stock_quantity, delta } = req.body;

    const { data: current, error: readErr } = await supabase
      .from('menu_items')
      .select('id, stock_quantity, track_inventory')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (readErr || !current) {
      return res.status(404).json({ error: 'Product not found' });
    }

    let next;
    if (stock_quantity !== undefined) {
      next = parseInt(stock_quantity, 10);
    } else if (delta !== undefined) {
      next = (current.stock_quantity || 0) + parseInt(delta, 10);
    } else {
      return res.status(400).json({ error: 'Provide stock_quantity or delta' });
    }

    if (Number.isNaN(next)) {
      return res.status(400).json({ error: 'Stock must be a number' });
    }
    next = Math.max(0, next);

    const { data: item, error } = await supabase
      .from('menu_items')
      .update({ stock_quantity: next, track_inventory: true })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select('*')
      .single();

    if (error || !item) {
      return res.status(500).json({ error: 'Failed to update stock' });
    }

    res.json({ item: withStockFlags(item) });
  } catch (err) {
    console.error('Stock update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/menu/:id — Single item with its available add-ons (public)
router.get('/:id', async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const { id } = req.params;

    const { data: item, error } = await supabase
      .from('menu_items')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (error || !item) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Only show options that apply to this product: either unscoped
    // (product_category IS NULL = every product) or scoped to this
    // product's category. This is why a drink option never shows on a shirt.
    let addOnQuery = supabase
      .from('add_ons')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('available', true)
      .order('category')
      .order('name');

    if (item.category) {
      // Double-quote the value so category names with commas/parens don't
      // break the PostgREST filter string.
      const cat = `"${String(item.category).replace(/"/g, '\\"')}"`;
      addOnQuery = addOnQuery.or(`product_category.is.null,product_category.eq.${cat}`);
    } else {
      addOnQuery = addOnQuery.is('product_category', null);
    }

    addOnQuery = addOnQuery.is('menu_item_id', null);
    const { data: sharedData } = await addOnQuery;

    const { data: variantData } = await supabase
      .from('add_ons')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('menu_item_id', id)
      .eq('available', true)
      .order('name');

    const addOns = [...(variantData || []), ...(sharedData || [])].map(withStockFlags);

    res.json({ item: withStockFlags(item), addOns });
  } catch (err) {
    console.error('Menu detail error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/menu — Add menu item (Admin/Manager)
router.post(
  '/',
  authenticate,
  authorize('admin', 'manager'),
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('description').optional().trim(),
    body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
    body('category').trim().notEmpty().withMessage('Category is required'),
    body('image_url').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, description, price, category, image_url } = req.body;
      const tenantId = req.tenant.id;

      const trackInventory = req.body.track_inventory === true || req.body.track_inventory === 'true';

      const { data: item, error } = await supabase
        .from('menu_items')
        .insert({
          name,
          description: description || '',
          price: parseFloat(price),
          category,
          image_url: image_url || null,
          available: true,
          tenant_id: tenantId,
          track_inventory: trackInventory,
          stock_quantity: trackInventory ? parseInt(req.body.stock_quantity, 10) || 0 : 0,
          low_stock_threshold: parseInt(req.body.low_stock_threshold, 10) || 5,
          sku: req.body.sku ? String(req.body.sku).trim() : null,
        })
        .select('*')
        .single();

      if (error) {
        console.error('Menu insert error:', error);
        return res.status(500).json({ error: 'Failed to add menu item' });
      }

      if (Array.isArray(req.body.variants) && req.body.variants.length > 0) {
        await syncVariants(tenantId, item.id, req.body.variant_label, req.body.variants);
      }

      res.status(201).json({ item: withStockFlags(item) });
    } catch (err) {
      console.error('Menu add error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PUT /api/menu/:id — Update menu item (Admin/Manager)
router.put(
  '/:id',
  authenticate,
  authorize('admin', 'manager'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const tenantId = req.tenant.id;
      const updates = {};

      const allowedFields = ['name', 'description', 'price', 'category', 'image_url', 'available', ...STOCK_FIELDS];
      for (const field of allowedFields) {
        if (req.body[field] === undefined) continue;
        if (field === 'price') {
          // POST validates this with isFloat({ min: 0 }); this route had no
          // validator chain at all, so a negative price got straight through —
          // and order totals are computed from the stored price, so a negative
          // line subtracts from the basket.
          const price = parseFloat(req.body[field]);
          if (!Number.isFinite(price) || price < 0) {
            return res.status(400).json({ error: 'Price must be a positive number' });
          }
          updates[field] = price;
        } else if (field === 'stock_quantity' || field === 'low_stock_threshold') {
          updates[field] = Math.max(0, parseInt(req.body[field], 10) || 0);
        } else if (field === 'sku') {
          updates[field] = req.body[field] ? String(req.body[field]).trim() : null;
        } else {
          updates[field] = req.body[field];
        }
      }

      const hasVariants = Array.isArray(req.body.variants);

      if (Object.keys(updates).length === 0 && !hasVariants) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      let item;
      if (Object.keys(updates).length > 0) {
        const { data, error } = await supabase
          .from('menu_items')
          .update(updates)
          .eq('id', id)
          .eq('tenant_id', tenantId)
          .select('*')
          .single();
        if (error || !data) return res.status(404).json({ error: 'Product not found' });
        item = data;
      } else {
        const { data } = await supabase
          .from('menu_items').select('*').eq('id', id).eq('tenant_id', tenantId).single();
        if (!data) return res.status(404).json({ error: 'Product not found' });
        item = data;
      }

      if (hasVariants) {
        await syncVariants(tenantId, id, req.body.variant_label, req.body.variants);
      }

      res.json({ item: withStockFlags(item) });
    } catch (err) {
      console.error('Menu update error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/menu/:id — Remove menu item (Admin/Manager)
router.delete(
  '/:id',
  authenticate,
  authorize('admin', 'manager'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const tenantId = req.tenant.id;

      const { error } = await supabase
        .from('menu_items')
        .delete()
        .eq('id', id)
        .eq('tenant_id', tenantId);

      if (error) {
        console.error('Menu delete error:', error);
        return res.status(500).json({ error: 'Failed to delete menu item' });
      }

      res.json({ message: 'Menu item deleted' });
    } catch (err) {
      console.error('Menu delete error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
