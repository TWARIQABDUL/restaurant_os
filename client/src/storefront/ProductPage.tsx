// client/src/storefront/ProductPage.tsx — milestone 16, from project/ReviewsCustomer.dc.html.
//
// `/:store/p/:id`. The product, and the reviews that are most of the board.
//
// THE THREE-REVIEW RULE IS THE SERVER'S, and this screen must not re-implement it. V009 put it in a view
// and said why: "a rule two screens implement separately is a rule they will eventually disagree about."
// So `averageRating` arrives NULL below the threshold, and the only thing this file knows is how to render
// a null — as the board's own sentence, "2 reviews · too few for a rating".
//
// THE WRITE SHEET HAS FOUR STATES and the server decides which. The board draws two of them (sign in, or
// the rating form); the other two are ones a real system has and a mock does not — nothing of this product
// has arrived yet, and they have already reviewed it. Deciding on the server is what stops the sheet
// opening on the wrong one and correcting itself a moment later.
//
// THE STARS ARE A RADIOGROUP. The board's markup already is one — role="radiogroup", role="radio",
// aria-checked — and that is not decoration: a five-star rating chosen with a mouse only is a form a
// keyboard user cannot fill in.

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { ItemGonePage } from '../app/errorPages.tsx';
import { Button, Skeleton, StateCard, Toast } from '../shared/ui/index.ts';
import { BottomSheet } from '../shared/ui/index.ts';
import { storefront } from './api.ts';
import type { ProductDetailData, RatingSummary, ReviewData, WriteGate } from './api.ts';
import { useStore } from './StoreProvider.tsx';
import { OptionSheet, matchVariant } from './OptionSheet.tsx';
import { StickyCartBar } from './CartViews.tsx';
import { tileFor } from './tiles.ts';

/** The board's own five words for a rating. */
const RATING_WORDS = ['', 'Poor', 'Not great', 'OK', 'Good', 'Excellent'];

const STAR = '★';
const EMPTY_STAR = '☆';

/** "★★★★☆" — filled to `rating`, hollow after. */
function stars(rating: number): string {
  return STAR.repeat(rating) + EMPTY_STAR.repeat(Math.max(0, 5 - rating));
}

/**
 * The line beside the price.
 *
 * Three cases, all the board's: a rating when there is one, a count when there are too few, and "New" when
 * there are none at all.
 */
export function ratingLine(rating: RatingSummary): { text: string; strong: boolean } {
  if (rating.reviewCount === 0) return { text: 'New · no reviews yet', strong: false };
  if (rating.averageRating === null) {
    return {
      text: `${rating.reviewCount} review${rating.reviewCount > 1 ? 's' : ''} · too few for a rating`,
      strong: false,
    };
  }
  return { text: `★ ${rating.averageRating} (${rating.reviewCount})`, strong: true };
}

type Props = {
  productId: string;
  onBack: () => void;
  onOpenCart: () => void;
  onSignIn: () => void;
};

