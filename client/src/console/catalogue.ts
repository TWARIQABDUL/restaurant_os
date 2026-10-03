// client/src/console/catalogue.ts — milestone 22, from project/AddProduct.dc.html and MobileAddProduct.dc.html.
//
// THE EDITOR'S ARITHMETIC, with no React in it: which variants exist, what each one costs, and how the screen's
// state becomes the document the server saves. Kept out of the component for the reason lines.ts and Orders'
// statusMeta() were — the render gate can call these directly, and a rule that lives in a component is only
// tested by whatever markup happens to be scraped.
//
// THE BOARD'S OWN RULES, which this file keeps rather than re-deriving:
//   * a variant is the cartesian product of the "One" groups ONLY. `attrs.filter(a => a.mode === 'one' &&
//     a.values.length)` — a group with no values yet is not a dimension, and a "Several" group (Extras) is
//     priced on the line at checkout, never a row here.
//   * a variant's price is the base price plus its values' extras: `base + c.reduce((t, v) => t + v.p, 0)`.
//   * stock is asked for only when the switch is on, and the SINGLE field appears only when there are no variants.

import { addDecimal, parseDecimal, toDecimalString } from '../app/core.ts';
import type { Decimal } from '../app/core.ts';
import type { EditorGroup, EditorValue, EditorVariant, ProductDoc, ProductSaved } from './api.ts';

/** A group as the editor holds it: the saved shape plus the half-typed value being added. */
export type EditGroup = EditorGroup & {
  /** Stable across renders and renames, because `id` is null until the first save. */
  uid: string;
  draft: string;
  draftPrice: string;
};

/** Per-combination edits, keyed by the value keys joined — the same identity the server resolves. */
export type VariantEdit = { sku: string; stock: string; available: boolean };
export type VariantEdits = Record<string, VariantEdit>;

export type EditState = {
  name: string;
  description: string;
  price: string;
  compareAt: string;
  status: 'active' | 'draft';
  categoryIds: string[];
  images: string[];
  trackStock: boolean;
  hasOptions: boolean;
  sku: string;
  stock: string;
  groups: EditGroup[];
  variantEdits: VariantEdits;
};

export const EMPTY_STATE: EditState = {
  name: '',
  description: '',
  price: '',
  compareAt: '',
  status: 'active',
  categoryIds: [],
  images: [],
  trackStock: false,
  hasOptions: false,
  sku: '',
  stock: '',
  groups: [],
  variantEdits: {},
};

