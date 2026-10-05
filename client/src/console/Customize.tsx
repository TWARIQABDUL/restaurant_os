// client/src/console/Customize.tsx — milestone 25, from project/Customize.dc.html.
//
// "Store design — Changes are saved as a draft." The editor for everything about how the storefront is ARRANGED: brand
// colour and heading font (two of ThemeStudio's eight inputs, offered here as the quick choices), whether products are
// a grid or a list, which homepage sections show, and the logo. A live preview beside it, a phone or a desktop.
//
// TWO SCREENS, ONE DRAFT. Customize and ThemeStudio edit the same thing (lookDraft.ts), so a brand colour picked here is
// the brand colour in the studio, and "Publish" here puts the palette AND the layout live in one transaction. The
// board's six swatches are a subset of what the studio allows; picking a seventh in the studio and coming back shows no
// swatch selected, which is honest — it is not one of these six.
//
// FOUR HEADING FONTS, NOT THREE. The board draws Modern, Editorial and "Clean"; ThemeStudio's compiler knows Modern,
// Editorial, Sport and Classic, and the database CHECK holds the same four. "Clean" (Figtree) has no counterpart in the
// engine, and adding a font would mean changing the compiler's frozen golden table. So this offers the engine's four, and
// the difference is a designer question rather than a silent substitution.
//
// NOT HERE: "+ Add section". The sections are a closed list the storefront knows how to render; a button that added an
// arbitrary one would have nothing to draw. The products section is locked on, as the board draws it.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { HEADING_FONTS } from '../app/core.ts';
import type { Design, HeadingFont, HomepageSection, ProductLayout } from '../app/core.ts';
import { Alert, Button, Switch, Toast } from '../shared/ui/index.ts';
import { categoriesApi, lookApi, productsApi } from './api.ts';
import type { ProductRow } from './api.ts';
import { useLookDraft } from './lookDraft.ts';
import type { LookDraft } from './lookDraft.ts';
import { hrefFor } from './nav.ts';
import { SAMPLE_CATEGORIES, SAMPLE_PRODUCTS, StorePreview } from './StorePreview.tsx';
import type { PreviewDevice, PreviewProduct } from './StorePreview.tsx';
import { useShell } from './ShellProvider.tsx';
import { storeLookVariables } from '../styles/store-theme.ts';

/** The board's six, in its order. */
const COLORS: readonly { hex: string; name: string }[] = [
  { hex: '#1D6B47', name: 'Green' },
  { hex: '#B8452B', name: 'Terracotta' },
  { hex: '#2A55A0', name: 'Blue' },
  { hex: '#7A3E8F', name: 'Plum' },
  { hex: '#8F5200', name: 'Amber' },
  { hex: '#17160F', name: 'Black' },
];

const FONT_LABEL: Record<HeadingFont, string> = { modern: 'Modern', editorial: 'Editorial', sport: 'Sport', classic: 'Classic' };

const SECTIONS: readonly { id: HomepageSection | 'products'; label: string }[] = [
  { id: 'promo', label: 'Promotion banner' },
  { id: 'categories', label: 'Categories' },
  { id: 'featured', label: 'Featured heading' },
  { id: 'products', label: 'Products' },
  { id: 'info', label: 'Store information' },
];

const LAYOUTS: readonly { id: ProductLayout; label: string }[] = [
  { id: 'grid', label: 'Grid' },
  { id: 'list', label: 'List' },
];

/** The store's own products as preview cards, newest-first as the list returns them. */
export function toPreview(rows: readonly ProductRow[], money: (v: string) => string): PreviewProduct[] {
  return rows
    .filter((r) => r.status === 'active')
    .map((r) => ({ id: r.id, name: r.name, meta: r.categories[0] ?? r.sub, price: money(r.price), imageUrl: r.coverImageUrl }));
}

type Props = {
  navigate: (to: string) => void;
  /** The render gate's seam: effects do not run in static markup. Console.tsx passes none. */
  initial?: { inputs: LookDraft['inputs']; design: Design };
  initialDevice?: PreviewDevice;
  initialProducts?: PreviewProduct[];
  initialCategories?: string[];
};

