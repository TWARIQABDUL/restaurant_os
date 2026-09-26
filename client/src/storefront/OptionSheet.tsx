// client/src/storefront/OptionSheet.tsx — milestone 16.
//
// The sheet that opens when a product has something to choose. `Shop` draws it at 390 and `StoreDesktop`
// is still owed one by the designer (Part 9), so on desktop this renders centred — Main's rule for that
// width: "600–1023 — centred sheet for options".
//
// THE VARIANT IS DERIVED FROM THE CHOICES, not chosen directly, and this is the piece of the storefront
// that most depends on V003 being right. "Pick one" groups are the variant's dimensions — Size × Colour
// is twelve rows, each with its own stock — so choosing M and Black IS choosing TEE-M-BLA. "Pick several"
// groups are not dimensions; they are priced per line. So:
//
//   every 'one' group chosen   → exactly one variant matches → that is what goes in the cart
//   a 'several' group          → its values ride along as optionValueIds
//
// A COMBINATION THAT DOES NOT EXIST IS UNPICKABLE. With twelve variants and two sold out, XL/Black and
// XL/Sand are struck through — Industries.dc.html's rule, which V003 quotes: unavailable combinations are
// struck through "instead of hiding them, so the customer can see the size exists". Working out which
// values to strike means asking, for each value, whether ANY variant containing it is still buyable given
// what else is already chosen. That is what availableValues() does, and it is the reason this component
// is more than a form.
//
// THE PRICE UPDATES AS THEY CHOOSE, which is why packages/core's formatter had to reach the browser: the
// CTA reads "Add · 8,000 RWF" and the number moves when Cheese is ticked.

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { BottomSheet } from '../shared/ui/index.ts';
import { Button, OptionGroup, QuantityStepper } from '../shared/ui/index.ts';
import { addDecimal, multiplyDecimal, parseDecimal, toDecimalString } from '../app/core.ts';
import { useStore } from './StoreProvider.tsx';
import type { ProductDetailData, VariantData } from './api.ts';

/** A variant can be bought when it is available and, if the product counts stock, has some. */
function buyable(variant: VariantData, trackStock: boolean): boolean {
  return variant.isAvailable && (!trackStock || (variant.stockQuantity ?? 0) > 0);
}

/**
 * Which option values can still be chosen, given what is already chosen.
 *
 * For a value in group G: hold every OTHER 'one' choice fixed, and ask whether any buyable variant
 * carries this value alongside them. Choices in G itself are ignored, or picking a size would rule out
 * every other size.
 *
 * Exported for the render gate, which checks the sold-out rule against the twelve-variant linen tee
 * rather than against a prose description of it.
 */
export function availableValues(
  product: ProductDetailData,
  chosen: Record<string, string[]>,
): Set<string> {
  const singleGroups = product.groups.filter((g) => g.selectMode === 'one');
  const out = new Set<string>();

  // A product with no variant dimensions has nothing to strike through: every value is an extra.
  if (singleGroups.length === 0) {
    for (const group of product.groups) for (const value of group.values) {
      if (value.isAvailable) out.add(value.id);
    }
    return out;
  }

  for (const group of product.groups) {
    for (const value of group.values) {
      if (!value.isAvailable) continue;

      if (group.selectMode === 'several') {
        // Extras are not dimensions, so their availability is their own.
        out.add(value.id);
        continue;
      }

      const others = singleGroups.filter((g) => g.id !== group.id);
      const reachable = product.variants.some((variant) => {
        if (!buyable(variant, product.trackStock)) return false;
        if (!variant.optionValueIds.includes(value.id)) return false;
        return others.every((other) => {
          const pick = chosen[other.id]?.[0];
          // Nothing chosen in the other group yet, so every variant still counts.
          if (pick === undefined) return true;
          return variant.optionValueIds.includes(pick);
        });
      });
      if (reachable) out.add(value.id);
    }
  }
  return out;
}

/** The one variant matching every 'one' choice, or null while a choice is outstanding. */
export function matchVariant(
  product: ProductDetailData,
  chosen: Record<string, string[]>,
): VariantData | null {
  const singleGroups = product.groups.filter((g) => g.selectMode === 'one');
  if (singleGroups.length === 0) {
    return product.variants.find((v) => v.isDefault) ?? product.variants[0] ?? null;
  }
  const picks = singleGroups.map((g) => chosen[g.id]?.[0]);
  if (picks.some((p) => p === undefined)) return null;
  return (
    product.variants.find((variant) =>
      picks.every((pick) => pick !== undefined && variant.optionValueIds.includes(pick)),
    ) ?? null
  );
}

