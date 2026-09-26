// client/src/storefront/ShopHome.tsx — milestone 16.
//
// `Shop`'s home screen at 390 and `StoreDesktop` at 1440, as one tree. The composition differs by
// breakpoint and nothing is shrunk: two columns of products become three, the category rail becomes a
// left column with counts, the sticky cart bar becomes an aside, and the store-info panel appears.
//
// WHAT THE CARD'S META LINE IS. Main lists the candidates — "variants, rating, '+ extras', or restock
// date" — and both storefront boards use the DESCRIPTION ("Grilled chicken, slaw, house sauce"). So that
// is what this passes, and the rating goes beside the name only when there is one to show: V009's rule
// means `averageRating` is null below three reviews, and a card showing "★ —" would be worse than a card
// showing nothing.
//
// SEARCH IS DEBOUNCED, because every keystroke would otherwise be a request. 250 ms is short enough to
// feel immediate on the keyboard and long enough that a typed word is one query rather than five.
//
// ADDING FROM THE GRID SKIPS THE SHEET only when there is nothing to choose — `hasChoices` is false and a
// default variant exists. That is the board's own rule, where the button reads "Add" for a juice and
// "Choose" for a burger with a size.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, ProductCard, SkeletonCard, StateCard, Toast } from '../shared/ui/index.ts';
import { storefront } from './api.ts';
import type { CartData, ProductCardData, ProductCursor, ProductDetailData } from './api.ts';
import { useStore } from './StoreProvider.tsx';
import { CategoryNav, PromoBanner, StoreHeader, StoreInfo, fulfilmentLine } from './ShopChrome.tsx';
import { OptionSheet } from './OptionSheet.tsx';
import { CartSummary, StickyCartBar } from './CartViews.tsx';
import { tileFor } from './tiles.ts';

const PAGE = 24;
const SEARCH_DEBOUNCE_MS = 250;

type Props = {
  onOpenProduct: (productId: string) => void;
  onOpenCart: () => void;
};

