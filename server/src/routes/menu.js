const express = require('express');
const { body, validationResult } = require('express-validator');
const supabase = require('../config/supabase');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// GET /api/menu — List all available menu items (public)
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
      query = query.ilike('name', `%${search}%`);
    }

    const { data: items, error } = await query;

    if (error) {
      console.error('Menu fetch error:', error);
      return res.status(500).json({ error: 'Failed to fetch menu' });
    }

    res.json({ items });
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
      return res.status(404).json({ error: 'Menu item not found' });
    }

    // Fetch available add-ons for this item
    const { data: addOnLinks } = await supabase
      .from('menu_item_addons')
      .select('add_on_id')
      .eq('menu_item_id', id);

    let addOns = [];
    if (addOnLinks && addOnLinks.length > 0) {
      const addOnIds = addOnLinks.map(link => link.add_on_id);
      const { data: addOnData } = await supabase
        .from('add_ons')
        .select('*')
        .in('id', addOnIds)
        .eq('available', true);

      addOns = addOnData || [];
    }

    res.json({ item, addOns });
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
        })
        .select('*')
        .single();

      if (error) {
        console.error('Menu insert error:', error);
        return res.status(500).json({ error: 'Failed to add menu item' });
      }

      res.status(201).json({ item });
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

      const allowedFields = ['name', 'description', 'price', 'category', 'image_url', 'available'];
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates[field] = field === 'price' ? parseFloat(req.body[field]) : req.body[field];
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      const { data: item, error } = await supabase
        .from('menu_items')
        .update(updates)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .select('*')
        .single();

      if (error || !item) {
        return res.status(404).json({ error: 'Menu item not found' });
      }

      res.json({ item });
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
