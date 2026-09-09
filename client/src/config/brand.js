/**
 * Single source of truth for product naming and the commerce vocabulary.
 *
 * The platform sells any kind of product — the API and database still use
 * some legacy restaurant names (`/menu`, `menu_items`, `add_ons`), but nothing
 * user-facing should. Pull labels from here rather than hardcoding them.
 */

export const BRAND = {
  name: 'Vendly',
  tagline: 'Sell anything. Get paid. Track stock.',
  description:
    'Give your business its own ordering page, take payments you can rely on, and keep stock in check — without stitching together five different tools.',
};

/** Nouns used across the seller-facing UI. */
export const TERMS = {
  product: 'product',
  products: 'products',
  catalogue: 'catalogue',
  option: 'option',
  options: 'options',
  store: 'store',
  stores: 'stores',
  seller: 'seller',
};

export default BRAND;