export function ShopHome({ onOpenProduct, onOpenCart }: Props): ReactNode {
  const { face, money, has, t, cart, setCart, refreshCart } = useStore();

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [category, setCategory] = useState<string | null>(null);

  const [products, setProducts] = useState<ProductCardData[] | null>(null);
  const [cursor, setCursor] = useState<ProductCursor | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);

  // Bumped to refetch the current filter — after a failure, and after the server says the page is stale.
  const [reload, setReload] = useState(0);
  const [sheetProduct, setSheetProduct] = useState<ProductDetailData | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const today = useMemo(() => {
    // ISO day number in the viewer's own zone: getDay() is 0 = Sunday, ISO is 1 = Monday.
    const day = new Date().getDay();
    return day === 0 ? 7 : day;
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // The first page, whenever the filter changes.
  useEffect(() => {
    let live = true;
    setProducts(null);
    setError(null);
    void storefront
      .products(face.store.slug, { category, q: debounced, limit: PAGE })
      .then((result) => {
        if (!live) return;
        setProducts(result.products);
        setCursor(result.nextCursor);
      })
      .catch((failure: unknown) => {
        if (!live) return;
        setError(failure instanceof ApiFailure ? failure : null);
        setProducts([]);
      });
    return () => {
      live = false;
    };
  }, [face.store.slug, category, debounced, reload]);

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    void storefront
      .products(face.store.slug, { category, q: debounced, limit: PAGE, after: cursor })
      .then((result) => {
        setProducts((current) => [...(current ?? []), ...result.products]);
        setCursor(result.nextCursor);
      })
      .catch(() => {
        /* the button stays; a second tap retries */
      })
      .finally(() => setLoadingMore(false));
  }, [cursor, loadingMore, face.store.slug, category, debounced]);

  const flash = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2400);
  }, []);

  const add = useCallback(
    async (variantId: string, optionValueIds: string[], quantity: number): Promise<CartData | null> => {
      try {
        const result = await storefront.addToCart(face.store.slug, { variantId, optionValueIds, quantity });
        setCart(result.cart);
        return result.cart;
      } catch (failure) {
        if (failure instanceof ApiFailure) {
          // A stale page — the product changed under them. The server says so AND says to reload, so the
          // catalogue and the cart are both refetched: the next tap is against what is really there
          // rather than against what the page still remembers.
          if (failure.code === 'STALE_CATALOGUE') {
            setReload((n) => n + 1);
            refreshCart();
          }
          setSheetError(failure.message);
          flash(failure.message);
        }
        return null;
      }
    },
    [face.store.slug, setCart, flash, refreshCart],
  );

  const openSheet = useCallback(
    async (productId: string) => {
      setSheetError(null);
      try {
        const result = await storefront.product(face.store.slug, productId);
        setSheetProduct(result.product);
      } catch (failure) {
        if (failure instanceof ApiFailure) flash(failure.message);
      }
    },
    [face.store.slug, flash],
  );

  const onAddFromCard = useCallback(
    (product: ProductCardData) => {
      // Nothing to choose: straight into the cart, which is the board's "Add" button.
      if (!product.hasChoices && !product.hasExtras && product.defaultVariantId !== null) {
        void add(product.defaultVariantId, [], 1).then((updated) => {
          if (updated !== null) flash(`Added ${product.name}`);
        });
        return;
      }
      void openSheet(product.id);
    },
    [add, openSheet, flash],
  );

  const fulfilment = fulfilmentLine(face, money, has);
  const showPromo = debounced.trim() === '' && category === null && face.banner !== null;
  const activeCategory = face.categories.find((c) => c.id === category) ?? null;
  const gridTitle =
    debounced.trim() !== '' ? 'Results' : (activeCategory?.name ?? t('catalog'));

  return (
    <>
      <StoreHeader
        query={query}
        onSearch={setQuery}
        cartCount={cart.itemCount}
        onCart={onOpenCart}
        today={today}
      />

      <div className="mx-auto grid max-w-[1360px] gap-0 lg:grid-cols-[220px_minmax(0,1fr)_340px] lg:gap-8 lg:px-10 lg:py-7">
        {/* Left column on desktop; a rail under the header on mobile. */}
        <div className="lg:pt-1">
          <CategoryNav
            categories={face.categories}
            active={category}
            onPick={setCategory}
            allLabel={t('catalog')}
            totalCount={null}
          />
          <div className="px-4 lg:px-0">
            <StoreInfo />
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4 px-4 pb-28 lg:px-0 lg:pb-0">
          {showPromo && face.banner !== null ? (
            <PromoBanner title={face.banner.title} subtitle={face.banner.subtitle} />
          ) : null}

          {fulfilment === '' ? null : (
            <p className="text-caption text-store-muted lg:hidden">{fulfilment}</p>
          )}

          {face.open.isOpen ? null : (
            <Alert tone="warn" headline={`${face.store.name} is closed right now.`}>
              You can still look around. Ordering opens when the store does.
            </Alert>
          )}

          <div className="flex items-baseline justify-between">
            <h2 className="font-display text-title font-bold lg:text-heading">{gridTitle}</h2>
            {products === null ? null : (
              <span className="text-caption text-store-muted">
                {products.length}
                {cursor === null ? '' : '+'} {products.length === 1 ? t('product', 'one') : t('product')}
              </span>
            )}
          </div>

          {error !== null ? (
            <StateCard
              tone={error.code === 'OFFLINE' ? 'warn' : 'danger'}
              icon={error.code === 'OFFLINE' ? '⚡' : '!'}
              headline={error.code === 'OFFLINE' ? 'You’re offline' : 'That didn’t load'}
              body={error.message}
              action={{ label: 'Retry now', onSelect: () => setReload((n) => n + 1) }}
            />
          ) : products === null ? (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 lg:gap-4">
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <SkeletonCard key={n} />
              ))}
            </div>
          ) : products.length === 0 ? (
            debounced.trim() === '' ? (
              <StateCard
                tone="neutral"
                icon="◦"
                headline="Nothing here yet"
                body={`${face.store.name} hasn’t added anything to this ${t('category', 'one').toLowerCase()} yet.`}
                {...(category === null
                  ? {}
                  : { action: { label: `Browse the whole ${t('catalog').toLowerCase()}`, onSelect: () => setCategory(null) } })}
              />
            ) : (
              <StateCard
                tone="neutral"
                icon="?"
                headline={`No matches for “${debounced.trim()}”`}
                body="Try a shorter word, or browse all categories."
                action={{
                  label: 'Clear search',
                  onSelect: () => {
                    setQuery('');
                    setCategory(null);
                  },
                }}
              />
            )
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 lg:gap-4">
                {products.map((product) => {
                  const tile = tileFor(product.id);
                  const rating = product.rating;
                  const badge =
                    product.stock.soldOut
                      ? { label: 'Sold out', tone: 'ink' as const }
                      : product.compareAtPrice !== null
                        ? { label: savingLabel(product.price, product.compareAtPrice), tone: 'danger' as const }
                        : product.stock.lowStock
                          ? { label: 'Few left', tone: 'info' as const }
                          : undefined;

                  return (
                    <ProductCard
                      key={product.id}
                      scale="roomy"
                      name={product.name}
                      price={money(product.price)}
                      {...(product.compareAtPrice === null || product.stock.soldOut
                        ? {}
                        : { compareAtPrice: money(product.compareAtPrice) })}
                      meta={metaFor(product.description, rating)}
                      {...(badge === undefined ? {} : { badge })}
                      initial={product.name.trim().charAt(0).toUpperCase()}
                      tileBackground={tile.background}
                      tileForeground={tile.foreground}
                      soldOut={product.stock.soldOut}
                      onOpen={() => onOpenProduct(product.id)}
                      {...(product.stock.soldOut
                        ? {}
                        : { onAdd: () => onAddFromCard(product) })}
                    />
                  );
                })}
              </div>

              {cursor === null ? null : (
                <div className="flex justify-center pt-2">
                  <Button variant="secondary" onClick={loadMore} busy={loadingMore} busyLabel="Loading…">
                    Show more
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {/* The cart: an aside on desktop, a sticky bar on mobile. */}
        <aside aria-label="Your cart" className="hidden self-start lg:block">
          <CartSummary onCheckout={onOpenCart} />
        </aside>
      </div>

      <StickyCartBar onOpen={onOpenCart} />

      {sheetProduct === null ? null : (
        <OptionSheet
          product={sheetProduct}
          open
          onClose={() => {
            setSheetProduct(null);
            setSheetError(null);
          }}
          busy={sheetBusy}
          error={sheetError}
          onAdd={(variantId, optionValueIds, quantity) => {
            setSheetBusy(true);
            void add(variantId, optionValueIds, quantity)
              .then((updated) => {
                if (updated !== null) {
                  flash(`Added ${sheetProduct.name}`);
                  setSheetProduct(null);
                  setSheetError(null);
                }
              })
              .finally(() => setSheetBusy(false));
          }}
        />
      )}

      {toast === null ? null : (
        // Bottom-left of the viewport, above the sticky cart bar — where States.dc.html puts it.
        <div className="pointer-events-none fixed inset-x-4 bottom-24 z-10 flex justify-center lg:bottom-8 lg:justify-start lg:pl-10">
          <Toast message={toast} />
        </div>
      )}
    </>
  );
}

/** "−17%", the board's own badge, derived from the two prices rather than stored. */
function savingLabel(price: string, compareAt: string): string {
  const now = Number(price);
  const was = Number(compareAt);
  if (!Number.isFinite(now) || !Number.isFinite(was) || was <= 0) return 'Sale';
  return `−${Math.round((1 - now / was) * 100)}%`;
}

/**
 * The card's single meta line.
 *
 * The description, with the rating appended only when V009 says there is one to show. Main is explicit
 * that this is ONE line, because that is what keeps a food card and a fashion card the same height.
 */
function metaFor(description: string, rating: ProductCardData['rating']): string | undefined {
  const stars = rating !== null && rating.averageRating !== null ? `★ ${rating.averageRating}` : '';
  const parts = [description.trim(), stars].filter((part) => part !== '');
  return parts.length === 0 ? undefined : parts.join(' · ');
}