/** base price + every chosen value's delta, exactly. */
export function unitPriceOf(product: ProductDetailData, chosen: Record<string, string[]>): string {
  let total = parseDecimal(product.price);
  for (const group of product.groups) {
    for (const id of chosen[group.id] ?? []) {
      const value = group.values.find((v) => v.id === id);
      if (value !== undefined) total = addDecimal(total, parseDecimal(value.priceDelta));
    }
  }
  return toDecimalString(total);
}

type Props = {
  product: ProductDetailData;
  open: boolean;
  onClose: () => void;
  onAdd: (variantId: string, optionValueIds: string[], quantity: number) => void;
  busy?: boolean;
  /** The message from a refused add — a variant that sold out while they were choosing. */
  error?: string | null;
};

export function OptionSheet({ product, open, onClose, onAdd, busy = false, error = null }: Props): ReactNode {
  const { money, has } = useStore();

  // Pre-select nothing. The board's own sheet pre-selects a default for Spice level ("pre: 'medium'") but
  // the schema has no column for a default value, so pre-selecting one here would be this component
  // inventing a merchant's choice. Everything required is simply asked for.
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [quantity, setQuantity] = useState(1);

  const available = useMemo(() => availableValues(product, chosen), [product, chosen]);
  const variant = matchVariant(product, chosen);
  const unit = unitPriceOf(product, chosen);

  // `modifiers` gates priced extras — V002's own module. A store on a template without it does not show
  // them even if a group is attached, because the config engine is what decides which features a store has.
  const groups = product.groups.filter((g) => g.selectMode === 'one' || has('modifiers'));

  const missing = groups.find((g) => g.selectMode === 'one' && (chosen[g.id] ?? []).length === 0);
  const soldOut = variant !== null && !buyable(variant, product.trackStock);
  const canAdd = variant !== null && !soldOut && missing === undefined && !busy;

  const cta =
    missing !== undefined
      ? `Choose ${missing.name.toLowerCase()}`
      : soldOut || variant === null
        ? 'Sold out'
        : `Add · ${money(toDecimalString(multiplyDecimal(parseDecimal(unit), quantity)))}`;

  // "Only 2 left in size 43" — the board's own sentence, reachable only once a variant is settled.
  const note =
    variant !== null && product.trackStock && variant.stockQuantity !== null && variant.stockQuantity > 0
      ? `Only ${variant.stockQuantity} left`
      : null;

  return (
    <BottomSheet open={open} onClose={onClose} title={product.name}>
      <div className="flex flex-col gap-4">
        <div className="flex items-baseline gap-2">
          <span className="text-title font-bold">{money(unit)}</span>
          {product.compareAtPrice === null ? null : (
            <s className="text-body text-store-muted">{money(product.compareAtPrice)}</s>
          )}
        </div>
        {product.description === '' ? null : (
          <p className="text-body text-store-muted">{product.description}</p>
        )}
        {note === null ? null : (
          <span className="inline-flex w-fit rounded-chip bg-status-warn px-2.5 py-1 text-caption font-semibold text-status-warn-fg">
            {note}
          </span>
        )}

        {groups.map((group) => (
          <OptionGroup
            key={group.id}
            name={group.name}
            pick={group.selectMode}
            required={group.isRequired}
            values={group.values.map((value) => ({
              id: value.id,
              label: value.label,
              soldOut: !available.has(value.id),
              ...(value.priceDelta === '0.00' || value.priceDelta === '0'
                ? {}
                : { priceLabel: `+${money(value.priceDelta)}` }),
            }))}
            selected={chosen[group.id] ?? []}
            onChange={(selected) => setChosen((current) => ({ ...current, [group.id]: selected }))}
          />
        ))}

        {error === null ? null : (
          <p role="alert" className="text-body font-semibold text-status-danger-fg">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3">
          <QuantityStepper value={quantity} onChange={setQuantity} min={1} max={999} />
          <span className="grow">
            <Button
              variant="primary"
              block
              busy={busy}
              busyLabel="Adding…"
              onClick={() => {
                if (variant === null) return;
                const extras = groups
                  .filter((g) => g.selectMode === 'several')
                  .flatMap((g) => chosen[g.id] ?? []);
                onAdd(variant.id, extras, quantity);
              }}
              disabled={!canAdd}
            >
              {cta}
            </Button>
          </span>
        </div>
      </div>
    </BottomSheet>
  );
}
