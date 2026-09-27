// client/src/console/NotificationsPanel.tsx — milestone 19, from project/Notifications.dc.html.
//
// The bell's panel: two tabs, a keyset-paged list, "Mark all as read", and the per-device sound switch.
//
// A <dialog>, NOT A FLOATING DIV. The board draws a popover anchored under the bell, which is none of the kit's
// three overlays — but it needs everything <dialog> gives: Escape, the focus trap, and a background that cannot
// be tabbed into while it is open. So it borrows the kit's `useDialog` and positions itself, which is why this
// is not a fourth kit component: the positioning is the console's, the mechanism is the kit's.
//
// READING ONE IS A WRITE, AND IT HAPPENS ON THE WAY OUT. Following a row marks it read and then navigates. The
// order matters on a slow connection: navigating first unmounts this component and cancels the request, and the
// notification stays bold for something the merchant has already dealt with.
//
// THE TABS ARE A TABLIST, not the kit's Segmented — which is a radiogroup, and correctly so: Segmented picks a
// value in a form ("Delivery / Pickup"), where these switch between two views of the same list. The board marks
// them role="tab" with aria-selected, and that is what a screen reader needs to hear here.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Spinner, Switch, useDialog } from '../shared/ui/index.ts';
import { ApiFailure } from '../app/api.ts';
import { notifications as notificationsApi } from './api.ts';
import type { Notification, NotificationCursor } from './api.ts';
import { notificationLine, relativeWhen } from './lines.ts';
import { consoleHref } from './nav.ts';
import { useShell } from './ShellProvider.tsx';

type Tab = 'all' | 'unread';

type Props = {
  open: boolean;
  onClose: () => void;
  /** Sound is per device and the alert owns the state, so the panel is told rather than asking again. */
  sound: boolean;
  onSoundChange: (enabled: boolean) => void;
  navigate: (to: string) => void;
  /** Called after a read or a mark-all, so the bell's count and the sidebar agree with the panel. */
  onUnreadChange: (unread: number) => void;
};

