// client/src/storefront/tiles.ts — milestone 16.
//
// The placeholder tile behind a product with no photograph.
//
// THE BOARDS DRAW ONE RATHER THAN AN EMPTY BOX, and they are right to: a merchant adding their first ten
// items from a phone has no photography, and `Shop` still has to look like a shop. Each card gets a tinted
// square with the product's initial.
//
// THE TINT IS DERIVED FROM THE PRODUCT ID, not stored and not random. Three properties matter, and a
// random colour has none of them: the same product keeps the same tile across a reload, across pagination
// and between the grid and the product page; two products next to each other rarely match; and no request
// is needed to decide it.
//
// THE PALETTE IS THE BOARDS' OWN. Shop, StoreDesktop and ReviewsCustomer between them draw ten of these
// tints, and they are listed here rather than computed because they are design values — the same reason
// the render gate's ALLOWED_TILE_HEX list has to be edited by hand to add one. A generated palette would
// drift from the artboards the first time somebody adjusted the formula.
//
// WHY THESE ARE HEX RATHER THAN TOKENS, which §2.2 otherwise forbids: a tile tint is data about a product,
// not a theme value. tokens.css holds the palette a store can change; this is a per-product tint that no
// merchant sets and no theme affects. The render gate allows them by name for exactly this reason.

type Tile = { background: string; foreground: string };

/**
 * The ten tints, each with the ink the boards pair it with.
 *
 * The foreground is the board's own `rgba(23,22,15,0.28)` in every case — a wash of the ink colour, so the
 * initial reads as a watermark rather than as text. ReviewsCustomer's larger tile uses a stronger
 * #8A5A2B on #F3E3CF; that pairing is the first entry, since it is the one the board shows at size.
 */
const TILES: readonly Tile[] = [
  { background: '#F3E3CF', foreground: '#8A5A2B' },
  { background: '#EAD9C3', foreground: 'rgba(23,22,15,0.28)' },
  { background: '#E3D5CB', foreground: 'rgba(23,22,15,0.28)' },
  { background: '#F2D7C2', foreground: 'rgba(23,22,15,0.28)' },
  { background: '#E5D0C0', foreground: 'rgba(23,22,15,0.28)' },
  { background: '#F0E2B8', foreground: 'rgba(23,22,15,0.28)' },
  { background: '#DCE4CD', foreground: 'rgba(23,22,15,0.28)' },
  { background: '#DADCE2', foreground: 'rgba(23,22,15,0.28)' },
  { background: '#E6D6C6', foreground: 'rgba(23,22,15,0.28)' },
  { background: '#E8DCC8', foreground: 'rgba(23,22,15,0.28)' },
];

/**
 * A stable tile for a product id.
 *
 * FNV-1a over the id's characters. Not for security — it is a spread function, and the only property
 * asked of it is that two ids rarely land on the same tint. A sum of char codes would put every uuid
 * differing in one hex digit onto a neighbouring colour.
 */
export function tileFor(productId: string): Tile {
  let hash = 0x811c9dc5;
  for (let i = 0; i < productId.length; i += 1) {
    hash ^= productId.charCodeAt(i);
    // The FNV prime, as shifts, so this stays in 32-bit integer arithmetic rather than becoming a float.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return TILES[hash % TILES.length] ?? { background: '#EFEDE7', foreground: '#A8A499' };
}
