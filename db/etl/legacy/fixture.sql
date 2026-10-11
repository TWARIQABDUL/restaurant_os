-- db/etl/legacy/fixture.sql — a synthetic copy of the OLD database, shaped like the production profile
-- (docs/migration/05-old-database-profile.md) so the ETL can be rehearsed and tested without anyone's real data.
--
-- Applied on top of the schema that `build-legacy.sh` rebuilds from supabase/*.sql. Row counts match the profile
-- where the profile gave them (3 tenants, 13 users, 14 menu items, 13 add-ons, 80 links, 29 orders, 30 lines,
-- 15 ledger rows, 4 withdrawals, 2 refunds, 3 complaints, 1 review, 63 notifications, 2 posts), the status,
-- payment and role distributions match, and the wallet carries the real finding of §5.1: the ledger misstates
-- two movements by ±100 while the wallet itself is right.
--
-- Everything is deterministic: ids are built from a prefix and a number so a failing run can be reproduced.

CREATE OR REPLACE FUNCTION u(prefix text, n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS
$$ SELECT (prefix || '-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;

-- the orphaned TypeORM-era tables (04 §4.3): four exist; only `posts` holds rows
CREATE TABLE IF NOT EXISTS addon_groups (id uuid PRIMARY KEY);
CREATE TABLE IF NOT EXISTS addon_items (id uuid PRIMARY KEY);
CREATE TABLE IF NOT EXISTS menu_item_addon_groups (menu_item_id uuid, addon_group_id uuid);
CREATE TABLE IF NOT EXISTS delivery_assignments (id uuid PRIMARY KEY, order_id uuid);
CREATE TABLE IF NOT EXISTS delivery_persons (id uuid PRIMARY KEY, user_id uuid);
CREATE TABLE IF NOT EXISTS posts (id uuid PRIMARY KEY, slug text UNIQUE, title text, content text, created_at timestamptz DEFAULT now());

-- ---- tenants -------------------------------------------------------------------------------------------------
INSERT INTO tenants (id, name, slug, logo_url, settings, active, created_at) VALUES
  (u('aaaaaaaa',1), 'Nyama Choma Place', 'nyama-choma', 'https://old.example/storage/logos/nyama.png', '{"theme":"warm"}', true, '2026-07-01 08:00+00'),
  (u('bbbbbbbb',1), 'Inzu Fashion',      'inzu',        NULL,                                           '{}',                true, '2026-07-10 08:00+00'),
  (u('cccccccc',1), 'Dormant Cafe',      'dormant',     NULL,                                           '{}',                true, '2026-08-01 08:00+00');

-- ---- users (13: 5 customer, 3 delivery, 2 admin, 2 manager, 1 super_admin; one email is admin in A and customer in B) ----
INSERT INTO users (id, tenant_id, name, email, password_hash, role, phone, plate_number, created_at) VALUES
  (u('a0000000',1), u('aaaaaaaa',1), 'Amina Owner',   'owner-a@nyama.test',  '$2a$10$hashownerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'admin',    '0788000001', NULL,         '2026-07-01 08:05+00'),
  (u('a0000000',2), u('aaaaaaaa',1), 'Mark Manager',  'mgr-a@nyama.test',    '$2a$10$hashmanagerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'manager',  '0788000002', NULL,         '2026-07-02 08:00+00'),
  (u('a0000000',3), u('aaaaaaaa',1), 'Eric Rider',    'rider1-a@nyama.test', '$2a$10$hashriderAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'delivery', '0788000003', 'RAD 482 K', '2026-07-03 08:00+00'),
  (u('a0000000',4), u('aaaaaaaa',1), 'Jean Rider',    'rider2-a@nyama.test', '$2a$10$hashrider2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'delivery', '0788000004', NULL,         '2026-07-04 08:00+00'),
  (u('a0000000',5), u('aaaaaaaa',1), 'Grace Customer','cust1-a@nyama.test',  '$2a$10$hashcust1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'customer', '0788000005', NULL,         '2026-07-05 08:00+00'),
  (u('a0000000',6), u('aaaaaaaa',1), 'Chris Customer','cust2-a@nyama.test',  '$2a$10$hashcust2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'customer', '0788000006', NULL,         '2026-07-06 08:00+00'),
  (u('a0000000',7), u('aaaaaaaa',1), 'Dina Customer', 'cust3-a@nyama.test',  '$2a$10$hashcust3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'customer', NULL,         NULL,         '2026-07-07 08:00+00'),
  (u('b0000000',1), u('bbbbbbbb',1), 'Bea Owner',     'owner-b@inzu.test',   '$2a$10$hashownerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'admin',    '0788000011', NULL,         '2026-07-10 08:05+00'),
  (u('b0000000',2), u('bbbbbbbb',1), 'Ben Manager',   'mgr-b@inzu.test',     '$2a$10$hashmanagerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'manager',  '0788000012', NULL,         '2026-07-11 08:00+00'),
  (u('b0000000',3), u('bbbbbbbb',1), 'Remy Rider',    'rider-b@inzu.test',   '$2a$10$hashriderBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'delivery', '0788000013', 'RAB 100 X', '2026-07-12 08:00+00'),
  (u('b0000000',4), u('bbbbbbbb',1), 'Cora Customer', 'cust1-b@inzu.test',   '$2a$10$hashcustBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'customer', '0788000014', NULL,         '2026-07-13 08:00+00'),
  -- the same address as A's owner, as a customer at B: the profile's one shared email
  (u('b0000000',5), u('bbbbbbbb',1), 'Amina Owner',   'owner-a@nyama.test',  '$2a$10$hashsharedCUSTOMERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'customer', '0788000001', NULL,         '2026-07-14 08:00+00'),
  (u('cccccccc',9), u('cccccccc',1), 'Sam Super',     'super@vendlyfy.test', '$2a$10$hashsuperCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 'super_admin', NULL,       NULL,         '2026-06-30 08:00+00');

-- ---- catalogue -----------------------------------------------------------------------------------------------
INSERT INTO categories (id, tenant_id, name, description, sort_order, is_active, created_at) VALUES
  (u('ca000000',1), u('aaaaaaaa',1), 'Mains',      'Hearty plates', 1, true,  '2026-07-01 09:00+00'),
  (u('ca000000',2), u('aaaaaaaa',1), 'Appetizers', NULL,            2, true,  '2026-07-01 09:01+00'),
  (u('ca000000',3), u('aaaaaaaa',1), 'Burger',     NULL,            3, true,  '2026-07-01 09:02+00'),
  (u('ca000000',4), u('aaaaaaaa',1), 'Desserts',   NULL,            4, false, '2026-07-01 09:03+00'),
  (u('ca000000',5), u('bbbbbbbb',1), 'Drinks',     NULL,            1, true,  '2026-07-10 09:00+00'),
  (u('ca000000',6), u('bbbbbbbb',1), 'Specials',   NULL,            2, true,  '2026-07-10 09:01+00');

-- 12 products at A (Mains 5, Appetizers 3, Burger 2, Desserts 2) and 2 at B (Drinks). Mains #1 is 7000: the paid orders sell it.
INSERT INTO menu_items (id, tenant_id, name, description, price, category, available, created_at, track_inventory, stock_quantity, low_stock_threshold, sku)
SELECT u('d0000000', n), u('aaaaaaaa',1),
       (ARRAY['Goat brochette','Grilled tilapia','Beef stew','Chicken curry','Roast pork','Samosas','Spring rolls','Chicken wings','Classic burger','Double burger','Ice cream','Cake slice'])[n],
       'A good one.',
       CASE WHEN n = 1 THEN 7000 WHEN n <= 5 THEN 5000 + n*500 WHEN n <= 8 THEN 2000 + n*100 WHEN n <= 10 THEN 4500 ELSE 1500 END,
       (ARRAY['Mains','Mains','Mains','Mains','Mains','Appetizers','Appetizers','Appetizers','Burger','Burger','Desserts','Desserts'])[n],
       n <> 12, '2026-07-02 10:00+00'::timestamptz + n * interval '1 minute',
       n IN (11, 12), CASE WHEN n = 11 THEN 30 ELSE 0 END, 5,
       CASE WHEN n = 1 THEN 'GB-001' WHEN n = 2 THEN 'gb-001 ' ELSE NULL END   -- the same SKU once case and spaces are ignored: legal in the old schema, not in the new
  FROM generate_series(1, 12) n;
INSERT INTO menu_items (id, tenant_id, name, description, price, category, available, created_at, track_inventory, stock_quantity, low_stock_threshold)
SELECT u('d0000000', 20 + n), u('bbbbbbbb',1), (ARRAY['Fresh juice','Cold soda'])[n], '', 1200, 'Drinks', true, '2026-07-12 10:00+00'::timestamptz + n * interval '1 minute', false, 0, 5
  FROM generate_series(1, 2) n;

-- 13 shared add-ons at A: sides 3, drinks 3, extras 3, sauces 2, size 2 (pick-one, with their own stock)
INSERT INTO add_ons (id, tenant_id, name, price, category, available, created_at, single_choice, track_inventory, stock_quantity, low_stock_threshold)
VALUES
  (u('ad000000',1),  u('aaaaaaaa',1), 'Fries',    500, 'sides',   true, '2026-07-02 11:00+00', false, false, 0, 5),
  (u('ad000000',2),  u('aaaaaaaa',1), 'Plantain', 600, 'sides',   true, '2026-07-02 11:01+00', false, false, 0, 5),
  (u('ad000000',3),  u('aaaaaaaa',1), 'Salad',    700, 'sides',   true, '2026-07-02 11:02+00', false, false, 0, 5),
  (u('ad000000',4),  u('aaaaaaaa',1), 'Soda',     800, 'drinks',  true, '2026-07-02 11:03+00', false, false, 0, 5),
  (u('ad000000',5),  u('aaaaaaaa',1), 'Water',    300, 'drinks',  true, '2026-07-02 11:04+00', false, false, 0, 5),
  (u('ad000000',6),  u('aaaaaaaa',1), 'Juice',    900, 'drinks',  true, '2026-07-02 11:05+00', false, false, 0, 5),
  (u('ad000000',7),  u('aaaaaaaa',1), 'Cheese',   500, 'extras',  true, '2026-07-02 11:06+00', false, false, 0, 5),
  (u('ad000000',8),  u('aaaaaaaa',1), 'Bacon',    800, 'extras',  true, '2026-07-02 11:07+00', false, false, 0, 5),
  (u('ad000000',9),  u('aaaaaaaa',1), 'Egg',      300, 'extras',  false,'2026-07-02 11:08+00', false, false, 0, 5),
  (u('ad000000',10), u('aaaaaaaa',1), 'Chili',    100, 'sauces',  true, '2026-07-02 11:09+00', false, false, 0, 5),
  (u('ad000000',11), u('aaaaaaaa',1), 'Garlic',   100, 'sauces',  true, '2026-07-02 11:10+00', false, false, 0, 5),
  (u('ad000000',12), u('aaaaaaaa',1), 'Regular',  0,   'size',    true, '2026-07-02 11:11+00', true,  true,  15, 3),
  (u('ad000000',13), u('aaaaaaaa',1), 'Large',    300, 'size',    true, '2026-07-02 11:12+00', true,  true,  20, 3);

-- 85 links (the profile had 80): every A product gets all sides + all drinks (71, product 12 lacking one side),
-- products 1-4 also get both sauces (8), the burgers get both sizes (4) and cheese (2): partial links and sizes both occur.
INSERT INTO menu_item_addons (menu_item_id, add_on_id)
SELECT u('d0000000', p), u('ad000000', a) FROM generate_series(1, 12) p, generate_series(1, 6) a
 WHERE NOT (p = 12 AND a = 3);
INSERT INTO menu_item_addons (menu_item_id, add_on_id)
SELECT u('d0000000', p), u('ad000000', a) FROM generate_series(1, 4) p, generate_series(10, 11) a;
-- the sizes: burgers (9, 10) are sold in Regular / Large
INSERT INTO menu_item_addons (menu_item_id, add_on_id)
SELECT u('d0000000', p), u('ad000000', a) FROM generate_series(9, 10) p, generate_series(12, 13) a;
-- cheese on burgers
INSERT INTO menu_item_addons (menu_item_id, add_on_id)
SELECT u('d0000000', p), u('ad000000', 7) FROM generate_series(9, 10) p;

-- ---- orders --------------------------------------------------------------------------------------------------
-- 29 = A 20 + B 9. By status: pending 15, assigned 8, approved 5, delivered 1. By method: mobile_money 18, cash 11.
-- paid 9: A's first four (MoMo, released) + B's first five (cash). External delivery 5: B's first five.
DO $$
DECLARE
  n int; st text; pm text; ps text; settle text; refunded numeric; t timestamptz; cust uuid; tenant uuid; code text;
BEGIN
  FOR n IN 1..29 LOOP
    tenant := CASE WHEN n <= 20 THEN u('aaaaaaaa',1) ELSE u('bbbbbbbb',1) END;
    t := '2026-08-07 10:00+00'::timestamptz + n * interval '9 hours';
    IF n <= 20 THEN
      st := CASE WHEN n = 1 THEN 'delivered' WHEN n IN (2,3,4,6,7) THEN 'assigned' WHEN n IN (5,8,9) THEN 'approved' ELSE 'pending' END;
      pm := CASE WHEN n IN (19,20) THEN 'cash_on_delivery' ELSE 'mobile_money' END;
      ps := CASE WHEN n <= 4 THEN 'paid' ELSE 'unpaid' END;
      settle := CASE WHEN n <= 4 THEN 'released' ELSE 'not_applicable' END;
      refunded := CASE WHEN n = 2 THEN 200 WHEN n = 5 THEN 100 ELSE 0 END;
      cust := CASE WHEN n % 4 = 0 THEN NULL ELSE u('a0000000', 5 + (n % 3)) END;
    ELSE
      st := CASE WHEN n - 20 <= 3 THEN 'assigned' WHEN n - 20 <= 5 THEN 'approved' ELSE 'pending' END;
      pm := 'cash_on_delivery'; ps := CASE WHEN n - 20 <= 5 THEN 'paid' ELSE 'unpaid' END; settle := 'not_applicable'; refunded := 0;
      cust := CASE WHEN n % 2 = 0 THEN NULL ELSE u('b0000000', 4) END;
    END IF;
    code := 'ORD-' || substr('ABCDEFGHJK', (n % 10) + 1, 1) || lpad(n::text, 5, '0');
    INSERT INTO orders (id, tenant_id, tracking_code, customer_id, guest_name, guest_phone, guest_address, guest_email, status, total_amount,
                        payment_method, payment_status, delivery_type, external_rider_info, delivery_person_id, delivery_notes,
                        created_at, updated_at, paid_at, settlement_status, refunded_amount)
    VALUES (u('0d000000', n), tenant, code, cust,
            CASE WHEN cust IS NULL THEN 'Guest ' || n END, CASE WHEN cust IS NULL THEN '07880' || lpad(n::text, 5, '0') END,
            CASE WHEN cust IS NULL THEN 'KG ' || n || ' St, Kigali' END, NULL,
            st, 1, pm, ps,
            CASE WHEN n > 20 AND n - 20 <= 5 THEN 'external' ELSE 'internal' END,
            CASE WHEN n > 20 AND n - 20 <= 5 THEN '{"name":"Moto Ben","phone":"0788999000"}'::jsonb END,
            CASE WHEN st = 'assigned' AND n <= 20 THEN u('a0000000', 3) END,
            CASE WHEN n IN (11, 21) THEN 'Gate code 4411' END,
            t, t + interval '1 hour',
            CASE WHEN ps = 'paid' THEN t + interval '5 minutes' END, settle, refunded);
  END LOOP;
END $$;

-- lines (30): one per order, plus a second on order 10. Orders 1-5 sell Goat brochette (7000) so each totals 7000.
INSERT INTO order_items (id, order_id, menu_item_id, quantity, unit_price)
SELECT u('01000000', n), u('0d000000', n),
       CASE WHEN n <= 5 THEN u('d0000000', 1) WHEN n <= 20 THEN u('d0000000', 6 + (n % 6)) ELSE u('d0000000', 21 + (n % 2)) END,
       CASE WHEN n = 11 THEN 3 ELSE 1 END,
       CASE WHEN n <= 5 THEN 7000 WHEN n <= 20 THEN (SELECT price FROM menu_items WHERE id = u('d0000000', 6 + (n % 6))) ELSE 1200 END
  FROM generate_series(1, 29) n;
INSERT INTO order_items (id, order_id, menu_item_id, quantity, unit_price) VALUES (u('01000000', 30), u('0d000000', 10), u('d0000000', 1), 1, 7000);

-- 7 add-on lines. Order 12 and 13 sell burgers (products 9/10 are n%6+6 = 9,10 for n = 15,16): use those.
-- (1) a cheese at quantity 1 on a quantity-1 line; (2) a large size on a burger line; (3) a line of THREE with ONE
-- fries (cannot be spread evenly across the three, so the ETL must split the line to keep the total exact).
UPDATE order_items SET menu_item_id = u('d0000000', 9),  unit_price = 4500 WHERE order_id = u('0d000000', 15);
UPDATE order_items SET menu_item_id = u('d0000000', 10), unit_price = 4500 WHERE order_id = u('0d000000', 16);
INSERT INTO order_item_addons (id, order_item_id, add_on_id, quantity, unit_price) VALUES
  (u('0a000000', 1), u('01000000', 15), u('ad000000', 7),  1, 500),   -- cheese
  (u('0a000000', 2), u('01000000', 15), u('ad000000', 13), 1, 300),   -- large
  (u('0a000000', 3), u('01000000', 16), u('ad000000', 12), 1, 0),     -- regular
  (u('0a000000', 4), u('01000000', 16), u('ad000000', 7),  1, 500),
  (u('0a000000', 5), u('01000000', 11), u('ad000000', 1),  1, 500),   -- one fries on three samosa-type lines
  (u('0a000000', 6), u('01000000', 11), u('ad000000', 4),  3, 800),   -- a soda each
  (u('0a000000', 7), u('01000000', 12), u('ad000000', 10), 2, 100);   -- two chilis on a single

-- totals: the sum of the lines and add-ons, except the two deliberate disagreements (a delivery fee on 20, a discount on 19)
UPDATE orders o SET total_amount =
    COALESCE((SELECT sum(i.quantity * i.unit_price) FROM order_items i WHERE i.order_id = o.id), 0)
  + COALESCE((SELECT sum(a.quantity * a.unit_price) FROM order_item_addons a JOIN order_items i ON i.id = a.order_item_id WHERE i.order_id = o.id), 0);
UPDATE orders SET total_amount = total_amount + 1000 WHERE id = u('0d000000', 20);
UPDATE orders SET total_amount = total_amount - 500  WHERE id = u('0d000000', 19);

-- ---- money ---------------------------------------------------------------------------------------------------
-- The wallet is right (6800 available, 0 pending); the ledger beside it misstates two movements, exactly as §5.1 traced.
INSERT INTO wallets (tenant_id, available_balance, pending_balance, currency, updated_at) VALUES (u('aaaaaaaa',1), 6800, 0, 'EUR', '2026-09-09 12:00+00');

INSERT INTO withdrawal_requests (id, tenant_id, requested_by, initiated_by, amount, phone_number, status, failure_reason, requested_at, processed_at) VALUES
  (u('0b000000',1), u('aaaaaaaa',1), u('a0000000',1), 'manual', 10900, '0788000001', 'completed', NULL,            '2026-08-20 10:00+00', '2026-08-20 10:05+00'),
  (u('0b000000',2), u('aaaaaaaa',1), u('a0000000',1), 'manual', 6000,  '0788000001', 'completed', NULL,            '2026-08-25 10:00+00', '2026-08-25 10:05+00'),
  (u('0b000000',3), u('aaaaaaaa',1), u('a0000000',1), 'manual', 3000,  '0788000001', 'failed',    'MoMo: timeout', '2026-08-30 10:00+00', '2026-08-30 10:05+00'),
  (u('0b000000',4), u('aaaaaaaa',1), u('a0000000',1), 'auto',   4000,  '0788000001', 'completed', NULL,            '2026-09-03 10:00+00', '2026-09-03 10:05+00');

INSERT INTO wallet_ledger (id, tenant_id, order_id, withdrawal_request_id, entry_type, amount, balance_type, note, created_at) VALUES
  (u('0e000000',1),  u('aaaaaaaa',1), u('0d000000',1), NULL, 'order_payment_held',     7000,   'pending',   NULL, '2026-08-07 20:00+00'),
  (u('0e000000',2),  u('aaaaaaaa',1), u('0d000000',2), NULL, 'order_payment_held',     7000,   'pending',   NULL, '2026-08-08 05:00+00'),
  (u('0e000000',3),  u('aaaaaaaa',1), u('0d000000',3), NULL, 'order_payment_held',     7000,   'pending',   NULL, '2026-08-08 14:00+00'),
  (u('0e000000',4),  u('aaaaaaaa',1), u('0d000000',4), NULL, 'order_payment_held',     7000,   'pending',   NULL, '2026-08-08 23:00+00'),
  (u('0e000000',5),  u('aaaaaaaa',1), u('0d000000',1), NULL, 'order_payment_released', 7000,   'available', NULL, '2026-08-09 20:00+00'),
  (u('0e000000',6),  u('aaaaaaaa',1), u('0d000000',2), NULL, 'refund_deducted',        200,    'pending',   NULL, '2026-08-10 01:00+00'),
  (u('0e000000',7),  u('aaaaaaaa',1), u('0d000000',2), NULL, 'order_payment_released', 7000,   'available', 'released in full although 200 was refunded', '2026-08-10 05:00+00'),
  (u('0e000000',8),  u('aaaaaaaa',1), u('0d000000',3), NULL, 'order_payment_released', 6800,   'available', 'clamped: the earlier over-release', '2026-08-10 14:00+00'),
  (u('0e000000',9),  u('aaaaaaaa',1), u('0d000000',4), NULL, 'order_payment_released', 7000,   'available', NULL, '2026-08-10 23:00+00'),
  (u('0e000000',10), u('aaaaaaaa',1), NULL, u('0b000000',1), 'withdrawal_reserved',   -10900, 'available', NULL, '2026-08-20 10:00+00'),
  (u('0e000000',11), u('aaaaaaaa',1), NULL, u('0b000000',2), 'withdrawal_reserved',   -6000,  'available', NULL, '2026-08-25 10:00+00'),
  (u('0e000000',12), u('aaaaaaaa',1), NULL, u('0b000000',3), 'withdrawal_reserved',   -3000,  'available', NULL, '2026-08-30 10:00+00'),
  (u('0e000000',13), u('aaaaaaaa',1), NULL, u('0b000000',3), 'withdrawal_reversed',   3000,   'available', NULL, '2026-08-30 10:05+00'),
  (u('0e000000',14), u('aaaaaaaa',1), NULL, u('0b000000',4), 'withdrawal_reserved',   -4000,  'available', NULL, '2026-09-03 10:00+00'),
  -- the refund on an UNPAID order, labelled "pending" although nothing was ever escrowed (the first of §5.1's two misstatements)
  (u('0e000000',15), u('aaaaaaaa',1), u('0d000000',5), NULL, 'refund_deducted',        100,    'pending',   NULL, '2026-09-04 09:00+00');

INSERT INTO refund_requests (id, order_id, requested_by, reason, status, reviewed_by, created_at, reviewed_at, amount) VALUES
  (u('0f000000',1), u('0d000000',2), u('a0000000',5), 'Missing item',        'completed', u('cccccccc',9), '2026-08-09 12:00+00', '2026-08-10 01:00+00', 200),
  (u('0f000000',2), u('0d000000',5), u('a0000000',6), 'Wrong order',         'completed', u('cccccccc',9), '2026-09-04 08:00+00', '2026-09-04 09:00+00', 100);

INSERT INTO complaints (id, tenant_id, order_id, issue_type, description, status, is_escalated, escalation_reason, resolution_notes, created_at, updated_at, refunded_amount) VALUES
  (u('0c000000',1), u('aaaaaaaa',1), u('0d000000',2),  'Missing item',   'The sauce was missing.',      'resolved', false, NULL, 'Refunded 200', '2026-08-09 11:00+00', '2026-08-10 01:00+00', 200),
  (u('0c000000',2), u('aaaaaaaa',1), u('0d000000',6),  'late delivery',  'Arrived after 90 minutes.',   'open',     false, NULL, NULL,           '2026-09-01 11:00+00', '2026-09-01 11:00+00', NULL),
  (u('0c000000',3), u('aaaaaaaa',1), u('0d000000',7),  'cold food',      'It was cold.',                'rejected', false, NULL, 'Not upheld',   '2026-09-02 11:00+00', '2026-09-02 12:00+00', NULL);

INSERT INTO reviews (id, tenant_id, menu_item_id, customer_id, rating, comment, created_at)
VALUES (u('0c100000',1), u('aaaaaaaa',1), u('d0000000',1), u('a0000000',6), 5, 'Lovely.', '2026-08-12 12:00+00');

-- ---- mobile money (23): 17 collections (4 successful, 6 failed, 7 pending), 4 payouts, 2 refunds ------------
INSERT INTO momo_transactions (id, reference_id, type, purpose, tenant_id, order_id, withdrawal_request_id, refund_request_id, phone_number, amount, currency, status, poll_attempts, created_at, updated_at)
SELECT u('0a100000', n), u('0a200000', n), 'collection', 'order_payment', u('aaaaaaaa',1), u('0d000000', n), NULL, NULL, '0788000005', 7000, 'EUR',
       CASE WHEN n <= 4 THEN 'successful' ELSE 'pending' END, 1,
       '2026-08-07 10:00+00'::timestamptz + n * interval '9 hours', '2026-08-07 10:05+00'::timestamptz + n * interval '9 hours'
  FROM generate_series(1, 4) n;
INSERT INTO momo_transactions (id, reference_id, type, purpose, tenant_id, order_id, phone_number, amount, currency, status, poll_attempts, created_at, updated_at)
SELECT u('0a100000', 10 + n), u('0a200000', 10 + n), 'collection', 'order_payment', u('aaaaaaaa',1), u('0d000000', 4 + n), '0788000006', 1000, 'EUR',
       CASE WHEN n <= 6 THEN 'failed' ELSE 'pending' END, 3, '2026-08-20 10:00+00'::timestamptz + n * interval '1 hour', '2026-08-20 10:10+00'::timestamptz + n * interval '1 hour'
  FROM generate_series(1, 13) n WHERE n <= 13;
-- only 13 rows above would make 17; keep exactly 13 (4 + 13 = 17): 6 failed, 7 pending

INSERT INTO momo_transactions (id, reference_id, type, purpose, tenant_id, withdrawal_request_id, phone_number, amount, currency, status, poll_attempts, created_at, updated_at)
SELECT u('0a100000', 40 + n), u('0a200000', 40 + n), 'disbursement', 'withdrawal', u('aaaaaaaa',1), u('0b000000', n), '0788000001',
       (ARRAY[10900, 6000, 3000, 4000])[n], 'EUR', CASE WHEN n = 3 THEN 'failed' ELSE 'successful' END, 1,
       (ARRAY['2026-08-20 10:00+00','2026-08-25 10:00+00','2026-08-30 10:00+00','2026-09-03 10:00+00'])[n]::timestamptz,
       (ARRAY['2026-08-20 10:05+00','2026-08-25 10:05+00','2026-08-30 10:05+00','2026-09-03 10:05+00'])[n]::timestamptz
  FROM generate_series(1, 4) n;
INSERT INTO momo_transactions (id, reference_id, type, purpose, tenant_id, order_id, refund_request_id, phone_number, amount, currency, status, poll_attempts, created_at, updated_at)
VALUES (u('0a100000', 50), u('0a200000', 50), 'disbursement', 'refund', u('aaaaaaaa',1), u('0d000000',2), u('0f000000',1), '0788000005', 200, 'EUR', 'successful', 1, '2026-08-10 01:00+00', '2026-08-10 01:05+00'),
       (u('0a100000', 51), u('0a200000', 51), 'disbursement', 'refund', u('aaaaaaaa',1), u('0d000000',5), u('0f000000',2), '0788000006', 100, 'EUR', 'successful', 1, '2026-09-04 09:00+00', '2026-09-04 09:05+00');

-- ---- notifications (63) and posts (2): no home in the new schema --------------------------------------------
INSERT INTO notifications (id, tenant_id, user_id, message, icon, action_url, is_read, created_at)
SELECT u('0aa00000', n), CASE WHEN n % 3 = 0 THEN u('bbbbbbbb',1) ELSE u('aaaaaaaa',1) END, CASE WHEN n % 3 = 0 THEN u('b0000000',1) ELSE u('a0000000',1) END,
       'New order #' || n, 'bell', '/admin/orders', n % 2 = 0, '2026-08-07 10:00+00'::timestamptz + n * interval '2 hours'
  FROM generate_series(1, 63) n;
INSERT INTO posts (id, slug, title, content) VALUES (u('0ee00000',1), 'hello', 'Hello', 'First post.'), (u('0ee00000',2), 'second', 'Second', 'Another.');

-- the platform settings row
UPDATE platform_settings SET default_hold_minutes = 90, default_settlement_mode = 'manual';
