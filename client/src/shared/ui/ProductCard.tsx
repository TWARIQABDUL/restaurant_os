// client/src/shared/ui/ProductCard.tsx — milestone 14, from project/Main.dc.html.
//
// "Product card · one component, configured". The board names its slots exactly:
//
//   "Slots: image, name, price (+ compare-at), one meta line (variants, rating, '+ extras', or
//    restock date), badge, action. The store's config fills the slots."
//
// ONE META LINE, not a list — that is what keeps a food card, a fashion card and a pharmacy card the
// same height in the same grid. Whatever the industry puts there is one string, composed by the
// screen from the config engine's vocabulary.
//
// PRICES ARRIVE FORMATTED. packages/core's money formatter turns "3500.00" into "3,500 RWF" from the
// currencies table; a component that formatted its own would be a second implementation of what a
// price looks like.
//
// TWO SCALES, ONE COMPONENT — added at milestone 16. `Main` draws this card at console scale and `Shop`
// and `StoreDesktop` draw it larger, with a tappable tile that opens the product page. Main's own
// responsive rule is that "layouts re-compose at each size; nothing is simply shrunk", so the difference
// is a prop rather than a second component: the slots, the badge rules and the sold-out behaviour are
// the contract, and forking them is how two product cards start disagreeing about what "sold out" looks
// like.
//
// ITS SURFACES ARE THE PER-STORE TOKENS, also milestone 16. A product card only ever renders inside one
// store's context — the storefront, and the merchant's own catalogue, which StorePreview themes too — so
// `bg-store-surface` is what it should have been from the start. Where no store theme is applied these
// resolve to the platform default in tokens.css, which is the same palette the console had, so the
// gallery and the console are unchanged by it.

import type { ReactNode } from 'react';
import { CardBadge } from './Badge.tsx';
import { RoundButton } from './Button.tsx';

type Props = {
  name: string;
  /** Already formatted. */
  price: string;
  /** The struck-through original, when the product is discounted. */
  compareAtPrice?: string;
  /** The single meta line: "+ extras", "S M L XL · ★ 4.6", "Back Friday". */
  meta?: string;
  badge?: { label: string; tone?: 'ink' | 'danger' | 'info' };
  /** Initial and tint for the placeholder tile the boards draw instead of photography. */
  initial: string;
  tileBackground: string;
  tileForeground: string;
  soldOut?: boolean;
  /** The action. Absent for a card that is not orderable. */
  onAdd?: () => void;
  /**
   * Opens the product. Makes the tile itself a button, which is what the storefront boards draw — the
   * photo is the biggest tap target on the card and pointing it at the product page is why.
   */
  onOpen?: () => void;
  /** `compact` is Main's console card. `roomy` is the storefront grid's. */
  scale?: 'compact' | 'roomy';
  /** Replaces the round action — the board's sold-out card offers "Notify me". */
  secondaryAction?: { label: string; onSelect?: () => void };
};

export function ProductCard({
  name,
  price,
  compareAtPrice,
  meta,
  badge,
  initial,
  tileBackground,
  tileForeground,
  soldOut = false,
  onAdd,
  onOpen,
  scale = 'compact',
  secondaryAction,
}: Props): ReactNode {
  const roomy = scale === 'roomy';

  // The tile is a <button> only when there is somewhere to go. An aria-hidden div that happens to be
  // clickable is the version of this that keyboard users cannot use.
  const tile = (
    <>
      <span aria-hidden="true" className={roomy ? 'font-display text-[44px]' : 'font-display text-[34px]'}>
        {initial}
      </span>
      {badge === undefined ? null : <CardBadge label={badge.label} tone={badge.tone} />}
    </>
  );
  const tileClass = `relative flex w-full items-center justify-center ${roomy ? 'h-32' : 'h-[92px]'}`;
  const tileStyle = { background: tileBackground, color: tileForeground };

  return (
    <article className="flex flex-col overflow-hidden rounded-card border border-store-border bg-store-surface">
      {/* A placeholder tile, not an <img>: the boards draw one, and a product with no photo is the
          common case for a merchant adding their first ten items from a phone. */}
      {onOpen === undefined ? (
        <div className={tileClass} style={tileStyle}>
          {tile}
        </div>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`View ${name}`}
          className={`${tileClass} border-0 p-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink`}
          style={tileStyle}
        >
          {tile}
        </button>
      )}

      <div className={roomy ? 'flex grow flex-col px-3 pb-3 pt-2.5' : 'px-2.5 pb-2.5 pt-2'}>
        <div
          className={`${roomy ? 'text-body' : 'text-caption'} font-semibold ${soldOut ? 'text-store-muted' : 'text-store-text'}`}
        >
          {name}
        </div>
        {meta === undefined ? null : (
          <div className={`${roomy ? 'text-caption' : 'text-[11px]'} text-store-muted`}>{meta}</div>
        )}
        <div
          className={`${roomy ? 'mt-auto pt-2 text-body' : 'mt-0.5 text-caption'} font-bold ${soldOut ? 'text-store-muted' : 'text-store-text'}`}
        >
          {price}
          {compareAtPrice === undefined ? null : (
            <s className={`ml-1 font-normal text-store-muted ${roomy ? 'text-caption' : 'text-[11px]'}`}>
              {compareAtPrice}
            </s>
          )}
        </div>

        <div className={roomy ? 'mt-1.5 flex justify-end' : 'mt-1 flex justify-end'}>
          {secondaryAction === undefined ? (
            onAdd === undefined ? null : (
              <RoundButton label={`Add ${name}`} onClick={onAdd}>
                +
              </RoundButton>
            )
          ) : (
            <button
              type="button"
              onClick={secondaryAction.onSelect}
              className="flex h-8 items-center rounded-pill border border-control-line px-2.5 text-caption font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
