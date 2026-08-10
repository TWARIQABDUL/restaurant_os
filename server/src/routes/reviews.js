const express = require('express');
const { body, validationResult } = require('express-validator');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /api/reviews/menu/:menuItemId — Fetch reviews for a specific menu item
router.get('/menu/:menuItemId', async (req, res) => {
  try {
    const { menuItemId } = req.params;

    const { data: reviews, error } = await supabase
      .from('reviews')
      .select(`
        id, 
        rating, 
        comment, 
        created_at,
        users ( name )
      `)
      .eq('menu_item_id', menuItemId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Fetch reviews error:', error);
      return res.status(500).json({ error: 'Failed to fetch reviews' });
    }

    res.json({ reviews });
  } catch (err) {
    console.error('Fetch reviews error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/reviews — Submit a new review
router.post(
  '/',
  authenticate,
  [
    body('menu_item_id').isUUID().withMessage('Valid menu item ID is required'),
    body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
    body('comment').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { menu_item_id, rating, comment } = req.body;
      const tenantId = req.tenant.id;
      const userId = req.user.id;

      // Verify the menu item exists and belongs to this tenant
      const { data: menuItem } = await supabase
        .from('menu_items')
        .select('id')
        .eq('id', menu_item_id)
        .eq('tenant_id', tenantId)
        .single();

      if (!menuItem) {
        return res.status(404).json({ error: 'Menu item not found' });
      }

      // Check if user has already reviewed this item
      const { data: existingReview } = await supabase
        .from('reviews')
        .select('id')
        .eq('menu_item_id', menu_item_id)
        .eq('customer_id', userId)
        .single();

      if (existingReview) {
        return res.status(409).json({ error: 'You have already reviewed this item' });
      }

      // Insert the review
      const { data: review, error } = await supabase
        .from('reviews')
        .insert({
          tenant_id: tenantId,
          menu_item_id,
          customer_id: userId,
          rating,
          comment: comment || null,
        })
        .select(`
          id, 
          rating, 
          comment, 
          created_at,
          users ( name )
        `)
        .single();

      if (error) {
        console.error('Create review error:', error);
        return res.status(500).json({ error: 'Failed to create review' });
      }

      res.status(201).json({ review });
    } catch (err) {
      console.error('Create review error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
