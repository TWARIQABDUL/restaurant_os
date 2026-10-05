// client/src/onboarding/lines.ts — milestone 26, from project/Onboarding.dc.html. The wording and rules, with no React in them.
//
// THE BOARD'S INDUSTRY TILES ARE ITS OWN LIST (food, clothing, beauty, electronics, grocery, pharmacy, services, other) and the
// database's templates are a different one (food, fashion, beauty, electronics, grocery, furniture, services, pharmacy-as-a-draft).
// The database is the truth — a tile that pinned nothing would be a lie about what gets set up — so the tiles are the
// templates the server offers, with the board's own one-line description where it has one, and "Other" as the one tile that
// is not a template: a store with no business type, which is a state the config engine already supports.

export const OTHER = '__other__';

/** What the board says each business gets, keyed by template. A template the board never drew gets its name and no promise. */
export const WHAT_YOU_GET: Record<string, { sets: string; category: string; product: string; hint: string }> = {
  food: { sets: 'Menu with categories, extras and spice, pickup and delivery, table ordering', category: 'Burgers', product: 'Chicken Burger', hint: 'extras or spice level' },
  fashion: { sets: 'Sizes and colors as variants, stock per variant, size guide', category: 'Tops', product: 'Everyday T-Shirt', hint: 'size and color' },
  beauty: { sets: 'Brands, sizes, shade variants, optional appointments', category: 'Skincare', product: 'Face Cleanser', hint: 'size or shade' },
  electronics: { sets: 'Specifications, storage and color variants, warranty options', category: 'Phones', product: 'Smartphone', hint: 'storage or warranty' },
  grocery: { sets: 'Sold by weight or unit, substitutions, delivery slots', category: 'Fresh produce', product: 'Tomatoes (1 kg)', hint: 'weight' },
  services: { sets: 'Bookable time slots, staff, deposits', category: 'Services', product: 'Haircut', hint: 'duration' },
  furniture: { sets: 'Dimensions, materials and finishes as variants, delivery by size', category: 'Chairs', product: 'Dining Chair', hint: 'material or finish' },
  [OTHER]: { sets: 'Standard catalog with optional variants', category: 'General', product: 'Your product', hint: 'size or color' },
};

export const whatFor = (key: string | null): (typeof WHAT_YOU_GET)[string] => WHAT_YOU_GET[key ?? OTHER] ?? WHAT_YOU_GET[OTHER]!;

export const STEPS = ['Your business', 'Your account', 'Look and feel', 'First product', 'Ready'] as const;
export type Step = 0 | 1 | 2 | 3 | 4;

export const BRAND_COLORS: readonly { hex: string; name: string }[] = [
  { hex: '#1D6B47', name: 'Green' },
  { hex: '#B8452B', name: 'Terracotta' },
  { hex: '#2A55A0', name: 'Blue' },
  { hex: '#7A3E8F', name: 'Plum' },
  { hex: '#8F5200', name: 'Amber' },
  { hex: '#17160F', name: 'Black' },
];

export const MIN_PASSWORD = 10;

export type AccountDraft = { name: string; email: string; phone: string; password: string };

/** Why the account step cannot continue, in the order a person would fix it — null when it can. */
export function accountProblem(a: AccountDraft): string | null {
  if (a.name.trim().length < 2) return 'Enter your name.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email.trim())) return 'Enter a valid email address.';
  if (a.password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters for your password.`;
  return null;
}

export const businessReady = (name: string, industry: string | null, slugOk: boolean): boolean => name.trim().length >= 2 && industry !== null && slugOk;

/** A price field accepts whole numbers only: the launch currency has no minor unit. */
export const cleanPrice = (raw: string): string => raw.replace(/[^\d]/g, '').slice(0, 9);
