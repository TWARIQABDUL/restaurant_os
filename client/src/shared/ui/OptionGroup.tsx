// client/src/shared/ui/OptionGroup.tsx — milestone 14, from project/Main.dc.html.
//
// "Option group (one component, any attribute)" — the board's own heading, and the claim the
// Industries board rests on. Size, Colour, Shade, Storage, Extras, Pack size and Spice level are all
// this component; the config engine's attribute presets decide the name and the rule.
//
// TWO RENDERINGS, ONE COMPONENT, chosen by `pick`, which is V002's own column value:
//   pick 'one'     → pills, exactly one selected  (Size: S M L XL)
//   pick 'several' → checkboxes with prices       (Extras: Cheese +500)
//
// The board: "XL is sold out, so it's struck through and can't be picked. The same group renders
// checkboxes when the merchant chooses 'Several'."

import type { ReactNode } from 'react';
import { Checkbox } from './fields.tsx';

export type OptionValue = {
  id: string;
  label: string;
  /** Formatted by packages/core's money formatter, not here — this takes the finished string. */
  priceLabel?: string;
  soldOut?: boolean;
  /** A colour swatch, for a Colour or Shade group. */
  swatch?: string;
};

type Props = {
  name: string;
  pick: 'one' | 'several';
  required?: boolean;
  values: readonly OptionValue[];
  /** Selected ids. For pick 'one' this holds at most one. */
  selected: readonly string[];
  onChange: (selected: string[]) => void;
};

export function OptionGroup({ name, pick, required = false, values, selected, onChange }: Props): ReactNode {
  return (
    <fieldset className="flex flex-col gap-2 rounded-card border border-line p-3.5">
      <legend className="contents">
        <div className="flex justify-between text-body">
          <strong>{name}</strong>
          <span className="text-muted">
            {pick === 'one' ? 'Pick one' : 'Any'}
            {required ? ' · required' : ''}
          </span>
        </div>
      </legend>

      {pick === 'one' ? (
        <div role="radiogroup" aria-label={name} className="flex flex-wrap gap-1.5">
          {values.map((value) => {
            const on = selected.includes(value.id);
            const out = value.soldOut === true;
            return (
              <button
                key={value.id}
                type="button"
                role="radio"
                aria-checked={on}
                // Sold out is announced as well as struck through: the board's rule is that a state
                // never rests on colour or decoration alone.
                aria-disabled={out}
                disabled={out}
                onClick={() => onChange([value.id])}
                className={`flex h-11 min-w-12 items-center justify-center gap-1.5 rounded-control px-3 text-body font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                  out
                    ? 'cursor-not-allowed border border-dashed border-control-line bg-surface text-disabled line-through'
                    : on
                      ? 'border-2 border-store-primary bg-store-tint text-ink'
                      : 'border border-control-line bg-surface text-ink'
                }`}
              >
                {value.swatch === undefined ? null : (
                  <span
                    aria-hidden="true"
                    className="size-3 rounded-pill border border-control-line"
                    style={{ background: value.swatch }}
                  />
                )}
                {value.label}
                {out ? <span className="sr-only"> — sold out</span> : null}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col">
          {values.map((value) => (
            <div key={value.id} className="flex items-center gap-2 py-1.5 text-body">
              <span className="grow">
                <Checkbox
                  label={value.label}
                  checked={selected.includes(value.id)}
                  onChange={(on) =>
                    onChange(on ? [...selected, value.id] : selected.filter((id) => id !== value.id))
                  }
                />
              </span>
              {value.priceLabel === undefined ? null : <span className="text-muted">{value.priceLabel}</span>}
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}