export function Customize({ navigate, initial, initialDevice, initialProducts, initialCategories }: Props): ReactNode {
  const { store, money, currency, may } = useShell();
  const look = useLookDraft(store.id, initial);
  const [device, setDevice] = useState<PreviewDevice>(initialDevice ?? 'mobile');
  const [products, setProducts] = useState<PreviewProduct[]>(initialProducts ?? []);
  const [categories, setCategories] = useState<string[]>(initialCategories ?? []);
  const [toast, setToast] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((current) => (current === m ? null : current)), 3000);
  }, []);

  // The preview is of THIS store: its own products and sections where it has them, the sample where it has none.
  useEffect(() => {
    if (initialProducts !== undefined) return;
    void productsApi
      .list(store.id, { tab: 'active', q: '', category: '', sort: 'newest', page: 1 })
      .then((r) => setProducts(toPreview(r.rows, money)))
      .catch(() => undefined);
    void categoriesApi
      .list(store.id)
      .then((r) => setCategories(r.categories.filter((c) => c.isVisible && c.activeCount > 0).map((c) => c.name)))
      .catch(() => undefined);
  }, [store.id, money, initialProducts]);

  if (!may('settings.write')) {
    return (
      <div className="p-6">
        <Alert tone="info" headline="Your role can’t change the store’s design.">
          <span>Ask the owner of {store.name} to change your role.</span>
        </Alert>
      </div>
    );
  }

  if (!look.ready) {
    return look.loadError === null ? (
      <div className="p-6 text-body text-muted" aria-busy="true">Opening the editor…</div>
    ) : (
      <div className="p-6">
        <Alert tone="danger" headline={look.loadError}>
          <Button variant="secondary" onClick={look.reload}>
            Try again
          </Button>
        </Alert>
      </div>
    );
  }

  const { inputs, design, theme } = look;

  const publish = async (): Promise<void> => {
    setPublishing(true);
    const r = await look.publish();
    setPublishing(false);
    flash(r.ok ? 'Published · your store has the new design' : r.message);
  };

  const chooseLogo = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setLogoBusy(true);
    try {
      const { url } = await lookApi.uploadLogo(store.id, file);
      look.setDesign((d) => ({ ...d, logoUrl: url }));
    } catch (cause) {
      flash(cause instanceof ApiFailure ? (cause.status === 413 ? 'That logo is over 5 MB. Try a smaller one.' : cause.message) : 'That logo could not be uploaded.');
    } finally {
      setLogoBusy(false);
      if (fileInput.current !== null) fileInput.current.value = '';
    }
  };

  const toggleSection = (id: HomepageSection | 'products'): void => {
    if (id === 'products') return;
    look.setDesign((d) => ({ ...d, sections: { ...d.sections, [id]: !d.sections[id] } }));
  };

  const initialLetter = store.name.trim().charAt(0).toUpperCase();

  return (
    <div className="flex min-h-dvh flex-col bg-ground">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-5 py-3">
        <a
          href={hrefFor(store.slug, '')}
          onClick={(e) => {
            e.preventDefault();
            navigate(hrefFor(store.slug, ''));
          }}
          className="text-caption font-semibold"
        >
          ← Dashboard
        </a>
        <strong>Store design</strong>
        <span className="text-caption text-muted" aria-live="polite">
          {look.save === 'saving' ? 'Saving…' : look.save === 'failed' ? 'Couldn’t save your draft' : 'Changes are saved as a draft'}
        </span>
        <span className="grow" />
        <div role="group" aria-label="Preview device" className="flex gap-1 rounded-control bg-status-neutral p-[3px]">
          {(['mobile', 'desktop'] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={device === d}
              onClick={() => setDevice(d)}
              className={`h-9 rounded-chip border-0 px-3.5 text-body font-semibold ${device === d ? 'bg-surface text-ink shadow-menu' : 'bg-transparent text-ink-2'}`}
            >
              {d === 'mobile' ? 'Mobile' : 'Desktop'}
            </button>
          ))}
        </div>
        <a href={`/${encodeURIComponent(store.slug)}`} className="flex h-10 items-center rounded-control border border-control-line px-4 text-body font-semibold text-ink no-underline">
          Preview live
        </a>
        <Button tone="brand" disabled={!look.unpublished} busy={publishing} busyLabel="Publishing…" onClick={() => void publish()}>
          Publish
        </Button>
      </header>

      <div className="flex min-h-0 grow flex-col lg:flex-row">
        <aside className="flex w-full shrink-0 flex-col gap-6 overflow-y-auto border-b border-line bg-surface p-5 lg:w-[360px] lg:border-b-0 lg:border-r">
          <section className="flex flex-col gap-2.5">
            <Heading>Brand</Heading>
            <div className="flex items-center gap-3">
              {design.logoUrl === null ? (
                <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-card bg-store-primary font-display text-[22px] font-bold text-store-on-primary" style={{ background: theme.colors.primary, color: theme.colors.onPrimary }}>
                  {initialLetter}
                </span>
              ) : (
                <img src={design.logoUrl} alt="Your logo" className="size-12 rounded-card object-cover" />
              )}
              <Button variant="secondary" type="button" busy={logoBusy} busyLabel="Uploading…" onClick={() => fileInput.current?.click()}>
                {design.logoUrl === null ? 'Add logo' : 'Replace logo'}
              </Button>
              {design.logoUrl === null ? null : (
                <Button variant="text" tone="brand" type="button" onClick={() => look.setDesign((d) => ({ ...d, logoUrl: null }))}>
                  Remove
                </Button>
              )}
              <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" hidden aria-label="Choose a logo" onChange={(e) => void chooseLogo(e.target.files?.[0])} />
            </div>
            <span className="mt-1.5 text-body font-semibold">Brand color</span>
            <div className="flex flex-wrap gap-2.5">
              {COLORS.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  aria-label={c.name}
                  aria-pressed={inputs.brand === c.hex}
                  onClick={() => look.setInputs((prev) => ({ ...prev, brand: c.hex }))}
                  style={{ background: c.hex }}
                  className={`size-10 rounded-pill border-[3px] border-white p-0 ${inputs.brand === c.hex ? '[box-shadow:0_0_0_2px_var(--color-ink)]' : '[box-shadow:0_0_0_1px_var(--color-control-line)]'}`}
                />
              ))}
            </div>
            <a
              href={hrefFor(store.slug, '/store-design/theme')}
              onClick={(e) => {
                e.preventDefault();
                navigate(hrefFor(store.slug, '/store-design/theme'));
              }}
              className="text-caption font-semibold"
            >
              More colors and personality →
            </a>
          </section>

          <section className="flex flex-col gap-2">
            <Heading>Typography</Heading>
            {HEADING_FONTS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={inputs.headingFont === f}
                onClick={() => look.setInputs((prev) => ({ ...prev, headingFont: f }))}
                className={`flex h-14 items-center justify-between rounded-control bg-surface px-3.5 text-left ${inputs.headingFont === f ? 'border-2 border-ink' : 'border border-line'}`}
              >
                <FontSample font={f} theme={theme} text={store.name} />
                <span className="text-caption text-muted">{FONT_LABEL[f]}</span>
              </button>
            ))}
          </section>

          <section className="flex flex-col gap-2">
            <Heading>Product layout</Heading>
            <div className="grid grid-cols-2 gap-2">
              {LAYOUTS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  aria-pressed={design.productLayout === l.id}
                  onClick={() => look.setDesign((d) => ({ ...d, productLayout: l.id }))}
                  className={`h-12 rounded-control bg-surface text-body font-semibold ${design.productLayout === l.id ? 'border-2 border-ink' : 'border border-line'}`}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-1">
            <Heading>Homepage sections</Heading>
            {SECTIONS.map((x) => {
              const locked = x.id === 'products';
              const on = locked ? true : design.sections[x.id as HomepageSection];
              return (
                <div key={x.id} className="flex h-[52px] items-center gap-2.5 border-b border-line-subtle">
                  <span className={`grow text-[15px] ${on ? '' : 'text-muted'}`}>{x.label}</span>
                  <Switch tone="brand" label={`Show ${x.label}`} checked={on} disabled={locked} onChange={() => toggleSection(x.id)} />
                </div>
              );
            })}
            <span className="mt-1 text-caption text-muted">The products section is always shown.</span>
          </section>
        </aside>

        <div className="flex grow items-start justify-center overflow-auto bg-status-neutral p-7">
          <StorePreview
            theme={theme}
            design={design}
            device={device}
            storeName={store.name}
            products={products.length > 0 ? products : SAMPLE_PRODUCTS}
            categories={categories.length > 0 ? categories : SAMPLE_CATEGORIES}
            cartTotal={`113,000 ${currency.code}`}
          />
        </div>
      </div>

      {toast === null ? null : (
        <div className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}

function Heading({ children }: { children: ReactNode }): ReactNode {
  return <h2 className="m-0 text-[13px] font-bold uppercase tracking-[0.06em] text-muted">{children}</h2>;
}

/**
 * The store's name drawn in a heading font, so a merchant picks a typeface by seeing their own name in it. Uses the same
 * variables the storefront does, set locally to THIS option's font rather than the chosen one.
 */
function FontSample({ font, theme, text }: { font: HeadingFont; theme: LookDraft['theme']; text: string }): ReactNode {
  return (
    <span className="font-display text-[20px] font-bold" style={fontVariables(font, theme)}>
      {text}
    </span>
  );
}

function fontVariables(font: HeadingFont, theme: LookDraft['theme']): CSSProperties {
  return storeLookVariables({ ...theme.inputs, headingFont: font }, theme.dark) as CSSProperties;
}
