// client/src/console/StorePreview.tsx — milestone 25, from project/StorePreview.dc.html.
//
// "Live store preview" — the storefront in miniature, drawn with the store's own palette, shape, heading font and card
// treatment, so a merchant sees a change the instant they make it.
//
// IT IS THE STOREFRONT'S OWN COMPONENTS, NOT A LOOKALIKE. The board's preview is a hand-drawn mock with its own
// inline styles, which is right for a design file and would be wrong here: a second implementation of "what a product
// card looks like" is where the preview and the live store start to disagree, and a preview that disagrees with the
// store is worse than none. So this renders the kit's ProductCard and the storefront's utilities, and the ONLY thing
// that differs from the real shop is where the theme variables are set — on this subtree, by the same two functions
// (store-theme.ts) the storefront uses.
//
// THE VARIABLES ARE A `style` PROP, NOT AN EFFECT, so the preview renders themed on the server and on first paint, and
// the render gate can see it. Every colour in it comes from the compiler's output; none is written in this file.
//
// WHAT THE SAMPLE IS. The store's own products and sections where they are known (Customize passes them), and a neutral
// sample where they are not. A brand-new store has no products, and a preview of an empty page shows nothing of a look.

import type { CSSProperties, ReactNode } from 'react';
import type { CompiledTheme, Design } from '../app/core.ts';
import { ProductCard } from '../shared/ui/index.ts';
import { storeLookVariables, storeThemeVariables } from '../styles/store-theme.ts';
import { tileFor } from '../storefront/tiles.ts';

export type PreviewProduct = { id: string; name: string; meta: string; price: string; compareAt?: string; sale?: string; imageUrl?: string | null };

export type PreviewDevice = 'mobile' | 'desktop';

type Props = {
  theme: CompiledTheme;
  design: Design;
  device: PreviewDevice;
  storeName: string;
  products: readonly PreviewProduct[];
  categories: readonly string[];
  /** The two lines of the promotion banner, and the store-info strip — sample text unless the caller knows better. */
  promo?: { title: string; subtitle: string };
  info?: string;
  cartTotal: string;
};

export function StorePreview({ theme, design, device, storeName, products, categories, promo, info, cartTotal }: Props): ReactNode {
  const desktop = device === 'desktop';
  const style = {
    ...storeThemeVariables(theme.colors),
    ...storeLookVariables(theme.inputs, theme.dark),
    width: desktop ? 980 : 390,
    // The board draws the phone as a device and the desktop as a window; both are chrome around the same page.
    height: 776,
  } as CSSProperties;

  const shown = products.slice(0, desktop ? 8 : 4);
  const initial = storeName.trim().charAt(0).toUpperCase();
  const asList = design.productLayout === 'list';

  return (
    <div
      aria-label="Live store preview"
      style={style}
      className={`relative flex max-w-full flex-col overflow-hidden bg-store-bg text-store-text ${
        desktop ? 'rounded-control border border-control-line' : 'rounded-[36px] border-8 border-ink'
      }`}
    >
      <div className="flex items-center gap-2.5 p-4">
        {design.logoUrl === null ? (
          <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-control bg-store-primary font-display text-[18px] font-bold text-store-on-primary">
            {initial}
          </span>
        ) : (
          <img src={design.logoUrl} alt="" className="size-9 rounded-control object-cover" />
        )}
        <span className="grow truncate font-display text-[19px] font-bold">{storeName}</span>
        <span aria-hidden="true" className="size-9 rounded-control border border-store-border bg-store-surface" />
      </div>

      <div className="flex min-h-0 grow flex-col overflow-hidden pb-16">
        {!design.sections.promo ? null : (
          <section className="mx-4 flex flex-col gap-1 rounded-card bg-store-hero-bg p-4 text-store-hero-text">
            <span className="font-display text-[20px] font-bold leading-tight">{promo?.title ?? 'Your promotion'}</span>
            <span className="text-caption">{promo?.subtitle ?? 'Weekdays 12:00–15:00'}</span>
          </section>
        )}

        {!design.sections.categories ? null : (
          <div className="flex gap-1.5 overflow-hidden px-4 pt-3">
            <span className="shrink-0 rounded-pill bg-store-text px-3.5 py-[7px] text-caption font-semibold text-store-bg">All</span>
            {categories.slice(0, 4).map((c) => (
              <span key={c} className="shrink-0 rounded-pill border border-store-border bg-store-surface px-3.5 py-[7px] text-caption font-semibold">
                {c}
              </span>
            ))}
          </div>
        )}

        {!design.sections.featured ? null : <div className="px-4 pt-3.5 font-display text-[16px] font-bold">Popular right now</div>}

        <div className={asList ? 'flex flex-col gap-2 overflow-hidden px-4 py-2.5' : `grid gap-2.5 overflow-hidden px-4 py-2.5 ${desktop ? 'grid-cols-4' : 'grid-cols-2'}`}>
          {shown.map((p) => {
            const tile = tileFor(p.id);
            return (
              <ProductCard
                key={p.id}
                scale="roomy"
                layout={asList ? 'list' : 'grid'}
                name={p.name}
                price={p.price}
                {...(p.compareAt === undefined ? {} : { compareAtPrice: p.compareAt })}
                {...(p.sale === undefined ? {} : { badge: { label: p.sale, tone: 'danger' as const } })}
                meta={p.meta}
                initial={p.name.trim().charAt(0).toUpperCase()}
                tileBackground={tile.background}
                tileForeground={tile.foreground}
                {...(p.imageUrl == null ? {} : { imageUrl: p.imageUrl })}
                onAdd={() => undefined}
              />
            );
          })}
        </div>

        {!design.sections.info ? null : (
          <div className="mx-4 rounded-card border border-store-border bg-store-surface p-3.5 text-caption text-store-muted">{info ?? `${storeName} · Open today · Delivery`}</div>
        )}
      </div>

      <div
        className={`absolute inset-x-4 bottom-4 flex h-[52px] items-center justify-between rounded-control bg-store-primary px-[18px] font-bold text-store-on-primary ${
          theme.outline ? '[box-shadow:inset_0_0_0_1.5px_var(--store-text)]' : ''
        }`}
      >
        <span>2 items</span>
        <span>View cart · {cartTotal}</span>
      </div>
    </div>
  );
}

/** What a store with nothing yet shows in the preview, so a look can still be judged. */
export const SAMPLE_PRODUCTS: readonly PreviewProduct[] = [
  { id: 'sample-1', name: 'Everyday classic', meta: 'Your best seller', price: '3,500 RWF' },
  { id: 'sample-2', name: 'Weekend special', meta: 'Limited this week', price: '4,000 RWF', compareAt: '5,000 RWF', sale: '−20%' },
  { id: 'sample-3', name: 'Quick bite', meta: 'Ready in minutes', price: '1,500 RWF' },
  { id: 'sample-4', name: 'House favourite', meta: 'Customers love it', price: '5,000 RWF' },
  { id: 'sample-5', name: 'Fresh pick', meta: 'Made today', price: '1,200 RWF' },
  { id: 'sample-6', name: 'Gift set', meta: 'Wrapped for you', price: '8,000 RWF' },
  { id: 'sample-7', name: 'Small treat', meta: 'Just because', price: '500 RWF' },
  { id: 'sample-8', name: 'Family size', meta: 'Serves four', price: '9,500 RWF' },
];

export const SAMPLE_CATEGORIES: readonly string[] = ['Favourites', 'New', 'Offers', 'Gifts'];
