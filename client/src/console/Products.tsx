// client/src/console/Products.tsx — milestone 22, from project/Products.dc.html.
//
// THE LIST THE MERCHANT LIVES IN: find a product, see at a glance what is low, and act on several at once.
//
// THE WORDS ARE THE STORE'S. The board draws "Products" for a food store while its sibling, Categories, draws
// "Menu sections" for the same store — one board over, for the same template. Part 9 of the plan asked whether
// that was deliberate, and the config engine makes either possible, so this milestone chose: BOTH screens ask
// `t()`. A Food store reads "Menu items / Add menu item", a Fashion store "Products / Add product". The only
// alternative is a catalogue whose list says Products and whose sections say Sections, which is exactly the
// split `Industries.dc.html` argues against. `ResolvedWord.derived` marks the singular as a guess, and it is
// right for all 32 words the eight templates ship.
//
// THE TABS' NUMBERS COME FROM THE SERVER, FOR THE WHOLE STORE. They are not `rows.length`: the board's "All 182"
// sits above a page of eight, and a tab whose count changed as you searched would stop answering "how many are
// low?". "Low stock" and "Out of stock" exist only where the store tracks stock (`has('stock')`) — a Services
// store has nothing to count, and two tabs that are always zero are noise.
//
// A BULK DELETE NAMES WHAT IT KEPT. The server refuses to delete anything that has been ordered or reviewed
// (the record is the record) and says which; this screen turns that into a sentence instead of a silent
// shortfall, because "delete 3" followed by 2 gone is the sort of thing a merchant notices an hour later.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, ConfirmModal, SelectField, SkeletonRow, Toast } from '../shared/ui/index.ts';
import { tileFor } from '../storefront/tiles.ts';
import { categoriesApi, productsApi } from './api.ts';
import type { CategoryRow, ListSort, ListTab, ProductList, ProductRow } from './api.ts';
import { hrefFor } from './nav.ts';
import { useShell } from './ShellProvider.tsx';

const SORTS: readonly { value: ListSort; label: string }[] = [
  { value: 'best', label: 'Best selling' },
  { value: 'newest', label: 'Newest' },
  { value: 'price', label: 'Price, low to high' },
  { value: 'stock', label: 'Stock, low to high' },
];

const TAB_LABEL: Record<ListTab, string> = {
  all: 'All',
  active: 'Active',
  draft: 'Drafts',
  low: 'Low stock',
  out: 'Out of stock',
};

export const capitalise = (s: string): string => (s === '' ? s : s.charAt(0).toUpperCase() + s.slice(1));

/** The board's three status chips. `low` is still "Active": it is the STOCK that turns red, not the status. */
export function statusChip(row: Pick<ProductRow, 'state'>): { label: string; className: string } {
  if (row.state === 'draft') return { label: 'Draft', className: 'bg-status-neutral text-status-neutral-fg' };
  if (row.state === 'out') return { label: 'Out of stock', className: 'bg-status-danger text-status-danger-fg' };
  return { label: 'Active', className: 'bg-status-success text-status-success-fg' };
}

export function stockCell(row: Pick<ProductRow, 'stock' | 'state'>): { text: string; alarming: boolean } {
  if (row.stock === null) return { text: '—', alarming: false };
  if (row.state === 'out') return { text: '0', alarming: true };
  if (row.state === 'low') return { text: `${row.stock} · low`, alarming: true };
  return { text: String(row.stock), alarming: false };
}

type Props = {
  navigate: (to: string) => void;
  /**
   * A TESTING SEAM, the same one Orders.tsx and CashReport.tsx took, for the same reason: renderToStaticMarkup
   * runs no effects, so the first fetch never resolves in the render gate. Console.tsx passes none of these.
   */
  initialList?: ProductList;
  initialCategories?: CategoryRow[];
};

