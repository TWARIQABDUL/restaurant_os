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
  secondaryAction,
}: Props): ReactNode {
  return (
    <article className="overflow-hidden rounded-card border border-line bg-surface">
      {/* A placeholder tile, not an <img>: the boards draw one, and a product with no photo is the
          common case for a merchant adding their first ten items from a phone. */}
      <div
        aria-hidden="true"
        className="relative flex h-[92px] items-center justify-center font-display text-[34px]"
        style={{ background: tileBackground, color: tileForeground }}
      >
        {initial}
        {badge === undefined ? null : <CardBadge label={badge.label} tone={badge.tone} />}
      </div>

      <div className="px-2.5 pb-2.5 pt-2">
        <div className={`text-caption font-semibold ${soldOut ? 'text-muted' : 'text-ink'}`}>{name}</div>
        <div className={`mt-0.5 text-caption font-bold ${soldOut ? 'text-muted' : 'text-ink'}`}>
          {price}
          {compareAtPrice === undefined ? null : (
            <s className="ml-1 text-[11px] font-normal text-muted">{compareAtPrice}</s>
          )}
        </div>
        {meta === undefined ? null : <div className="text-[11px] text-muted">{meta}</div>}

        <div className="mt-1 flex justify-end">
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
