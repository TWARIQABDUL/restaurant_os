const express = require('express');
const { body, validationResult } = require('express-validator');
const supabase = require('../config/supabase');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// GET /api/categories — the store's category list (public: the storefront
// and the option picker both need it).
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .eq('tenant_id', req.tenant.id)
      .order('sort_order')
      .order('name');

    if (error) {
      console.error('Category fetch error:', error);
      return res.status(500).json({ error: 'Failed to fetch categories' });
    }
    res.json({ categories: data || [] });
  } catch (err) {
    console.error('Category error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/categories — create (Admin/Manager)
router.post(
  '/',
  authenticate,
  authorize('admin', 'manager'),
  [body('name').trim().notEmpty().isLength({ max: 100 }).withMessage('Name is required')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const tenantId = req.tenant.id;
      const name = req.body.name.trim();

      // Append to the end of the list.
      const { data: last } = await supabase
        .from('categories')
        .select('sort_order')
        .eq('tenant_id', tenantId)
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data, error } = await supabase
        .from('categories')
        .insert({ tenant_id: tenantId, name, sort_order: (last?.sort_order ?? -1) + 1 })
        .select('*')
        .single();

      if (error) {
        if (error.code === '23505') {
          return res.status(409).json({ error: 'That category already exists' });
        }
        console.error('Category create error:', error);
        return res.status(500).json({ error: 'Failed to create category' });
      }
      res.status(201).json({ category: data });
    } catch (err) {
      console.error('Category create error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// PUT /api/categories/:id — rename and/or reorder (Admin/Manager).
// A rename cascades to every product and option that referenced the old name,
// so the link by name never breaks.
router.put('/:id', authenticate, authorize('admin', 'manager'), async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const { id } = req.params;

    const { data: current, error: readErr } = await supabase
      .from('categories')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (readErr || !current) return res.status(404).json({ error: 'Category not found' });

    const updates = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
      updates.name = name;
    }
    if (req.body.sort_order !== undefined) {
      updates.sort_order = parseInt(req.body.sort_order, 10) || 0;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const { data, error } = await supabase
      .from('categories')
      .update(updates)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'That category already exists' });
      console.error('Category update error:', error);
      return res.status(500).json({ error: 'Failed to update category' });
    }

    // Cascade a rename to the text references.
    if (updates.name && updates.name !== current.name) {
      await supabase.from('menu_items')
        .update({ category: updates.name })
        .eq('tenant_id', tenantId).eq('category', current.name);
      await supabase.from('add_ons')
        .update({ product_category: updates.name })
        .eq('tenant_id', tenantId).eq('product_category', current.name);
    }

    res.json({ category: data });
  } catch (err) {
    console.error('Category update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/categories/:id — remove the category. Products keep their text
// value but are effectively uncategorised; options scoped to it fall back to
// "all products". Blocked while products still use it unless ?force=1.
router.delete('/:id', authenticate, authorize('admin', 'manager'), async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const { id } = req.params;

    const { data: cat, error: readErr } = await supabase
      .from('categories')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (readErr || !cat) return res.status(404).json({ error: 'Category not found' });

    const { count } = await supabase
      .from('menu_items')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('category', cat.name);

    if (count > 0 && req.query.force !== '1') {
      return res.status(409).json({
        error: `${count} product${count === 1 ? '' : 's'} still use this category`,
        productCount: count,
      });
    }

    // Detach options scoped to it (they become "all products").
    await supabase.from('add_ons')
      .update({ product_category: null })
      .eq('tenant_id', tenantId)
      .eq('product_category', cat.name);

    const { error } = await supabase
      .from('categories')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (error) {
      console.error('Category delete error:', error);
      return res.status(500).json({ error: 'Failed to delete category' });
    }
    res.json({ message: 'Category deleted' });
  } catch (err) {
    console.error('Category delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