export function Products({ navigate, initialList, initialCategories }: Props): ReactNode {
  const { store, t, has, money, may } = useShell();

  const [tab, setTab] = useState<ListTab>('all');
  const [q, setQ] = useState('');
  const [typed, setTyped] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<ListSort>('newest');
  const [page, setPage] = useState(1);

  const [list, setList] = useState<ProductList | null>(initialList ?? null);
  const [categories, setCategories] = useState<CategoryRow[]>(initialCategories ?? []);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((current) => (current === m ? null : current)), 4000);
  }, []);

  const tracksStock = has('stock');
  // Lower-cased once: the words are stored as headings ("Menu items"), and almost every use is mid-sentence.
  // The two headings capitalise() them back.
  const many = t('product', 'many').toLowerCase();
  const one = t('product', 'one').toLowerCase();

  // Search is debounced: the box is typed into, the query is what was typed 300 ms ago.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQ(typed.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [typed]);

  const seeded = useRef(initialList !== undefined);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await productsApi.list(store.id, { tab, q, category, sort, page });
      setList(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : `${capitalise(many)} could not be loaded.`);
    }
  }, [store.id, tab, q, category, sort, page, many]);

  useEffect(() => {
    // The seeded first paint is not re-fetched over itself on mount.
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    void load();
  }, [load]);

  useEffect(() => {
    if (initialCategories !== undefined) return;
    void categoriesApi
      .list(store.id)
      .then((r) => setCategories(r.categories))
      .catch(() => undefined);
  }, [store.id, initialCategories]);

  if (!may('products.write')) {
    return (
      <Alert tone="info" headline={`Your role can’t manage ${many}.`}>
        <span>Ask the owner of {store.name} to change your role.</span>
      </Alert>
    );
  }

  if (list === null) {
    return error === null ? (
      <div className="flex flex-col gap-3" aria-busy="true">
        <SkeletonRow />
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

  const shown = list.rows;
  const allOn = shown.length > 0 && shown.every((r) => selected.has(r.id));
  const from = list.total === 0 ? 0 : (list.page - 1) * list.pageSize + 1;
  const to = Math.min(list.total, from + shown.length - 1);
  const lastPage = Math.max(1, Math.ceil(list.total / list.pageSize));
  const tabs = (Object.keys(TAB_LABEL) as ListTab[]).filter((id) => tracksStock || (id !== 'low' && id !== 'out'));

  const toggle = (id: string): void => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const run = async (
    ids: string[],
    action: 'activate' | 'draft' | 'delete' | 'category',
    done: (changed: number, kept: { id: string; name: string }[]) => string,
    categoryId?: string,
  ): Promise<void> => {
    setBusy(true);
    try {
      const result = await productsApi.bulk(store.id, ids, action, categoryId);
      flash(done(result.changed, result.kept));
      setSelected(new Set());
      setMenuFor(null);
      await load();
    } catch (cause) {
      flash(cause instanceof ApiFailure ? cause.message : 'That could not be done. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  };

  const deleteDone = (changed: number, kept: { id: string; name: string }[]): string => {
    const gone = changed === 0 ? 'Nothing deleted' : `${changed} deleted`;
    if (kept.length === 0) return gone;
    const names = kept.map((k) => k.name).join(', ');
    return `${gone}. ${names} ${kept.length === 1 ? 'has' : 'have'} been ordered, so ${kept.length === 1 ? 'it was' : 'they were'} kept — hide ${kept.length === 1 ? 'it' : 'them'} instead.`;
  };

  const selectedIds = [...selected];
  const word = (n: number): string => (n === 1 ? one : many);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center justify-between gap-3">
        <h1 className="m-0 font-display text-[26px] lg:text-[32px]">{capitalise(many)}</h1>
        <a
          href={hrefFor(store.slug, '/products/new')}
          onClick={(e) => {
            e.preventDefault();
            navigate(hrefFor(store.slug, '/products/new'));
          }}
          className="inline-flex h-11 items-center gap-2 rounded-control bg-ink px-[18px] text-body font-semibold text-white no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add {one}
        </a>
      </header>

      <div role="tablist" className="flex gap-6 overflow-x-auto border-b border-line">
        {tabs.map((id) => {
          const on = id === tab;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => {
                setTab(id);
                setPage(1);
                setSelected(new Set());
              }}
              className={`-mb-px h-11 shrink-0 border-b-2 bg-transparent px-0.5 text-body font-semibold ${
                on ? 'border-ink text-ink' : 'border-transparent text-muted'
              }`}
            >
              {TAB_LABEL[id]} <span className="font-medium text-muted">{list.counts[id]}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <label className="flex h-11 grow items-center gap-2 rounded-control border border-control-line bg-surface px-3 text-muted">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            type="search"
            aria-label={`Search ${many}`}
            placeholder="Search by name or SKU"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="h-10 grow border-0 bg-transparent text-ink outline-none"
          />
        </label>
        <div className="grid grid-cols-2 gap-3 lg:flex">
          <SelectField
            label={capitalise(t('category', 'one'))}
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All {t('category', 'many').toLowerCase()}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Sort"
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as ListSort);
              setPage(1);
            }}
          >
            {SORTS.filter((s) => tracksStock || s.value !== 'stock').map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </SelectField>
        </div>
      </div>

      {selected.size === 0 ? null : (
        <div role="region" aria-label="Bulk actions" className="relative flex flex-wrap items-center gap-2.5 rounded-card bg-ink px-3.5 py-2.5 text-white">
          <span className="grow font-semibold">
            {selected.size} {word(selected.size)} selected
          </span>
          <BulkButton disabled={busy} onClick={() => void run(selectedIds, 'activate', (n) => `${n} set active`)}>
            Set active
          </BulkButton>
          <BulkButton disabled={busy} onClick={() => void run(selectedIds, 'draft', (n) => `${n} hidden from your store`)}>
            Hide from store
          </BulkButton>
          <span className="relative">
            <BulkButton disabled={busy || categories.length === 0} onClick={() => setMoveOpen((o) => !o)}>
              Change {t('category', 'one').toLowerCase()}
            </BulkButton>
            {!moveOpen ? null : (
              <div role="menu" className="absolute left-0 top-10 z-10 flex min-w-48 flex-col rounded-card border border-line bg-surface p-1 text-ink shadow-menu">
                {categories.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoveOpen(false);
                      void run(selectedIds, 'category', (n) => `${n} moved to ${c.name}`, c.id);
                    }}
                    className="h-10 rounded-control bg-transparent px-3 text-left text-body hover:bg-status-neutral"
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            )}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmDelete(selectedIds)}
            className="h-9 rounded-control bg-status-danger-fg px-3.5 text-caption font-semibold text-white"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            aria-label="Clear selection"
            className="flex size-9 items-center justify-center rounded-control border-0 bg-transparent p-0 text-white"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      )}

      <section className="overflow-hidden rounded-card border border-line bg-surface">
        <div
          className={`hidden items-center gap-3 bg-ground px-4 py-3 text-caption font-semibold text-muted lg:grid ${
            tracksStock
              ? 'lg:grid-cols-[24px_minmax(0,2.4fr)_minmax(0,1fr)_110px_100px_130px_40px]'
              : 'lg:grid-cols-[24px_minmax(0,2.4fr)_minmax(0,1fr)_110px_130px_40px]'
          }`}
        >
          <input type="checkbox" aria-label="Select all" checked={allOn} onChange={() => setSelected(allOn ? new Set() : new Set(shown.map((r) => r.id)))} className="size-[18px] accent-ink" />
          <span>{capitalise(one)}</span>
          <span>{capitalise(t('category', 'one'))}</span>
          <span className="text-right">Price</span>
          {tracksStock ? <span className="text-right">Stock</span> : null}
          <span>Status</span>
          <span />
        </div>

        {shown.map((r) => {
          const chip = statusChip(r);
          const stock = stockCell(r);
          const tile = tileFor(r.id);
          const on = selected.has(r.id);
          return (
            <div
              key={r.id}
              className={`relative grid items-center gap-3 border-t border-line-subtle px-4 py-3 text-body grid-cols-[24px_minmax(0,1fr)_auto] ${
                tracksStock
                  ? 'lg:grid-cols-[24px_minmax(0,2.4fr)_minmax(0,1fr)_110px_100px_130px_40px]'
                  : 'lg:grid-cols-[24px_minmax(0,2.4fr)_minmax(0,1fr)_110px_130px_40px]'
              } ${on ? 'bg-ground' : ''}`}
            >
              <input type="checkbox" aria-label={`Select ${r.name}`} checked={on} onChange={() => toggle(r.id)} className="size-[18px] accent-ink" />
              <a
                href={hrefFor(store.slug, `/products/${r.id}`)}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(hrefFor(store.slug, `/products/${r.id}`));
                }}
                className="flex min-w-0 items-center gap-3 text-ink no-underline"
              >
                {r.coverImageUrl === null ? (
                  <span
                    aria-hidden="true"
                    className="flex size-10 shrink-0 items-center justify-center rounded-control font-display font-bold"
                    style={{ background: tile.background, color: tile.foreground }}
                  >
                    {r.name.charAt(0)}
                  </span>
                ) : (
                  <img src={r.coverImageUrl} alt="" className="size-10 shrink-0 rounded-control object-cover" />
                )}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[15px] font-semibold">{r.name}</span>
                  <span className="truncate text-caption text-muted">{r.sub}</span>
                </span>
              </a>
              <span className="hidden truncate text-ink-2 lg:block">{r.categories.join(', ') || '—'}</span>
              <span className="hidden text-right tabular-nums lg:block">{money(r.price)}</span>
              {tracksStock ? (
                <span className={`hidden text-right tabular-nums lg:block ${stock.alarming ? 'font-bold text-status-danger-fg' : ''}`}>{stock.text}</span>
              ) : null}
              <span className={`justify-self-start rounded-pill px-2.5 py-[3px] text-[12px] font-semibold ${chip.className}`}>{chip.label}</span>
              <span className="relative">
                <button
                  type="button"
                  aria-label={`More actions for ${r.name}`}
                  aria-haspopup="menu"
                  aria-expanded={menuFor === r.id}
                  onClick={() => setMenuFor(menuFor === r.id ? null : r.id)}
                  className="flex size-10 items-center justify-center rounded-control border-0 bg-transparent p-0"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="5" cy="12" r="1.6" />
                    <circle cx="12" cy="12" r="1.6" />
                    <circle cx="19" cy="12" r="1.6" />
                  </svg>
                </button>
                {menuFor !== r.id ? null : (
                  <div role="menu" className="absolute right-0 top-10 z-10 flex min-w-44 flex-col rounded-card border border-line bg-surface p-1 shadow-menu">
                    <MenuItem onSelect={() => navigate(hrefFor(store.slug, `/products/${r.id}`))}>Edit</MenuItem>
                    <MenuItem
                      onSelect={() =>
                        void run([r.id], r.status === 'active' ? 'draft' : 'activate', () =>
                          r.status === 'active' ? `${r.name} is hidden from your store` : `${r.name} is live`,
                        )
                      }
                    >
                      {r.status === 'active' ? 'Hide from store' : 'Set active'}
                    </MenuItem>
                    <MenuItem danger onSelect={() => setConfirmDelete([r.id])}>
                      Delete
                    </MenuItem>
                  </div>
                )}
              </span>
            </div>
          );
        })}

        {shown.length > 0 ? null : (
          <div className="p-12 text-center">
            {list.counts.all === 0 ? (
              <>
                <p className="m-0 font-semibold">No {many} yet</p>
                <p className="m-0 mt-1 text-body text-muted">Add your first {one} and it can be ordered straight away.</p>
              </>
            ) : (
              <>
                <p className="m-0 font-semibold">No {many} match</p>
                <p className="m-0 mt-1 text-body text-muted">Try another word or clear the filters.</p>
              </>
            )}
          </div>
        )}

        <div className="flex items-center justify-between border-t border-line-subtle px-4 py-3 text-body text-muted">
          <span>{list.total === 0 ? 'Nothing to show' : `Showing ${from}–${to} of ${list.total}`}</span>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={list.page <= 1} onClick={() => setPage(list.page - 1)}>
              Previous
            </Button>
            <Button variant="secondary" disabled={list.page >= lastPage} onClick={() => setPage(list.page + 1)}>
              Next
            </Button>
          </div>
        </div>
      </section>

      <ConfirmModal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={confirmDelete !== null && confirmDelete.length === 1 ? `Delete this ${one}?` : `Delete ${confirmDelete?.length ?? 0} ${many}?`}
        body={`This can’t be undone. Anything that has already been ordered is kept — hide it instead.`}
        confirmLabel="Delete"
        onConfirm={() => {
          const ids = confirmDelete ?? [];
          setConfirmDelete(null);
          void run(ids, 'delete', deleteDone);
        }}
      />

      {toast === null ? null : (
        <div className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}

function BulkButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }): ReactNode {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="h-9 rounded-control border border-muted bg-transparent px-3.5 text-caption font-semibold text-white disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function MenuItem({ children, onSelect, danger = false }: { children: ReactNode; onSelect: () => void; danger?: boolean }): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={`h-10 rounded-control bg-transparent px-3 text-left text-body hover:bg-status-neutral ${danger ? 'text-status-danger-fg' : 'text-ink'}`}
    >
      {children}
    </button>
  );
}