export function ProductPage({ productId, onBack, onOpenCart, onSignIn }: Props): ReactNode {
  const { face, money, setCart, t } = useStore();

  const [product, setProduct] = useState<ProductDetailData | null>(null);
  const [rating, setRating] = useState<RatingSummary | null>(null);
  const [reviews, setReviews] = useState<ReviewData[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [write, setWrite] = useState<WriteGate | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [reload, setReload] = useState(0);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [writeOpen, setWriteOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let live = true;
    setProduct(null);
    setError(null);
    void storefront
      .product(face.store.slug, productId)
      .then((result) => {
        if (!live) return;
        setProduct(result.product);
        setRating(result.rating);
        setReviews(result.reviews);
        setCursor(result.nextCursor);
        setWrite(result.write);
      })
      .catch((failure: unknown) => {
        if (!live) return;
        setError(failure instanceof ApiFailure ? failure : null);
      });
    return () => {
      live = false;
    };
  }, [face.store.slug, productId, reload]);

  const flash = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2400);
  }, []);

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    void storefront
      .reviews(face.store.slug, productId, cursor)
      .then((result) => {
        setReviews((current) => [...current, ...result.reviews]);
        setCursor(result.nextCursor);
      })
      .catch(() => {
        /* the button stays; a second tap retries */
      })
      .finally(() => setLoadingMore(false));
  }, [cursor, loadingMore, face.store.slug, productId]);

  // A product that is gone is not an outage: the store's own look, and the way back is its menu (ErrorPages.dc.html, "404 inside a store").
  if (error !== null && error.code === 'NO_SUCH_PRODUCT') {
    return <ItemGonePage storeName={face.store.name} mark={face.store.name.trim().charAt(0).toUpperCase() || 'S'} catalogWord={t('catalog')} onMenu={onBack} />;
  }

  if (error !== null) {
    return (
      <div className="px-4 py-10">
        <StateCard
          tone={error.code === 'OFFLINE' ? 'warn' : 'danger'}
          icon={error.code === 'OFFLINE' ? '⚡' : '!'}
          headline={error.code === 'OFFLINE' ? 'You’re offline' : 'That didn’t load'}
          body={error.message}
          action={{ label: 'Retry now', onSelect: () => setReload((n) => n + 1) }}
          secondaryAction={{ label: 'Back to the shop', onSelect: onBack }}
        />
      </div>
    );
  }

  if (product === null || rating === null) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Skeleton className="h-64 w-full rounded-card" />
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-24 w-full rounded-card" />
      </div>
    );
  }

  const tile = tileFor(product.id);
  const line = ratingLine(rating);
  // A product with nothing to choose can be added straight from the footer; anything else opens the sheet.
  const straightToCart = !product.hasChoices && !product.hasExtras && product.defaultVariantId !== null;

  const addDirect = (): void => {
    const variant = matchVariant(product, {});
    if (variant === null) return;
    setSheetBusy(true);
    void storefront
      .addToCart(face.store.slug, { variantId: variant.id, quantity: 1 })
      .then((result) => {
        setCart(result.cart);
        flash(`Added ${product.name}`);
      })
      .catch((failure: unknown) => {
        if (failure instanceof ApiFailure) flash(failure.message);
      })
      .finally(() => setSheetBusy(false));
  };

  return (
    <>
      <div className="mx-auto max-w-[760px] pb-32">
        {/* The image, with the back button over it — the board's own arrangement. */}
        <div
          className="relative flex h-64 items-center justify-center font-display text-[96px]"
          style={{ background: tile.background, color: tile.foreground }}
        >
          <span aria-hidden="true">{product.name.trim().charAt(0).toUpperCase()}</span>
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to the shop"
            className="absolute left-3 top-3 flex size-11 items-center justify-center rounded-pill bg-store-surface text-store-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        </div>

        <div className="flex flex-col gap-3.5 p-4">
          <div>
            <h1 className="font-display text-heading">{product.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-body">
              <strong className="text-title">{money(product.price)}</strong>
              {product.compareAtPrice === null ? null : (
                <s className="text-store-muted">{money(product.compareAtPrice)}</s>
              )}
              <span aria-hidden="true" className="text-store-muted">
                ·
              </span>
              <span className={line.strong ? 'font-semibold text-status-warn-fg' : 'text-store-muted'}>
                {line.text}
              </span>
            </div>
            {product.description === '' ? null : (
              <p className="mt-2 text-body text-store-muted">{product.description}</p>
            )}
            {product.stock.soldOut ? (
              <p className="mt-2 inline-flex rounded-chip bg-status-danger px-2.5 py-1 text-caption font-semibold text-status-danger-fg">
                Sold out · back soon
              </p>
            ) : product.stock.lowStock && product.stock.fewestLeft !== null ? (
              <p className="mt-2 inline-flex rounded-chip bg-status-warn px-2.5 py-1 text-caption font-semibold text-status-warn-fg">
                Only {product.stock.fewestLeft} left
              </p>
            ) : null}
          </div>

          <ReviewsSection
            rating={rating}
            reviews={reviews}
            storeName={face.store.name}
            hasMore={cursor !== null}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
            write={write}
            onWrite={() => setWriteOpen(true)}
            onSignIn={onSignIn}
          />
        </div>
      </div>

      {/* The footer CTA, which the board pins to the bottom of the screen. */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-store-border bg-store-surface p-4">
        <div className="mx-auto max-w-[760px]">
          <Button
            variant="primary"
            block
            busy={sheetBusy}
            busyLabel="Adding…"
            disabled={product.stock.soldOut}
            onClick={() => {
              if (straightToCart) addDirect();
              else setSheetOpen(true);
            }}
          >
            {product.stock.soldOut
              ? 'Sold out'
              : straightToCart
                ? `Add · ${money(product.price)}`
                : 'Choose options'}
          </Button>
        </div>
      </div>

      <OptionSheet
        product={product}
        open={sheetOpen}
        onClose={() => {
          setSheetOpen(false);
          setSheetError(null);
        }}
        busy={sheetBusy}
        error={sheetError}
        onAdd={(variantId, optionValueIds, quantity) => {
          setSheetBusy(true);
          void storefront
            .addToCart(face.store.slug, { variantId, optionValueIds, quantity })
            .then((result) => {
              setCart(result.cart);
              setSheetOpen(false);
              setSheetError(null);
              flash(`Added ${product.name}`);
            })
            .catch((failure: unknown) => {
              if (failure instanceof ApiFailure) {
                setSheetError(failure.message);
                if (failure.code === 'STALE_CATALOGUE') setReload((n) => n + 1);
              }
            })
            .finally(() => setSheetBusy(false));
        }}
      />

      <WriteReviewSheet
        open={writeOpen}
        onClose={() => setWriteOpen(false)}
        productName={product.name}
        storeName={face.store.name}
        write={write}
        onSignIn={onSignIn}
        onPosted={(posted) => {
          setRating(posted.rating);
          setWriteOpen(false);
          setReload((n) => n + 1);
          flash('Thanks! Your review is live.');
        }}
        slug={face.store.slug}
        productId={product.id}
      />

      <StickyCartBar onOpen={onOpenCart} />

      {toast === null ? null : (
        <div className="pointer-events-none fixed inset-x-4 bottom-24 z-20 flex justify-center">
          <Toast message={toast} />
        </div>
      )}
    </>
  );
}

function ReviewsSection({
  rating,
  reviews,
  storeName,
  hasMore,
  loadingMore,
  onLoadMore,
  write,
  onWrite,
  onSignIn,
}: {
  rating: RatingSummary;
  reviews: ReviewData[];
  storeName: string;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  write: WriteGate | null;
  onWrite: () => void;
  onSignIn: () => void;
}): ReactNode {
  const showSummary = rating.averageRating !== null;
  const note =
    rating.reviewCount === 0
      ? 'No reviews yet. Be the first to say how it was.'
      : rating.averageRating === null
        ? 'We show an average once there are 3 reviews, so one opinion doesn’t decide it.'
        : null;

  return (
    <section className="flex flex-col gap-2.5 rounded-card border border-store-border bg-store-surface p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-title font-bold">Reviews</h2>
        {write === null ? null : write.can ? (
          <Button variant="secondary" onClick={onWrite}>
            Write a review
          </Button>
        ) : write.reason === 'needsSignIn' ? (
          <Button variant="secondary" onClick={onSignIn}>
            Write a review
          </Button>
        ) : null}
      </div>

      {showSummary ? (
        <div className="flex items-center gap-4">
          <div className="flex w-20 flex-col items-center">
            <span className="font-display text-display leading-none">{rating.averageRating}</span>
            <span aria-hidden="true" className="tracking-widest text-status-warn-fg">
              {stars(Math.round(Number(rating.averageRating)))}
            </span>
            <span className="text-caption text-store-muted">{rating.reviewCount} reviews</span>
          </div>
          <div className="flex grow flex-col gap-1">
            {([5, 4, 3, 2, 1] as const).map((star) => {
              const count = rating.counts[String(star) as '1' | '2' | '3' | '4' | '5'] ?? 0;
              const percent = rating.reviewCount === 0 ? 0 : (count / rating.reviewCount) * 100;
              return (
                <div key={star} className="flex items-center gap-1.5 text-caption">
                  <span className="w-2.5">{star}</span>
                  <span className="h-1.5 grow overflow-hidden rounded-pill bg-line-subtle">
                    <span
                      className="block h-1.5 bg-status-warn-fg"
                      style={{ width: `${percent}%` }}
                      role="progressbar"
                      aria-valuenow={count}
                      aria-valuemin={0}
                      aria-valuemax={rating.reviewCount}
                      aria-label={`${star} stars: ${count}`}
                    />
                  </span>
                  <span className="w-5 text-right text-store-muted">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {note === null ? null : (
        <div className="rounded-control bg-store-bg px-3 py-2.5 text-caption text-store-muted">{note}</div>
      )}

      {reviews.map((review) => (
        <article key={review.id} className="flex flex-col gap-1 border-t border-line-subtle pt-2.5">
          <div className="flex justify-between text-caption">
            <span>
              <strong>{review.author}</strong>
              <span className="ml-1 rounded-pill bg-status-success px-1.5 py-px text-[11px] font-bold text-status-success-fg">
                Ordered here
              </span>
            </span>
            <span className="text-store-muted">{relativeDay(review.createdAt)}</span>
          </div>
          <span aria-label={`${review.rating} out of 5 stars`} className="tracking-widest text-status-warn-fg">
            {stars(review.rating)}
          </span>
          <p className="text-body">{review.body ?? '(No comment, just a rating.)'}</p>
          {review.reply === null ? null : (
            <div className="mt-1 rounded-control bg-store-bg px-2.5 py-2 text-caption">
              <strong>{storeName} replied:</strong> {review.reply.body}
            </div>
          )}
        </article>
      ))}

      {hasMore ? (
        <div className="flex justify-center pt-1">
          <Button variant="text" onClick={onLoadMore} busy={loadingMore} busyLabel="Loading…">
            More reviews
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function WriteReviewSheet({
  open,
  onClose,
  productName,
  storeName,
  write,
  onSignIn,
  onPosted,
  slug,
  productId,
}: {
  open: boolean;
  onClose: () => void;
  productName: string;
  storeName: string;
  write: WriteGate | null;
  onSignIn: () => void;
  onPosted: (posted: { rating: RatingSummary }) => void;
  slug: string;
  productId: string;
}): ReactNode {
  const [chosen, setChosen] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = (): void => {
    if (chosen === 0 || busy) return;
    setBusy(true);
    setFailure(null);
    void storefront
      .postReview(slug, productId, { rating: chosen, ...(text.trim() === '' ? {} : { body: text.trim() }) })
      .then((result) => {
        setChosen(0);
        setText('');
        onPosted({ rating: result.rating });
      })
      .catch((error: unknown) => {
        if (error instanceof ApiFailure) setFailure(error.message);
      })
      .finally(() => setBusy(false));
  };

  return (
    <BottomSheet open={open} onClose={onClose} title="Write a review">
      {write !== null && !write.can && write.reason === 'needsSignIn' ? (
        <div className="flex flex-col gap-2.5">
          <strong className="text-heading">Sign in to review</strong>
          <span className="text-body text-store-muted">
            Reviews come from customers with an account, so we can show that they really ordered.
          </span>
          <Button variant="primary" block onClick={onSignIn}>
            Sign in
          </Button>
        </div>
      ) : write !== null && !write.can && write.reason === 'nothingToReview' ? (
        <div className="flex flex-col gap-2.5">
          <strong className="text-heading">Nothing to review yet</strong>
          <span className="text-body text-store-muted">
            You can review this once an order with it has arrived.
          </span>
        </div>
      ) : write !== null && !write.can && write.reason === 'alreadyReviewed' ? (
        <div className="flex flex-col gap-2.5">
          <strong className="text-heading">You’ve reviewed this</strong>
          <span className="text-body text-store-muted">
            Your review is below. {storeName} can reply, but nobody can edit or delete it — including you.
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <strong className="text-heading">How was the {productName.toLowerCase()}?</strong>

          <div role="radiogroup" aria-label="Rating" className="flex gap-1.5">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                role="radio"
                aria-checked={chosen === star}
                aria-label={`${star} star${star > 1 ? 's' : ''}`}
                onClick={() => setChosen(star)}
                className={`size-13 rounded-control bg-store-bg text-[28px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                  chosen >= star ? 'text-status-warn-fg' : 'text-disabled'
                }`}
              >
                {STAR}
              </button>
            ))}
          </div>
          <span className="min-h-5 text-body font-semibold">{RATING_WORDS[chosen]}</span>

          <textarea
            rows={3}
            aria-label="Your review"
            placeholder="What did you like, or not? (optional)"
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={1000}
            className="resize-none rounded-control border border-control-line bg-store-surface px-3 py-2.5 text-body text-store-text"
          />

          <span className="text-caption text-store-muted">
            Shown with your first name. {storeName} can reply but can’t edit or delete it.
          </span>

          {failure === null ? null : (
            <p role="alert" className="text-body font-semibold text-status-danger-fg">
              {failure}
            </p>
          )}

          <Button variant="primary" block onClick={submit} disabled={chosen === 0} busy={busy} busyLabel="Posting…">
            Post review
          </Button>
        </div>
      )}
    </BottomSheet>
  );
}

/** "Today", "2 days ago", "3 weeks ago" — the board's own scale. */
export function relativeDay(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  return months <= 1 ? '1 month ago' : `${months} months ago`;
}
