// client/src/console/ProductEditor.tsx — milestone 22, from project/AddProduct.dc.html and MobileAddProduct.dc.html.
//
// ONE EDITOR, TWO BOARDS. `AddProduct` is the desktop (a form on the left, status and a live preview on the
// right) and `MobileAddProduct` is the phone (one column, a bar at the foot with "Save draft" and "Publish").
// Main's rule is "layouts re-compose at each size; nothing is simply shrunk", so this is one tree: the aside
// stacks under the form below `lg`, and the two actions live in the header on a desktop and in a fixed footer
// on a phone. The same state feeds both, so a phone and a laptop cannot disagree about what a product is.
//
// THE MATRIX IS DERIVED, NOT STORED. The variants on screen are the cartesian product of the "One" groups'
// values (catalogue.ts variantRows()), and what the merchant types into them — a SKU, a count — is kept in a
// map keyed by the combination. Adding "XL" therefore adds its rows empty and leaves every existing row's
// numbers where they were, and the server matches combinations back to the variants it already has so an order
// line never loses its variant. The board does the same: its `variants` is recomputed from `attrs` each render.
//
// WHAT AN ORDER LOCKS. A product that has been ordered keeps its option STRUCTURE (the server says why, in
// products.ts): groups cannot be added or removed and a group's "One/Several" cannot be switched. The editor
// says so up front rather than letting the merchant build something the server will refuse; values, prices,
// counts, photos and the status all stay editable.
//
// PHOTOS GO UP ONE AT A TIME THE MOMENT THEY ARE CHOSEN, and the product keeps only the path the server
// returned. Nothing in the document is a file, so "Save" stays a small JSON request and a failed photo fails
// alone, in place, with its reason.
//
// STOCK IS ASKED FOR ONLY WHERE THE STORE TRACKS IT (`has('stock')`), and "several" is offered only where the
// template switches on priced extras (`has('modifiers')`) — the config engine's gates, not an industry's name.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, ProductCard, Segmented, Switch, TextField, Toast } from '../shared/ui/index.ts';
import { tileFor } from '../storefront/tiles.ts';
import { categoriesApi, productsApi } from './api.ts';
import type { CategoryRow } from './api.ts';
import {
  EMPTY_STATE,
  cleanAmount,
  cleanCount,
  editFor,
  freshKey,
  previewMeta,
  problems,
  stateFrom,
  suggestSku,
  toDoc,
  variantRows,
} from './catalogue.ts';
import type { EditGroup, EditState } from './catalogue.ts';
import { hrefFor } from './nav.ts';
import { useShell } from './ShellProvider.tsx';

const MAX_PHOTOS = 8;
const ACCEPT = 'image/jpeg,image/png,image/webp';

const EXAMPLES: Record<string, string> = {
  size: 'XXL',
  color: 'Navy',
  colour: 'Navy',
  'spice level': 'Extra hot',
  extras: 'Avocado',
  material: 'Linen',
  storage: '256GB',
};

type Props = {
  navigate: (to: string) => void;
  /** Null for "New product". */
  productId: string | null;
  /** The render gate's seam: effects do not run in static markup. Console.tsx passes none. */
  initialState?: EditState;
  initialSold?: boolean;
  initialCategories?: CategoryRow[];
};