export function NotificationsPanel({
  open,
  onClose,
  sound,
  onSoundChange,
  navigate,
  onUnreadChange,
}: Props): ReactNode {
  const { store, currency } = useShell();
  const ref = useDialog(open);

  const [tab, setTab] = useState<Tab>('all');
  const [items, setItems] = useState<Notification[]>([]);
  const [cursor, setCursor] = useState<NotificationCursor | null>(null);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A page load per (tab, open) — and re-run when the panel is reopened, because notifications arrive while it
  // is shut. The `live` flag is what stops a slow first page from overwriting a fast second one.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setError(null);
    notificationsApi
      .page(store.id, { unreadOnly: tab === 'unread' })
      .then((page) => {
        if (!live) return;
        setItems(page.notifications);
        setCursor(page.nextCursor);
        setUnread(page.unread);
        onUnreadChange(page.unread);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setError(cause instanceof ApiFailure ? cause.message : 'Your notifications could not be loaded.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [open, tab, store.id, onUnreadChange]);

  const loadMore = useCallback(() => {
    if (cursor === null || loading) return;
    setLoading(true);
    notificationsApi
      .page(store.id, { unreadOnly: tab === 'unread', before: cursor })
      .then((page) => {
        setItems((previous) => [...previous, ...page.notifications]);
        setCursor(page.nextCursor);
      })
      .catch(() => setError('There was a problem loading more.'))
      .finally(() => setLoading(false));
  }, [cursor, loading, store.id, tab]);

  const markAll = useCallback(() => {
    setBusy(true);
    notificationsApi
      .markAllRead(store.id)
      .then((result) => {
        setItems((previous) => previous.map((n) => ({ ...n, unread: false })));
        setUnread(result.unread);
        onUnreadChange(result.unread);
        // The Unread tab is now empty by definition, and its own empty state says so.
      })
      .catch(() => setError('They could not be marked as read.'))
      .finally(() => setBusy(false));
  }, [store.id, onUnreadChange]);

  const follow = useCallback(
    async (n: Notification): Promise<void> => {
      const to = consoleHref(store.slug, n.route);
      if (n.unread) {
        try {
          const result = await notificationsApi.markRead(store.id, n.id);
          setUnread(result.unread);
          onUnreadChange(result.unread);
        } catch {
          // Following it is the point; a failed read-receipt must not block the navigation.
        }
      }
      onClose();
      navigate(to);
    },
    [store.id, store.slug, navigate, onClose, onUnreadChange],
  );

  const shown = tab === 'unread' ? items.filter((n) => n.unread) : items;
  const listRef = useRef<HTMLDivElement | null>(null);

  const tabs: readonly { id: Tab; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'unread', label: `Unread (${unread})` },
  ];

  return (
    <dialog
      ref={ref}
      aria-label="Notifications"
      onClose={onClose}
      onCancel={onClose}
      onClick={(event) => {
        // The backdrop is the dialog element itself; a click that lands on it and not on the panel closes.
        if (event.target === ref.current) onClose();
      }}
      className="m-0 max-h-none max-w-none border-0 bg-transparent p-0 backdrop:bg-ink/40 open:fixed open:inset-0 open:flex open:items-end open:justify-center lg:open:items-start lg:open:justify-start"
    >
      <section
        // The board anchors it at left 200 / top 58, under the bell. On a phone it is a sheet across the bottom.
        className="flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-sheet border border-line bg-surface shadow-sheet lg:mt-[58px] lg:ml-[200px] lg:max-h-[760px] lg:w-[420px] lg:rounded-sheet"
      >
        <header className="flex flex-col gap-2.5 border-b border-line px-4 pb-2.5 pt-4">
          <div className="flex items-center justify-between">
            <h2 className="text-title">Notifications</h2>
            <button
              type="button"
              onClick={markAll}
              disabled={unread === 0 || busy}
              className={`bg-transparent text-caption font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                unread === 0 || busy ? 'cursor-not-allowed text-disabled' : 'text-brand'
              }`}
            >
              Mark all as read
            </button>
          </div>
          <div role="tablist" aria-label="Which notifications" className="flex rounded-control bg-line-subtle p-[3px]">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`h-[34px] flex-1 rounded-chip text-caption font-semibold focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink ${
                  tab === t.id ? 'bg-surface text-ink shadow-menu' : 'bg-transparent text-ink-2'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </header>

        <div ref={listRef} className="flex grow flex-col overflow-y-auto">
          {error === null ? null : (
            <p className="px-4 py-3 text-caption text-status-danger-fg">{error}</p>
          )}

          {shown.map((n) => {
            const line = notificationLine(n, currency);
            return (
              <a
                key={n.id}
                href={consoleHref(store.slug, n.route)}
                onClick={(event) => {
                  event.preventDefault();
                  void follow(n);
                }}
                className={`flex gap-3 border-b border-line-subtle px-4 py-3 text-ink no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink ${
                  n.unread ? 'bg-brand-wash' : 'bg-surface'
                }`}
              >
                <span className={`flex size-9 shrink-0 items-center justify-center rounded-control ${line.tone}`}>
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d={line.icon} />
                  </svg>
                </span>
                <span className="flex min-w-0 grow flex-col">
                  <span className={`text-caption ${n.unread ? 'font-bold' : 'font-medium'}`}>{line.title}</span>
                  {line.sub === '' ? null : <span className="text-caption text-muted">{line.sub}</span>}
                  <span className="mt-0.5 text-[12px] text-muted">
                    {relativeWhen(n.createdAt, store.timeZone)}
                  </span>
                </span>
                {n.unread ? (
                  <span aria-label="Unread" className="mt-1.5 size-2.5 shrink-0 rounded-pill bg-brand" />
                ) : null}
              </a>
            );
          })}

          {shown.length === 0 && !loading && error === null ? (
            <EmptyInbox caughtUp={tab === 'unread' && items.length > 0} />
          ) : null}

          {loading ? (
            <p className="flex items-center justify-center gap-2 py-6 text-caption text-muted">
              <Spinner /> Loading
            </p>
          ) : null}

          {cursor !== null && !loading ? (
            <button
              type="button"
              onClick={loadMore}
              className="border-t border-line-subtle bg-transparent py-3 text-caption font-semibold text-brand focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink"
            >
              Show older
            </button>
          ) : null}
        </div>

        <footer className="flex items-center border-t border-line px-4 py-3 text-body">
          <Switch
            label="Sound for new orders"
            labelPosition="before"
            tone="brand"
            checked={sound}
            onChange={onSoundChange}
          />
        </footer>
      </section>
    </dialog>
  );
}

/**
 * The two empty states, and they say different things on purpose.
 *
 * `States.dc.html`'s whole argument is that the wording is the design: "You're all caught up" is a
 * congratulation for a merchant who has read everything, and "No notifications yet" is an explanation for one
 * whose shop has not had its first order. Showing either in the other's place is wrong.
 */
function EmptyInbox({ caughtUp }: { caughtUp: boolean }): ReactNode {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <span className="flex size-13 items-center justify-center rounded-pill bg-line-subtle">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-muted"
          aria-hidden="true"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4" />
        </svg>
      </span>
      <strong>{caughtUp ? 'You’re all caught up' : 'No notifications yet'}</strong>
      <span className="text-caption text-muted">
        {caughtUp
          ? 'New orders, deliveries, complaints and payouts show up here.'
          : 'When customers order, riders deliver or money moves, you’ll see it here.'}
      </span>
    </div>
  );
}
