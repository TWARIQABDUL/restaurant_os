// client/src/console/Categories.tsx — milestone 22, from project/Categories.dc.html.
//
// "Menu sections" for a food store, "Collections" for fashion, "Aisles" for grocery — the board draws the food
// one and says so itself: *Called “Sections” in your Food & drinks template. Order here is the order on your
// store.* So the title and the button are the config engine's words, and the subtitle says where they came from.
//
// THE TITLE IS `<catalog> <category>` ONLY WHEN THEY DIFFER. Food: Menu + Sections = "Menu sections", which is
// the board. Grocery's catalog and category are both "Aisles", and "Aisles aisles" is not a heading.
//
// THE ORDER IS SENT WHOLE. An arrow press reorders the list locally and sends the complete new order; the server
// refuses a list that is not exactly the store's sections (ORDER_STALE) rather than parking a missing one at the
// top. On a refusal the screen reloads — it never leaves the merchant looking at an order that was not saved.
//
// "SHOWN" IS DERIVED, NEVER STORED. A section appears on the store when it is switched on AND has a live product
// in it (the storefront's own query), so the row says which of the three things is true. Drafts alone do not
// make a section appear, and a row that said "Shown" for a section the shopper cannot see would be the board's
// own preview lying.

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, SkeletonRow, Switch, Toast } from '../shared/ui/index.ts';
import { categoriesApi } from './api.ts';
import type { CategoryRow } from './api.ts';
import { useShell } from './ShellProvider.tsx';

export type SectionState = { label: string; shown: boolean };

/** The board's three states plus the one it could not draw: products exist, but none are live. */
export function sectionState(c: Pick<CategoryRow, 'isVisible' | 'productCount' | 'activeCount'>): SectionState {
  if (!c.isVisible) return { label: 'Hidden', shown: false };
  if (c.productCount === 0) return { label: 'Empty · not shown', shown: false };
  if (c.activeCount === 0) return { label: 'Drafts only · not shown', shown: false };
  return { label: 'Shown', shown: true };
}

export function productsMeta(c: Pick<CategoryRow, 'productCount'>, one: string, many: string): string {
  return c.productCount === 0 ? `No ${many.toLowerCase()} yet` : `${c.productCount} ${(c.productCount === 1 ? one : many).toLowerCase()}`;
}

export function pageTitle(catalog: string, category: string): string {
  return catalog.toLowerCase() === category.toLowerCase() ? category : `${catalog} ${category.toLowerCase()}`;
}

type Props = {
  /** The render gate's seam: effects do not run in static markup. Console.tsx passes none. */
  initialRows?: CategoryRow[];
  /** Renders the board's inline delete confirmation, which is otherwise one click into the screen. */
  initialDoomed?: string;
};