let counter = 0;
/** A key for a thing that has no id yet. The server replaces it; it only has to be unique on this page. */
export function freshKey(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}`;
}

export const comboId = (keys: readonly string[]): string => keys.join('|');

/** Digits and at most one decimal point — what a price box may hold. Never parsed to a float. */
export function cleanAmount(raw: string): string {
  const kept = raw.replace(/[^0-9.]/g, '');
  const dot = kept.indexOf('.');
  return dot === -1 ? kept : kept.slice(0, dot + 1) + kept.slice(dot + 1).replace(/\./g, '');
}

export function cleanCount(raw: string): string {
  return raw.replace(/[^0-9]/g, '');
}

/** The "One" groups that are dimensions right now: pick-one and with at least one value. */
export function dimensions(state: EditState): EditGroup[] {
  return state.hasOptions ? state.groups.filter((g) => g.mode === 'one' && g.values.length > 0) : [];
}

export type VariantRow = {
  id: string;
  keys: string[];
  label: string;
  /** Formatted by the caller from this decimal string. */
  price: string;
  values: EditorValue[];
};

/**
 * The matrix, in the board's order: the first group varies slowest. `base` is a decimal string.
 *
 * The price adds decimal STRINGS through packages/core. The board's `base + c.reduce(...)` is integer
 * arithmetic on parsed ints; with a currency that has decimals that is the float bug milestone 13 exists to
 * prevent.
 */
/** A half-typed amount ("", ".", "12.") is zero rather than an exception: it is on screen mid-keystroke. */
function dec(raw: string): Decimal {
  try {
    return parseDecimal(raw === '' ? '0' : raw);
  } catch {
    return parseDecimal('0');
  }
}

export function variantRows(state: EditState): VariantRow[] {
  const dims = dimensions(state);
  if (dims.length === 0) return [];
  let combos: EditorValue[][] = [[]];
  for (const g of dims) combos = combos.flatMap((c) => g.values.map((v) => [...c, v]));

  const base = dec(state.price);
  return combos.map((c) => ({
    id: comboId(c.map((v) => v.key)),
    keys: c.map((v) => v.key),
    values: c,
    label: c.map((v) => v.label).join(' / '),
    price: toDecimalString(c.reduce((total, v) => addDecimal(total, dec(v.priceDelta)), base)),
  }));
}

export function editFor(state: EditState, id: string): VariantEdit {
  return state.variantEdits[id] ?? { sku: '', stock: '', available: true };
}

/** "TS-BLA-S"-style suggestion shown as a placeholder: first letters of the name, then of each value. */
export function suggestSku(name: string, row: VariantRow): string {
  const code = name.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || 'SKU';
  const tail = row.values.map((v) => v.label.replace(/\s+/g, '').slice(0, 3).toUpperCase());
  return [code, ...tail].join('-');
}

/** Saved product → what the screen edits. */
export function stateFrom(p: ProductSaved): EditState {
  const groups: EditGroup[] = p.groups.map((g) => ({
    ...g,
    uid: g.id ?? freshKey('g'),
    draft: '',
    draftPrice: '',
  }));
  const variantEdits: VariantEdits = {};
  for (const v of p.variants) {
    variantEdits[comboId(v.combo)] = {
      sku: v.sku ?? '',
      stock: v.stock === null ? '' : String(v.stock),
      available: v.available,
    };
  }
  return {
    name: p.name,
    description: p.description,
    price: trimZeros(p.price),
    compareAt: p.compareAtPrice === null ? '' : trimZeros(p.compareAtPrice),
    status: p.status,
    categoryIds: p.categoryIds,
    images: p.images.map((i) => i.url),
    trackStock: p.trackStock,
    hasOptions: groups.length > 0,
    sku: p.sku ?? '',
    stock: p.stock === null ? '' : String(p.stock),
    groups: groups.map((g) => ({
      ...g,
      values: g.values.map((v) => ({ ...v, priceDelta: trimZeros(v.priceDelta) })),
    })),
    variantEdits,
  };
}

/** "3500.00" → "3500". Display only: the server stores two places, the box should not show noise. */
export function trimZeros(amount: string): string {
  return amount.includes('.') ? amount.replace(/\.?0+$/, '') : amount;
}

/** The screen → the document. Every request carries the whole product. */
export function toDoc(state: EditState, status: 'active' | 'draft'): ProductDoc {
  const groups: EditorGroup[] = state.hasOptions
    ? state.groups.map((g) =>
        g.shared
          ? { id: g.id, shared: true, name: g.name, mode: g.mode, values: g.values }
          : {
              id: g.id,
              shared: false,
              name: g.name.trim(),
              mode: g.mode,
              values: g.values.map((v) => ({ key: v.key, label: v.label.trim(), priceDelta: v.priceDelta === '' ? '0' : v.priceDelta })),
            },
      )
    : [];

  const withOptions = { ...state, groups };
  const rows = variantRows({ ...withOptions, groups: groups.map((g) => ({ ...g, uid: '', draft: '', draftPrice: '' })) });
  const variants: EditorVariant[] = rows.map((r) => {
    const e = editFor(state, r.id);
    return {
      combo: r.keys,
      sku: e.sku.trim() === '' ? null : e.sku.trim(),
      stock: state.trackStock ? (e.stock === '' ? 0 : Number(e.stock)) : null,
      available: e.available,
    };
  });

  const simple = rows.length === 0;
  return {
    name: state.name.trim(),
    description: state.description,
    price: state.price,
    compareAtPrice: state.compareAt.trim() === '' ? null : state.compareAt,
    status,
    categoryIds: state.categoryIds,
    images: state.images,
    trackStock: state.trackStock,
    sku: simple && state.sku.trim() !== '' ? state.sku.trim() : null,
    stock: simple && state.trackStock ? (state.stock === '' ? 0 : Number(state.stock)) : null,
    groups: groups.map((g) => (g.shared ? { id: g.id, shared: true as const, name: g.name, mode: g.mode, values: [] } : g)),
    variants,
  };
}

/** What stops "Save" and in words, or null. The server re-checks every one; these save the round trip. */
export function problems(state: EditState): string | null {
  if (state.name.trim() === '') return 'Give the product a name.';
  if (state.price === '' || Number(state.price) < 0) return 'Enter a price.';
  if (state.compareAt !== '' && Number(state.compareAt) <= Number(state.price)) {
    return 'The compare-at price has to be higher than the price.';
  }
  const names = new Set<string>();
  for (const g of state.hasOptions ? state.groups : []) {
    if (g.shared) continue;
    const key = g.name.trim().toLowerCase();
    if (key === '') return 'Give every option a name, or remove it.';
    if (names.has(key)) return `You have two options called “${g.name.trim()}”.`;
    names.add(key);
    if (g.values.length === 0) return `Add at least one value to “${g.name.trim()}”, or remove it.`;
  }
  return null;
}

/** The board's preview line under the name: "Size: S · M · L" for the first One group, else "No options". */
export function previewMeta(state: EditState): string {
  const first = dimensions(state)[0];
  if (first !== undefined) return `${first.name}: ${first.values.map((v) => v.label).join(' · ')}`;
  const several = state.hasOptions ? state.groups.find((g) => g.mode === 'several' && g.values.length > 0) : undefined;
  return several === undefined ? 'No options' : `+ ${several.name.toLowerCase()}`;
}