export function ProductEditor({ navigate, productId, initialState, initialSold, initialCategories }: Props): ReactNode {
  const { store, t, has, attributes, money, currency, may } = useShell();

  const [state, setState] = useState<EditState | null>(initialState ?? (productId === null ? EMPTY_STATE : null));
  const [sold, setSold] = useState(initialSold ?? false);
  const [categories, setCategories] = useState<CategoryRow[]>(initialCategories ?? []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [newSection, setNewSection] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [bulkStock, setBulkStock] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const one = t('product', 'one').toLowerCase();
  const sectionOne = t('category', 'one').toLowerCase();
  const tracksStock = has('stock');
  const offersExtras = has('modifiers');

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((current) => (current === m ? null : current)), 3500);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (productId === null) return;
    try {
      const { product } = await productsApi.get(store.id, productId);
      setState(stateFrom(product));
      setSold(product.sold);
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause instanceof ApiFailure ? cause.message : `That ${one} could not be loaded.`);
    }
  }, [store.id, productId, one]);

  useEffect(() => {
    if (initialState === undefined) void load();
  }, [load, initialState]);

  useEffect(() => {
    if (initialCategories !== undefined) return;
    void categoriesApi
      .list(store.id)
      .then((r) => setCategories(r.categories))
      .catch(() => undefined);
  }, [store.id, initialCategories]);

  const back = (): void => navigate(hrefFor(store.slug, '/products'));

  if (!may('products.write')) {
    return (
      <Alert tone="info" headline={`Your role can’t manage ${t('product', 'many').toLowerCase()}.`}>
        <span>Ask the owner of {store.name} to change your role.</span>
      </Alert>
    );
  }

  if (state === null) {
    return loadError === null ? (
      <div className="flex flex-col gap-3" aria-busy="true">
        <div className="h-24 animate-pulse rounded-card bg-status-neutral" />
        <div className="h-48 animate-pulse rounded-card bg-status-neutral" />
      </div>
    ) : (
      <Alert tone="danger" headline={loadError}>
        <Button variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
        <Button variant="text" tone="brand" onClick={back}>
          Back to {t('product', 'many').toLowerCase()}
        </Button>
      </Alert>
    );
  }

  const s = state;
  const set = (patch: Partial<EditState>): void => setState((prev) => (prev === null ? prev : { ...prev, ...patch }));
  const setGroup = (uid: string, patch: Partial<EditGroup>): void =>
    setState((prev) => (prev === null ? prev : { ...prev, groups: prev.groups.map((g) => (g.uid === uid ? { ...g, ...patch } : g)) }));
  const setEdit = (id: string, patch: Partial<{ sku: string; stock: string; available: boolean }>): void =>
    setState((prev) => (prev === null ? prev : { ...prev, variantEdits: { ...prev.variantEdits, [id]: { ...editFor(prev, id), ...patch } } }));

  const rows = variantRows(s);
  const isBlockedByOrders = sold;
  const priceReady = s.price !== '' && s.price !== '.';
  const editing = productId !== null;

  const addGroup = (name: string, mode: 'one' | 'several' = 'one'): void =>
    set({
      hasOptions: true,
      groups: [...s.groups, { uid: freshKey('g'), id: null, shared: false, name, mode, values: [], draft: '', draftPrice: '' }],
    });

  const addValue = (g: EditGroup): void => {
    const label = g.draft.trim();
    if (label === '') return;
    if (g.values.some((v) => v.label.toLowerCase() === label.toLowerCase())) {
      flash(`“${g.name || 'This option'}” already has “${label}”.`);
      return;
    }
    setGroup(g.uid, {
      values: [...g.values, { key: freshKey('v'), label, priceDelta: g.draftPrice === '' ? '0' : g.draftPrice }],
      draft: '',
      draftPrice: '',
    });
  };

  const choosePhotos = async (files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0) return;
    const room = MAX_PHOTOS - s.images.length;
    const take = [...files].slice(0, Math.max(0, room));
    if (take.length < files.length) setPhotoError(`A ${one} can have up to ${MAX_PHOTOS} photos.`);
    else setPhotoError(null);

    setUploading((n) => n + take.length);
    for (const file of take) {
      try {
        const { url } = await productsApi.uploadPhoto(store.id, file);
        setState((prev) => (prev === null ? prev : { ...prev, images: [...prev.images, url] }));
      } catch (cause) {
        setPhotoError(
          cause instanceof ApiFailure && cause.status === 413
            ? `${file.name} is over 5 MB. Try a smaller photo.`
            : cause instanceof ApiFailure
              ? cause.message
              : `${file.name} could not be uploaded.`,
        );
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (fileInput.current !== null) fileInput.current.value = '';
  };

  const save = async (status: 'active' | 'draft'): Promise<void> => {
    const problem = problems(s);
    if (problem !== null) {
      setSaveError(problem);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const doc = toDoc(s, status);
      if (productId === null) await productsApi.create(store.id, doc);
      else await productsApi.save(store.id, productId, doc);
      back();
    } catch (cause) {
      setSaveError(cause instanceof ApiFailure ? cause.message : 'That could not be saved. Nothing was changed.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setSaving(false);
    }
  };

  const addSection = async (): Promise<void> => {
    const name = newSection.trim();
    if (name === '') return;
    try {
      const { categories: next } = await categoriesApi.create(store.id, name);
      setCategories(next);
      const created = next.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (created !== undefined) set({ categoryIds: [...s.categoryIds, created.id] });
      setNewSection('');
    } catch (cause) {
      flash(cause instanceof ApiFailure ? cause.message : `That ${sectionOne} could not be added.`);
    }
  };

  const used = new Set(s.groups.map((g) => g.name.trim().toLowerCase()));
  const suggestions = attributes.filter((a) => !used.has(a.name.toLowerCase()) && (a.pick === 'one' || offersExtras)).slice(0, 5);
  const tile = tileFor(productId ?? (s.name || 'new'));
  const cover = s.images[0];
  const title = editing ? (s.name.trim() === '' ? `Edit ${one}` : s.name) : `New ${one}`;
  const stockTotal = rows.reduce((n, r) => n + (Number(editFor(s, r.id).stock) || 0), 0);

  return (
    <div className="flex flex-col gap-4 pb-24 lg:pb-0">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <a
            href={hrefFor(store.slug, '/products')}
            onClick={(e) => {
              e.preventDefault();
              back();
            }}
            className="text-caption font-semibold"
          >
            ← {capitalise(t('product', 'many'))}
          </a>
          <h1 className="m-0 font-display text-[24px] lg:text-[32px]">{title}</h1>
        </div>
        <div className="hidden items-center gap-3 lg:flex">
          <Button variant="text" tone="brand" onClick={back}>
            Discard
          </Button>
          <Button tone="brand" busy={saving} busyLabel="Saving…" onClick={() => void save(s.status)}>
            Save {one}
          </Button>
        </div>
      </header>

      {saveError === null ? null : (
        <Alert tone="danger" headline={saveError}>
          <span />
        </Alert>
      )}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-4">
          <Section title={`${capitalise(one)} information`}>
            <TextField label="Name" value={s.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} />
            <label className="flex flex-col gap-1.5 text-body font-semibold text-ink">
              Description
              <textarea
                rows={3}
                value={s.description}
                maxLength={2000}
                placeholder="What makes it good? Materials, ingredients, what's included."
                onChange={(e) => set({ description: e.target.value })}
                className="rounded-control border border-control-line bg-surface p-3 text-body font-normal"
              />
            </label>

            <div className="flex flex-col gap-2">
              <span className="text-body font-semibold">Photos</span>
              <div className="flex flex-wrap gap-2.5">
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  disabled={s.images.length >= MAX_PHOTOS}
                  className="flex size-[88px] flex-col items-center justify-center gap-1 rounded-card border border-dashed border-control-line bg-transparent text-caption font-semibold text-ink-2 disabled:opacity-50"
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  Add photos
                </button>
                <input ref={fileInput} type="file" accept={ACCEPT} multiple hidden onChange={(e) => void choosePhotos(e.target.files)} aria-label="Choose photos" />
                {s.images.map((url, i) => (
                  <div key={url} className="relative size-[88px] overflow-hidden rounded-card border border-line">
                    <img src={url} alt={`Photo ${i + 1}${i === 0 ? ', the cover' : ''}`} className="size-full object-cover" />
                    {i !== 0 ? null : <span className="absolute left-1 top-1 rounded-pill bg-ink px-2 py-[1px] text-[11px] font-bold text-white">Cover</span>}
                    <div className="absolute inset-x-0 bottom-0 flex justify-between bg-ink/70 px-1 py-0.5">
                      {i === 0 ? (
                        <span />
                      ) : (
                        <button type="button" onClick={() => set({ images: [url, ...s.images.filter((u) => u !== url)] })} className="border-0 bg-transparent p-0 text-[11px] font-semibold text-white">
                          Make cover
                        </button>
                      )}
                      <button type="button" aria-label={`Remove photo ${i + 1}`} onClick={() => set({ images: s.images.filter((u) => u !== url) })} className="border-0 bg-transparent p-0 text-[11px] font-semibold text-white">
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
                {Array.from({ length: uploading }, (_, i) => (
                  <div key={`up${i}`} role="status" aria-label="Uploading a photo" className="flex size-[88px] animate-pulse items-center justify-center rounded-card bg-status-neutral text-caption text-muted">
                    Uploading…
                  </div>
                ))}
              </div>
              {photoError === null ? null : (
                <span role="alert" className="text-caption font-medium text-status-danger-fg">
                  {photoError}
                </span>
              )}
              <span className="text-caption text-muted">Square photos on a plain background look best. The first photo is the cover.</span>
            </div>
          </Section>

          <Section title="Pricing">
            <PriceField label="Price" code={currency.code} value={s.price} onChange={(v) => set({ price: cleanAmount(v) })} />
            <PriceField
              label="Compare-at price"
              optional
              code={currency.code}
              placeholder="Shows as a discount"
              value={s.compareAt}
              onChange={(v) => set({ compareAt: cleanAmount(v) })}
            />
          </Section>

          <Section
            title="Options"
            hint="Anything the customer chooses: size, color, spice level, extras, storage."
            action={
              <Switch
                tone="brand"
                label="This product has options"
                checked={s.hasOptions}
                disabled={isBlockedByOrders && s.groups.some((g) => g.mode === 'one')}
                onChange={(on) => set({ hasOptions: on })}
              />
            }
          >
            {isBlockedByOrders && s.hasOptions ? (
              <Alert tone="info" headline="This product has been ordered, so its option groups are fixed.">
                <span>You can still change values, prices, stock and photos.</span>
              </Alert>
            ) : null}

            {!s.hasOptions
              ? null
              : s.groups.map((g) => {
                  const locked = isBlockedByOrders && g.id !== null;
                  return (
                    <div key={g.uid} className="flex flex-col gap-3 rounded-card border border-line bg-ground p-3.5">
                      {g.shared ? (
                        <div className="flex items-center justify-between gap-2">
                          <strong>{g.name}</strong>
                          <span className="rounded-pill bg-status-info px-2.5 py-[2px] text-[12px] font-semibold text-status-info-fg">Shared across products</span>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="min-w-40 grow">
                            <TextField label="Option name" value={g.name} onChange={(e) => setGroup(g.uid, { name: e.target.value })} maxLength={60} />
                          </div>
                          {offersExtras || g.mode === 'several' ? (
                            <Segmented
                              label="Customer can pick"
                              value={g.mode}
                              options={[
                                { value: 'one', label: 'One' },
                                { value: 'several', label: 'Several' },
                              ]}
                              onChange={(mode) => {
                                if (!locked) setGroup(g.uid, { mode });
                              }}
                            />
                          ) : null}
                          <Button
                            variant="text"
                            tone="brand"
                            type="button"
                            disabled={locked}
                            aria-label={`Remove option ${g.name}`}
                            onClick={() => set({ groups: s.groups.filter((x) => x.uid !== g.uid) })}
                          >
                            Remove
                          </Button>
                        </div>
                      )}

                      <div className="flex flex-wrap gap-1.5">
                        {g.values.map((v) => (
                          <span key={v.key} className="inline-flex h-9 items-center gap-1.5 rounded-control bg-surface pl-3 pr-1.5 text-caption font-semibold">
                            {v.label}
                            {Number(v.priceDelta) > 0 ? <span className="tabular-nums text-muted">+{money(v.priceDelta)}</span> : null}
                            {g.shared ? null : (
                              <button
                                type="button"
                                aria-label={`Remove ${v.label}`}
                                onClick={() => setGroup(g.uid, { values: g.values.filter((x) => x.key !== v.key) })}
                                className="flex size-6 items-center justify-center rounded-pill border-0 bg-transparent p-0 text-muted"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                                  <path d="M6 6l12 12M18 6L6 18" />
                                </svg>
                              </button>
                            )}
                          </span>
                        ))}
                        {g.values.length > 0 ? null : <span className="text-caption text-muted">No values yet.</span>}
                      </div>

                      {g.shared ? null : (
                        <form
                          className="flex flex-wrap gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            addValue(g);
                          }}
                        >
                          <input
                            aria-label={`New value for ${g.name || 'option'}`}
                            placeholder={`Add a value, e.g. ${EXAMPLES[g.name.trim().toLowerCase()] ?? 'Large'}`}
                            value={g.draft}
                            onChange={(e) => setGroup(g.uid, { draft: e.target.value })}
                            maxLength={60}
                            className="h-11 min-w-40 grow rounded-control border border-control-line bg-surface px-3"
                          />
                          <input
                            aria-label="Extra price for this value"
                            placeholder="+ price (optional)"
                            inputMode="decimal"
                            value={g.draftPrice}
                            onChange={(e) => setGroup(g.uid, { draftPrice: cleanAmount(e.target.value) })}
                            className="h-11 w-40 rounded-control border border-control-line bg-surface px-3"
                          />
                          <Button variant="secondary" type="submit">
                            Add value
                          </Button>
                        </form>
                      )}
                    </div>
                  );
                })}

            {!s.hasOptions || isBlockedByOrders ? null : (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" type="button" onClick={() => addGroup('')}>
                  + Add option
                </Button>
                {suggestions.length === 0 ? null : <span className="text-caption text-muted">Suggested:</span>}
                {suggestions.map((a) => (
                  <button
                    key={a.name}
                    type="button"
                    onClick={() => addGroup(a.name, a.pick)}
                    className="h-9 rounded-pill border border-control-line bg-surface px-3 text-caption font-semibold text-ink"
                  >
                    + {a.name}
                  </button>
                ))}
              </div>
            )}
          </Section>

          {!tracksStock ? null : (
            <Section
              title="Inventory"
              hint="Track stock to stop selling when you run out."
              action={<Switch tone="brand" label="Track stock" checked={s.trackStock} onChange={(on) => set({ trackStock: on })} />}
            >
              {rows.length === 0 ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <TextField label="SKU" placeholder="Optional" value={s.sku} onChange={(e) => set({ sku: e.target.value })} maxLength={64} />
                  {!s.trackStock ? null : (
                    <TextField label="Quantity in stock" inputMode="numeric" placeholder="0" value={s.stock} onChange={(e) => set({ stock: cleanCount(e.target.value) })} />
                  )}
                </div>
              ) : null}

              {rows.length === 0 || !s.trackStock ? null : (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="m-0 font-semibold">{rows.length} variants · set stock for each</p>
                    <span className="text-caption text-muted">{stockTotal} in stock</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 rounded-control bg-ground p-2">
                    <span className="text-caption font-semibold text-ink-2">Set every variant:</span>
                    <input
                      aria-label="Stock for all"
                      inputMode="numeric"
                      placeholder="stock"
                      value={bulkStock}
                      onChange={(e) => setBulkStock(cleanCount(e.target.value))}
                      className="h-9 w-20 rounded-control border border-control-line bg-surface px-2"
                    />
                    <Button
                      variant="secondary"
                      type="button"
                      disabled={bulkStock === ''}
                      onClick={() => {
                        const edits = { ...s.variantEdits };
                        for (const r of rows) edits[r.id] = { ...editFor(s, r.id), stock: bulkStock };
                        set({ variantEdits: edits });
                        setBulkStock('');
                      }}
                    >
                      Apply
                    </Button>
                  </div>

                  <div className="overflow-hidden rounded-card border border-line">
                    <div className="hidden grid-cols-[minmax(0,1.6fr)_110px_90px_minmax(0,1.2fr)] gap-3 bg-ground px-3.5 py-2.5 text-caption font-semibold text-muted sm:grid">
                      <span>Variant</span>
                      <span>Price</span>
                      <span>Stock</span>
                      <span>SKU</span>
                    </div>
                    {rows.map((r) => {
                      const e = editFor(s, r.id);
                      const out = Number(e.stock) === 0;
                      return (
                        <div key={r.id} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 border-t border-line-subtle px-3.5 py-2.5 first:border-t-0 sm:grid-cols-[minmax(0,1.6fr)_110px_90px_minmax(0,1.2fr)]">
                          <span className="font-semibold">{r.label}</span>
                          <span className="tabular-nums sm:order-none">{priceReady ? money(r.price) : '—'}</span>
                          <input
                            aria-label={`Stock for ${r.label}`}
                            inputMode="numeric"
                            placeholder="0"
                            value={e.stock}
                            onChange={(ev) => setEdit(r.id, { stock: cleanCount(ev.target.value) })}
                            className={`h-10 w-full rounded-control border border-control-line bg-surface px-2.5 ${out ? 'text-status-danger-fg' : ''}`}
                          />
                          <input
                            aria-label={`SKU for ${r.label}`}
                            placeholder={suggestSku(s.name, r)}
                            value={e.sku}
                            onChange={(ev) => setEdit(r.id, { sku: ev.target.value })}
                            maxLength={64}
                            className="col-span-2 h-10 w-full rounded-control border border-control-line bg-surface px-2.5 font-mono text-[12px] sm:col-span-1"
                          />
                        </div>
                      );
                    })}
                  </div>
                  <span className="text-caption text-muted">Variants at 0 show as sold out.</span>
                </div>
              )}
            </Section>
          )}
        </div>

        <aside className="flex flex-col gap-4">
          <Section title="Status">
            <label className="flex items-center gap-2 text-body">
              <input type="radio" name="ap-status" checked={s.status === 'active'} onChange={() => set({ status: 'active' })} className="size-[18px] accent-brand" />
              Active · visible in your store
            </label>
            <label className="flex items-center gap-2 text-body">
              <input type="radio" name="ap-status" checked={s.status === 'draft'} onChange={() => set({ status: 'draft' })} className="size-[18px] accent-brand" />
              Draft · hidden
            </label>

            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-1.5 p-0 text-body font-semibold">{capitalise(sectionOne)}</legend>
              {categories.length === 0 ? <span className="text-caption text-muted">No {t('category', 'many').toLowerCase()} yet. Add the first below.</span> : null}
              <div className="flex flex-wrap gap-1.5">
                {categories.map((c) => {
                  const on = s.categoryIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set({ categoryIds: on ? s.categoryIds.filter((x) => x !== c.id) : [...s.categoryIds, c.id] })}
                      className={`h-9 rounded-pill border px-3 text-caption font-semibold ${on ? 'border-ink bg-ink text-white' : 'border-control-line bg-surface text-ink'}`}
                    >
                      {c.name}
                    </button>
                  );
                })}
              </div>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addSection();
                }}
              >
                <input
                  aria-label={`New ${sectionOne.toLowerCase()}`}
                  placeholder={`New ${sectionOne.toLowerCase()}…`}
                  value={newSection}
                  onChange={(e) => setNewSection(e.target.value)}
                  maxLength={60}
                  className="h-10 min-w-0 grow rounded-control border border-control-line bg-surface px-3"
                />
                <Button variant="secondary" type="submit" disabled={newSection.trim() === ''}>
                  Add
                </Button>
              </form>
            </fieldset>
          </Section>

          <Section title="Preview">
            <div className="w-48 max-w-full">
              <ProductCard
                name={s.name.trim() === '' ? 'Product name' : s.name}
                price={priceReady ? money(s.price) : '[PRICE]'}
                {...(s.compareAt !== '' && priceReady && Number(s.compareAt) > Number(s.price) ? { compareAtPrice: money(s.compareAt) } : {})}
                meta={previewMeta(s)}
                initial={(s.name.trim() || 'P').charAt(0).toUpperCase()}
                tileBackground={tile.background}
                tileForeground={tile.foreground}
                {...(cover === undefined ? {} : { imageUrl: cover })}
                scale="roomy"
              />
            </div>
            <span className="text-caption text-muted">This is how the product card looks in your store.</span>
          </Section>
        </aside>
      </div>

      {/* The phone's actions, from MobileAddProduct: a bar at the foot with the draft on the left and the one
          primary on the right. On a desktop the same two outcomes are the header's Save and the status radio. */}
      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-line bg-surface px-4 pb-4 pt-3 lg:hidden">
        <Button variant="secondary" disabled={saving} onClick={() => void save('draft')}>
          Save draft
        </Button>
        <div className="grow">
          <Button tone="brand" block busy={saving} busyLabel="Saving…" onClick={() => void save('active')}>
            Publish
          </Button>
        </div>
      </div>

      {toast === null ? null : (
        <div className="fixed bottom-24 left-1/2 z-30 -translate-x-1/2 lg:bottom-6">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}

const capitalise = (s: string): string => (s === '' ? s : s.charAt(0).toUpperCase() + s.slice(1));

function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="flex flex-col gap-3.5 rounded-card border border-line bg-surface p-4 lg:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="m-0 text-title">{title}</h2>
          {hint === undefined ? null : <p className="m-0 mt-0.5 text-caption text-muted">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function PriceField({
  label,
  code,
  value,
  onChange,
  optional = false,
  placeholder,
}: {
  label: string;
  code: string;
  value: string;
  onChange: (v: string) => void;
  optional?: boolean;
  placeholder?: string;
}): ReactNode {
  return (
    <label className="flex flex-col gap-1.5 text-body font-semibold text-ink">
      <span>
        {label} {optional ? <span className="font-normal text-muted">(optional)</span> : null}
      </span>
      <span className="flex h-11 overflow-hidden rounded-control border border-control-line bg-surface">
        <input
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="min-w-0 grow border-0 bg-transparent px-3 font-normal outline-none"
        />
        <span className="flex items-center bg-status-neutral px-3 text-body font-normal text-ink-2">{code}</span>
      </span>
    </label>
  );
}