export function Categories({ initialRows, initialDoomed }: Props = {}): ReactNode {
  const { store, t, templateName, may } = useShell();
  const [rows, setRows] = useState<CategoryRow[] | null>(initialRows ?? null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [doomed, setDoomed] = useState<string | null>(initialDoomed ?? null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const oneWord = t('category', 'one');
  const manyWord = t('category', 'many');
  const productOne = t('product', 'one');
  const productMany = t('product', 'many');

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((current) => (current === m ? null : current)), 2400);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      setRows((await categoriesApi.list(store.id)).categories);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : `${manyWord} could not be loaded.`);
    }
  }, [store.id, manyWord]);

  useEffect(() => {
    if (initialRows === undefined) void load();
  }, [load, initialRows]);

  if (!may('products.write')) {
    return (
      <Alert tone="info" headline={`Your role can’t manage ${manyWord.toLowerCase()}.`}>
        <span>Ask the owner of {store.name} to change your role.</span>
      </Alert>
    );
  }

  if (rows === null) {
    return error === null ? (
      <div className="flex flex-col gap-3" aria-busy="true">
        <SkeletonRow />
        <SkeletonRow />
      </div>
    ) : (
      <Alert tone="danger" headline={error}>
        <Button variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      </Alert>
    );
  }

  /** Runs one change and swaps in the list the server answered with — the server's order, not a guess at it. */
  const apply = async (change: () => Promise<{ categories: CategoryRow[] }>, done?: string): Promise<boolean> => {
    setBusy(true);
    try {
      setRows((await change()).categories);
      if (done !== undefined) flash(done);
      return true;
    } catch (cause) {
      flash(cause instanceof ApiFailure ? cause.message : 'That could not be saved. Nothing was changed.');
      // A refused reorder or a vanished row means the screen is stale: show the truth.
      void load();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, by: -1 | 1): void => {
    const next = [...rows];
    const swap = next[index + by];
    const here = next[index];
    if (swap === undefined || here === undefined) return;
    next[index] = swap;
    next[index + by] = here;
    setRows(next);
    void apply(() => categoriesApi.reorder(store.id, next.map((r) => r.id)));
  };

  const doomedRow = rows.find((r) => r.id === doomed);
  const preview = rows.filter((r) => sectionState(r).shown);
  const title = pageTitle(t('catalog', 'many'), manyWord);

  return (
    <div className="relative flex flex-col gap-4">
      <header className="flex items-center gap-3.5">
        <div className="grow">
          <h1 className="m-0 font-display text-[22px] lg:text-[28px]">{title}</h1>
          <span className="text-caption text-muted">
            {templateName === null ? '' : `Called “${manyWord}” in your ${templateName} template. `}Order here is the order on your store.
          </span>
        </div>
        <Button tone="brand" onClick={() => { setAdding(true); setDraft(''); }}>
          Add {oneWord.toLowerCase()}
        </Button>
      </header>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section className="overflow-hidden rounded-card border border-line bg-surface">
          {!adding ? null : (
            <form
              className="flex gap-2 border-b border-line bg-brand-tint px-4 py-3"
              onSubmit={(e) => {
                e.preventDefault();
                const name = draft.trim();
                if (name === '') return;
                void apply(() => categoriesApi.create(store.id, name), `${capitalise(oneWord)} added`).then((ok) => {
                  if (ok) setAdding(false);
                });
              }}
            >
              <input
                autoFocus
                aria-label={`${capitalise(oneWord)} name`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="e.g. Breakfast"
                className="h-11 grow rounded-control border border-control-line px-3"
              />
              <Button tone="brand" type="submit" disabled={busy || draft.trim() === ''}>
                Add
              </Button>
              <Button variant="text" tone="brand" type="button" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </form>
          )}

          {rows.map((c, i) => {
            const state = sectionState(c);
            return (
              <div key={c.id} className={`flex items-center gap-3 border-b border-line-subtle px-4 py-2.5 ${doomed === c.id ? 'bg-status-danger' : ''}`}>
                <span className="flex flex-col">
                  <button type="button" aria-label={`Move ${c.name} up`} disabled={i === 0 || busy} onClick={() => move(i, -1)} className="h-[22px] w-7 border-0 bg-transparent text-ink-2 disabled:text-control-line">
                    ▲
                  </button>
                  <button type="button" aria-label={`Move ${c.name} down`} disabled={i === rows.length - 1 || busy} onClick={() => move(i, 1)} className="h-[22px] w-7 border-0 bg-transparent text-ink-2 disabled:text-control-line">
                    ▼
                  </button>
                </span>
                <RenameInline row={c} disabled={busy} onRename={(name) => apply(() => categoriesApi.update(store.id, c.id, { name }), 'Renamed')} meta={productsMeta(c, productOne, productMany)} />
                <span className={`rounded-pill px-[9px] py-[2px] text-[12px] font-bold ${state.shown ? 'bg-status-success text-status-success-fg' : 'bg-status-neutral text-muted'}`}>{state.label}</span>
                <Switch
                  tone="brand"
                  label={`Show ${c.name} on store`}
                  checked={c.isVisible}
                  disabled={busy}
                  onChange={(on) => void apply(() => categoriesApi.update(store.id, c.id, { isVisible: on }))}
                />
                <button type="button" onClick={() => setDoomed(c.id)} aria-label={`Delete ${c.name}`} className="h-9 border-0 bg-transparent px-2.5 text-caption font-semibold text-status-danger-fg">
                  Delete
                </button>
              </div>
            );
          })}

          {rows.length > 0 ? null : (
            <div className="p-12 text-center">
              <p className="m-0 font-semibold">No {manyWord.toLowerCase()} yet</p>
              <p className="m-0 mt-1 text-body text-muted">They group your {productMany.toLowerCase()} on the store.</p>
            </div>
          )}

          {doomedRow === undefined ? null : (
            <div className="flex flex-col gap-2 border-t border-status-danger-fg bg-status-danger px-4 py-3.5">
              <strong>Delete “{doomedRow.name}”?</strong>
              <span className="text-body text-ink-2">
                {doomedRow.productCount > 0
                  ? `Its ${doomedRow.productCount} ${productMany.toLowerCase()} stay in your catalog. They just won’t be in this ${oneWord.toLowerCase()}.`
                  : 'Nothing else changes.'}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    const id = doomedRow.id;
                    void apply(() => categoriesApi.remove(store.id, id), `${capitalise(oneWord)} deleted`).then(() => setDoomed(null));
                  }}
                >
                  Delete {oneWord.toLowerCase()}
                </Button>
                <Button variant="text" tone="brand" onClick={() => setDoomed(null)}>
                  Keep it
                </Button>
              </div>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-4">
          <h2 className="m-0 text-title">On your store</h2>
          <div className="flex flex-wrap gap-1.5">
            <span className="flex h-[34px] items-center rounded-pill bg-ink px-3.5 text-caption font-bold text-white">All</span>
            {preview.map((p) => (
              <span key={p.id} className="flex h-[34px] items-center rounded-pill bg-status-neutral px-3.5 text-caption font-semibold">
                {p.name}
              </span>
            ))}
          </div>
          <span className="text-caption text-muted">
            Hidden {manyWord.toLowerCase()} and empty ones don’t appear. {capitalise(productMany)} can sit in more than one {oneWord.toLowerCase()}.
          </span>
        </section>
      </div>

      {toast === null ? null : (
        <div className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}

const capitalise = (s: string): string => (s === '' ? s : s.charAt(0).toUpperCase() + s.slice(1));

/**
 * The name, editable in place. The board shows a name and offers no rename — but a section that can only be
 * deleted and re-added to fix a typo loses its position and its products, and V003's unique name makes a
 * rename the only safe correction. Press Enter or leave the field to save; Escape puts it back.
 */
function RenameInline({
  row,
  meta,
  disabled,
  onRename,
}: {
  row: CategoryRow;
  meta: string;
  disabled: boolean;
  onRename: (name: string) => Promise<boolean>;
}): ReactNode {
  const [value, setValue] = useState(row.name);
  useEffect(() => setValue(row.name), [row.name]);

  const commit = (): void => {
    const name = value.trim();
    if (name === '' || name === row.name) {
      setValue(row.name);
      return;
    }
    void onRename(name).then((ok) => {
      if (!ok) setValue(row.name);
    });
  };

  return (
    <span className="flex min-w-0 grow flex-col">
      <input
        aria-label={`Name of ${row.name}`}
        value={value}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setValue(row.name);
            e.currentTarget.blur();
          }
        }}
        className="w-full truncate rounded-control border border-transparent bg-transparent px-1 py-0.5 font-semibold text-ink hover:border-control-line focus:border-control-line"
      />
      <span className="px-1 text-caption text-muted">{meta}</span>
    </span>
  );
}
