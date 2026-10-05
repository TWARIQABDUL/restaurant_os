// packages/core/src/theme/design.ts — milestone 25.
//
// WHAT CUSTOMIZE EDITS THAT IS NOT A COLOUR. The theme compiler (compile.ts) turns eight inputs into a palette and is
// gated on readability; this is the other half of "how a store looks": how products are laid out, which homepage
// sections show, and the logo. It lives in core because the storefront, the studio's preview and the server's
// validation must agree on what a design is, and on what the defaults are when a store never opened the editor.

export const PRODUCT_LAYOUTS = ['grid', 'list'] as const;
export type ProductLayout = (typeof PRODUCT_LAYOUTS)[number];

/**
 * The homepage sections a merchant may switch. `products` is deliberately NOT here: Customize draws it locked on, and a
 * storefront with no products is not a design choice, so the type cannot express it.
 */
export const HOMEPAGE_SECTIONS = ['promo', 'categories', 'featured', 'info'] as const;
export type HomepageSection = (typeof HOMEPAGE_SECTIONS)[number];

export type Design = {
  productLayout: ProductLayout;
  sections: Record<HomepageSection, boolean>;
  /** A path the upload endpoint issued, or null for the letter mark every store has by default. */
  logoUrl: string | null;
};

/** What a store with no design row looks like: the layout the storefront shipped with, and everything shown. */
export const DEFAULT_DESIGN: Design = {
  productLayout: 'grid',
  sections: { promo: true, categories: true, featured: true, info: true },
  logoUrl: null,
};

/** The one shape check shared by the server (on the way in) and the client (before it sends). */
export function isMediaPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/api/media/') && value.length <= 300 && !value.includes('..');
}
