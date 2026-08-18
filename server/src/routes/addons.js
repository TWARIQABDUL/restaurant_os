const express = require('express');
const { body, validationResult } = require('express-validator');
const supabase = require('../config/supabase');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// GET /api/addons — List all available add-ons (public)
router.get('/', async (req, res) => {
  try {
    const tenantId = req.tenant.id;

    const { data: addOns, error } = await supabase
      .from('add_ons')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('available', true)
      .order('category')
      .order('name');

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch add-ons' });
    }

    res.json({ addOns });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/addons — Create add-on (Admin/Manager)
router.post(
  '/',
  authenticate,
  authorize('admin', 'manager'),
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
    body('category').isIn(['drinks', 'sides', 'sauces', 'extras']).withMessage('Invalid category'),
    body('image_url').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, price, category, image_url } = req.body;

      const { data: addOn, error } = await supabase
        .from('add_ons')
        .insert({
          name,
          price: parseFloat(price),
          category,
          image_url: image_url || null,
          available: true,
          tenant_id: req.tenant.id,
        })
        .select('*')
        .single();

      if (error) {
        return res.status(500).json({ error: 'Failed to create add-on' });
      }

      res.status(201).json({ addOn });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PUT /api/addons/:id — Update add-on (Admin/Manager)
router.put(
  '/:id',
  authenticate,
  authorize('admin', 'manager'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const updates = {};
      const allowedFields = ['name', 'price', 'category', 'image_url', 'available'];

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates[field] = field === 'price' ? parseFloat(req.body[field]) : req.body[field];
        }
      }

      const { data: addOn, error } = await supabase
        .from('add_ons')
        .update(updates)
        .eq('id', id)
        .eq('tenant_id', req.tenant.id)
        .select('*')
        .single();

      if (error || !addOn) {
        return res.status(404).json({ error: 'Add-on not found' });
      }

      res.json({ addOn });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/addons/:id — Remove add-on (Admin/Manager)
router.delete(
  '/:id',
  authenticate,
  authorize('admin', 'manager'),
  async (req, res) => {
    try {
      const { error } = await supabase
        .from('add_ons')
        .delete()
        .eq('id', id)
        .eq('tenant_id', req.tenant.id);

      if (error) {
        return res.status(500).json({ error: 'Failed to delete add-on' });
      }

      res.json({ message: 'Add-on deleted' });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/addons/menu/:menuItemId/link — Link add-ons to a menu item (Admin/Manager)
router.post(
  '/menu/:menuItemId/link',
  authenticate,
  authorize('admin', 'manager'),
  [
    body('add_on_ids').isArray().withMessage('add_on_ids must be an array'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { menuItemId } = req.params;
      const { add_on_ids } = req.body;

      // 1. Delete all existing links for this item to start fresh
      await supabase
        .from('menu_item_addons')
        .delete()
        .eq('menu_item_id', menuItemId);

      // 2. Insert new links if any
      if (add_on_ids.length > 0) {
        const links = add_on_ids.map(addOnId => ({
          menu_item_id: menuItemId,
          add_on_id: addOnId,
        }));

        const { error } = await supabase
          .from('menu_item_addons')
          .insert(links);

        if (error) {
          console.error('Link add-ons error:', error);
          return res.status(500).json({ error: 'Failed to link add-ons' });
        }
      }

      res.json({ message: 'Add-ons linked successfully' });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/addons/menu/:menuItemId/unlink/:addonId — Unlink add-on from menu item
router.delete(
  '/menu/:menuItemId/unlink/:addonId',
  authenticate,
  authorize('admin', 'manager'),
  async (req, res) => {
    try {
      const { menuItemId, addonId } = req.params;

      const { error } = await supabase
        .from('menu_item_addons')
        .delete()
        .eq('menu_item_id', menuItemId)
        .eq('add_on_id', addonId);

      if (error) {
        return res.status(500).json({ error: 'Failed to unlink add-on' });
      }

      res.json({ message: 'Add-on unlinked' });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
