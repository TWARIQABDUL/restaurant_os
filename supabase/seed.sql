-- Restaurant OS — Seed Data
-- Run this AFTER schema.sql

-- ============================================
-- DEFAULT TENANT
-- ============================================
INSERT INTO tenants (id, name, slug, settings) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Restaurant OS Demo', 'demo', '{"currency": "USD", "business_hours": "9:00 AM - 10:00 PM"}');

-- ============================================
-- USERS (password for all: "password123")
-- Hash generated with bcrypt salt rounds 12
-- ============================================
INSERT INTO users (tenant_id, name, email, password_hash, role, phone, plate_number) VALUES
  -- Super Admin
  ('a0000000-0000-0000-0000-000000000001', 'Super Admin', 'superadmin@restaurantos.com', '$2a$12$vOtOVLCB7I/cQqMnZh5dTOungaAKdYdgQqOJ/ykAKCSEy80g75MUK', 'super_admin', '+1234567890', NULL),
  -- Admin
  ('a0000000-0000-0000-0000-000000000001', 'Restaurant Admin', 'admin@demo.restaurantos.com', '$2a$12$vOtOVLCB7I/cQqMnZh5dTOungaAKdYdgQqOJ/ykAKCSEy80g75MUK', 'admin', '+1234567891', NULL),
  -- Manager
  ('a0000000-0000-0000-0000-000000000001', 'John Manager', 'manager@demo.restaurantos.com', '$2a$12$vOtOVLCB7I/cQqMnZh5dTOungaAKdYdgQqOJ/ykAKCSEy80g75MUK', 'manager', '+1234567892', NULL),
  -- Delivery
  ('a0000000-0000-0000-0000-000000000001', 'David Driver', 'driver@demo.restaurantos.com', '$2a$12$vOtOVLCB7I/cQqMnZh5dTOungaAKdYdgQqOJ/ykAKCSEy80g75MUK', 'delivery', '+1234567893', 'KAA 123B'),
  ('a0000000-0000-0000-0000-000000000001', 'Sarah Driver', 'driver2@demo.restaurantos.com', '$2a$12$vOtOVLCB7I/cQqMnZh5dTOungaAKdYdgQqOJ/ykAKCSEy80g75MUK', 'delivery', '+1234567894', 'KBB 456C'),
  -- Customer
  ('a0000000-0000-0000-0000-000000000001', 'Jane Customer', 'customer@demo.restaurantos.com', '$2a$12$vOtOVLCB7I/cQqMnZh5dTOungaAKdYdgQqOJ/ykAKCSEy80g75MUK', 'customer', '+1234567895', NULL);

-- ============================================
-- MENU ITEMS
-- ============================================
INSERT INTO menu_items (tenant_id, name, description, price, category, available) VALUES
  -- Appetizers
  ('a0000000-0000-0000-0000-000000000001', 'Spring Rolls', 'Crispy vegetable spring rolls served with sweet chili sauce', 8.50, 'Appetizers', true),
  ('a0000000-0000-0000-0000-000000000001', 'Chicken Wings', 'Spicy buffalo wings with ranch dipping sauce', 12.00, 'Appetizers', true),
  ('a0000000-0000-0000-0000-000000000001', 'Bruschetta', 'Toasted bread topped with fresh tomatoes, basil, and olive oil', 7.50, 'Appetizers', true),
  -- Mains
  ('a0000000-0000-0000-0000-000000000001', 'Grilled Chicken', 'Herb-marinated chicken breast with roasted vegetables', 18.50, 'Mains', true),
  ('a0000000-0000-0000-0000-000000000001', 'Beef Burger', 'Angus beef patty with cheddar, lettuce, and house sauce', 15.00, 'Mains', true),
  ('a0000000-0000-0000-0000-000000000001', 'Margherita Pizza', 'Classic pizza with mozzarella, tomato sauce, and fresh basil', 14.00, 'Mains', true),
  ('a0000000-0000-0000-0000-000000000001', 'Grilled Salmon', 'Atlantic salmon with lemon butter sauce and asparagus', 22.00, 'Mains', true),
  ('a0000000-0000-0000-0000-000000000001', 'Pasta Carbonara', 'Creamy pasta with pancetta, egg, and parmesan', 16.00, 'Mains', true),
  -- Drinks
  ('a0000000-0000-0000-0000-000000000001', 'Fresh Juice', 'Freshly squeezed orange or mango juice', 5.00, 'Drinks', true),
  ('a0000000-0000-0000-0000-000000000001', 'Iced Tea', 'Homemade peach iced tea', 4.00, 'Drinks', true),
  -- Desserts
  ('a0000000-0000-0000-0000-000000000001', 'Chocolate Lava Cake', 'Warm chocolate cake with a molten center', 9.00, 'Desserts', true),
  ('a0000000-0000-0000-0000-000000000001', 'Cheesecake', 'New York-style cheesecake with berry compote', 8.50, 'Desserts', true);

-- ============================================
-- ADD-ONS
-- ============================================
INSERT INTO add_ons (id, tenant_id, name, price, category, available) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Coca Cola', 2.50, 'drinks', true),
  ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'Sprite', 2.50, 'drinks', true),
  ('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'Water Bottle', 1.50, 'drinks', true),
  ('b0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'Garden Salad', 5.00, 'sides', true),
  ('b0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', 'French Fries', 3.50, 'sides', true),
  ('b0000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000001', 'Coleslaw', 3.00, 'sides', true),
  ('b0000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000001', 'Ketchup', 0.50, 'sauces', true),
  ('b0000000-0000-0000-0000-000000000008', 'a0000000-0000-0000-0000-000000000001', 'Hot Sauce', 0.50, 'sauces', true),
  ('b0000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-000000000001', 'Extra Cheese', 1.50, 'extras', true),
  ('b0000000-0000-0000-0000-000000000010', 'a0000000-0000-0000-0000-000000000001', 'Extra Meat', 3.00, 'extras', true);

-- ============================================
-- LINK ADD-ONS TO MENU ITEMS
-- (Link drinks, sides, sauces to main dishes)
-- ============================================
-- Get menu item IDs (these will be auto-generated, so we use a subquery approach)
-- For seed data, we link all add-ons to all main course items

DO $$
DECLARE
  main_item RECORD;
  addon RECORD;
BEGIN
  FOR main_item IN SELECT id FROM menu_items WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001' AND category IN ('Mains', 'Appetizers')
  LOOP
    FOR addon IN SELECT id FROM add_ons WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001'
    LOOP
      INSERT INTO menu_item_addons (menu_item_id, add_on_id) VALUES (main_item.id, addon.id)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;
