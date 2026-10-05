// client/src/console/Console.tsx — milestone 19.
//
// The merchant console's frame: the sidebar (or the phone's bottom bar), the screen, the notifications panel, the
// new-order alert and the toast. Every console milestone from here renders inside this.
//
// THE POLLING IS HERE AND NOWHERE ELSE, for one reason: the alert has to appear on a screen nobody is touching.
// A dashboard that refreshed itself would leave a merchant sitting on Products while an order waited. So the
// shell asks two questions on a timer — "is an order waiting?" every ten seconds, and "what do the figures say?"
// every minute — and the screen underneath is handed the answer.
//
// AND IT STOPS WHEN THE TAB IS HIDDEN. A phone in a pocket polling every ten seconds all day is somebody's data
// and somebody's battery. On becoming visible it asks immediately rather than waiting for the next tick, which
// is what makes a tablet woken at the counter correct straight away instead of ten seconds later.
//
// WHY POLLING AT ALL, when §1.2 keeps Socket.io in the stack: server/src/routes/storeNotifications.ts has the
// argument. In short, a socket cuts the latency and polling is what stays correct after a reload, a network drop
// and a sleeping screen. When the console moves onto sockets, these two intervals are what changes.

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, SkeletonCard, Toast } from '../shared/ui/index.ts';
import { dashboard as dashboardApi, notifications as notificationsApi } from './api.ts';
import type { DashboardData, OrderAlert as AlertData } from './api.ts';
import { CashReport } from './CashReport.tsx';
import { Analytics } from './Analytics.tsx';
import { Categories } from './Categories.tsx';
import { Complaints } from './Complaints.tsx';
import { Customers } from './Customers.tsx';
import { Dashboard } from './Dashboard.tsx';
import { NotificationsPanel } from './NotificationsPanel.tsx';
import { OrderAlert } from './OrderAlert.tsx';
import { Orders } from './Orders.tsx';
import { Wallet } from './Wallet.tsx';
import { ProductEditor } from './ProductEditor.tsx';
import { Products } from './Products.tsx';
import { Reviews } from './Reviews.tsx';
import { MobileTabs, Sidebar } from './Sidebar.tsx';
import { ShellProvider, useShell } from './ShellProvider.tsx';
import type { ShellState } from './ShellProvider.tsx';
import { unlockSoundOnFirstGesture } from './chime.ts';

/** Ten seconds for the alert, sixty for the figures. See the header on why these are the shell's. */
const ALERT_EVERY_MS = 10_000;
const FIGURES_EVERY_MS = 60_000;

/**
 * Milestone 20 added 'orders'; 21 'riders'; 22 adds the catalogue's three. Every screen from here adds one more case.
 *
 * `product` is AddProduct: `productId` null is "New product", a uuid is editing that one. It is a different KIND
 * from `products` (the list) and highlights the same sidebar item — see `activeItem()`.
 */
export type ConsoleView =
  | { kind: 'dashboard' }
  | { kind: 'orders' }
  | { kind: 'riders' }
  | { kind: 'products' }
  | { kind: 'product'; productId: string | null }
  | { kind: 'categories' }
  | { kind: 'money' }
  | { kind: 'complaints' }
  | { kind: 'reviews' }
  | { kind: 'customers' }
  | { kind: 'analytics' };

/** The sidebar highlights the list while its editor is open: the editor is Products, one level down. */
export function activeItem(view: ConsoleView): string {
  return view.kind === 'product' ? 'products' : view.kind;
}

type Props = {
  slug: string;
  view: ConsoleView;
  navigate: (to: string) => void;
};

export function Console({ slug, view, navigate }: Props): ReactNode {
  return (
    <ShellProvider slug={slug} fallback={(state, retry) => <ShellFallback state={state} retry={retry} navigate={navigate} />}>
      <ConsoleFrame view={view} navigate={navigate} />
    </ShellProvider>
  );
}

function ConsoleFrame({ view, navigate }: { view: ConsoleView; navigate: (to: string) => void }): ReactNode {
  const { store, setBadges, badges } = useShell();

  const [data, setData] = useState<DashboardData | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const [alert, setAlert] = useState<AlertData | null>(null);
  const [sound, setSound] = useState(true);
  const [silenced, setSilenced] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // The bell's number. Seeded from the shell and then owned here, because three things change it: the panel
  // marking rows read, the dashboard poll, and notifications arriving.
  const [unread, setUnread] = useState(badges.notifications);

  // Spend the first gesture so a chime twenty seconds from now is not dropped by the autoplay policy.
  useEffect(() => unlockSoundOnFirstGesture(), []);

  const loadFigures = useCallback(async (): Promise<void> => {
    try {
      const next = await dashboardApi.load(store.id);
      setData(next);
      setUnread(next.unreadNotifications);
      setFailure(null);
    } catch (cause) {
      // Only a FIRST load is a failure worth a screen. A poll that fails leaves the figures alone — a merchant
      // watching a dashboard through a flaky connection should see the last good numbers, not an error.
      setFailure((previous) =>
        previous === null && data === null
          ? cause instanceof ApiFailure
            ? cause
            : new ApiFailure({ status: 0, code: 'UNKNOWN', message: 'The dashboard could not be loaded.' })
          : previous,
      );
    }
  }, [store.id, data]);

  const loadAlert = useCallback(async (): Promise<void> => {
    try {
      const result = await notificationsApi.alert(store.id);
      setAlert(result.alert);
      setSound(result.sound);
    } catch {
      // Silent: the alert is a poll, and a missed one is corrected ten seconds later.
    }
  }, [store.id]);

  // One effect for both timers, so they cannot drift apart or be paused separately.
  useEffect(() => {
    let alive = true;
    const tick = (): void => {
      if (!alive || document.visibilityState === 'hidden') return;
      void loadAlert();
    };
    const slowTick = (): void => {
      if (!alive || document.visibilityState === 'hidden') return;
      void loadFigures();
    };

    void loadFigures();
    void loadAlert();

    const fast = window.setInterval(tick, ALERT_EVERY_MS);
    const slow = window.setInterval(slowTick, FIGURES_EVERY_MS);

    // Asking on becoming visible rather than waiting for the next tick.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        void loadAlert();
        void loadFigures();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      alive = false;
      window.clearInterval(fast);
      window.clearInterval(slow);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // Deliberately keyed to the store alone: re-running this on every figures change would restart both timers
    // on every poll. The callbacks read the latest store id, which is the only thing that may change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.id]);

  // The badges the sidebar draws come from the shell; the dashboard's own read is fresher, so it corrects them.
  useEffect(() => {
    if (data === null) return;
    setBadges({
      orders: data.counts.ordersWaiting,
      complaints: badges.complaints,
      reviews: badges.reviews,
      notifications: data.unreadNotifications,
    });
    // Only when the two numbers this screen owns actually move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.counts.ordersWaiting, data?.unreadNotifications]);

  const changeSound = useCallback(
    (enabled: boolean) => {
      // Optimistic, then corrected by the server's answer: a switch that waits for a round trip feels broken,
      // and the only cost of being wrong for 200 ms is one chime.
      setSound(enabled);
      void notificationsApi
        .setSound(store.id, enabled)
        .then((result) => setSound(result.sound))
        .catch(() => setSound(!enabled));
    },
    [store.id],
  );

  const flash = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 4000);
  }, []);

  const showAlert = alert !== null && alert.orderId !== silenced;

  return (
    <div className="flex min-h-dvh">
      <Sidebar
        active={activeItem(view)}
        unread={unread}
        onOpenNotifications={() => setPanelOpen(true)}
        navigate={navigate}
      />

      <main className="grow px-4 pb-24 pt-5 lg:h-dvh lg:overflow-y-auto lg:px-10 lg:py-8 lg:pb-8">
        {/* The bell is in the sidebar on desktop; on a phone the bottom bar has no room for it, so it rides
            above the screen's own heading. */}
        <div className="mb-3 flex justify-end lg:hidden">
          <button
            type="button"
            onClick={() => setPanelOpen(true)}
            aria-label={unread === 0 ? 'Notifications' : `Notifications, ${unread} unread`}
            className="relative flex size-11 items-center justify-center rounded-pill border border-line bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4" />
            </svg>
            {unread === 0 ? null : (
              <span className="absolute right-1 top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-pill bg-status-danger-fg px-[5px] text-[11px] font-bold text-white">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>
        </div>

        {view.kind === 'orders' ? (
          <Orders navigate={navigate} />
        ) : view.kind === 'riders' ? (
          <CashReport />
        ) : view.kind === 'products' ? (
          <Products navigate={navigate} />
        ) : view.kind === 'product' ? (
          // Keyed by the product, so moving from one to another (or from "new" to a saved one) starts a fresh editor
          // rather than carrying the last one's half-typed state across.
          <ProductEditor key={view.productId ?? 'new'} navigate={navigate} productId={view.productId} />
        ) : view.kind === 'categories' ? (
          <Categories />
        ) : view.kind === 'money' ? (
          <Wallet navigate={navigate} />
        ) : view.kind === 'complaints' ? (
          <Complaints navigate={navigate} />
        ) : view.kind === 'reviews' ? (
          <Reviews />
        ) : view.kind === 'customers' ? (
          <Customers navigate={navigate} />
        ) : view.kind === 'analytics' ? (
          <Analytics />
        ) : data === null ? (
          failure === null ? (
            <div className="flex flex-col gap-4">
              <SkeletonCard />
              <SkeletonCard />
            </div>
          ) : (
            <Alert tone="danger" headline={failure.message}>
              <Button variant="secondary" onClick={() => void loadFigures()}>
                Try again
              </Button>
            </Alert>
          )
        ) : (
          <Dashboard data={data} onChanged={setData} navigate={navigate} />
        )}
      </main>

      <MobileTabs active={activeItem(view)} navigate={navigate} />

      <NotificationsPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        sound={sound}
        onSoundChange={changeSound}
        navigate={navigate}
        onUnreadChange={setUnread}
      />

      {showAlert && alert !== null ? (
        <OrderAlert
          alert={alert}
          sound={sound}
          onSilence={() => setSilenced(alert.orderId)}
          onAccepted={(message) => {
            setSilenced(alert.orderId);
            flash(message);
            // The queue, the count and the badge all just changed, so ask rather than guess.
            void loadFigures();
            void loadAlert();
          }}
          navigate={navigate}
        />
      ) : null}

      {toast === null ? null : (
        <div className="fixed bottom-24 left-1/2 z-30 -translate-x-1/2 lg:bottom-6">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}

/**
 * What the console shows before it has a store — and the four cases are four different sentences, because
 * `States.dc.html`'s argument is that the wording is the design and "something went wrong" covers none of them.
 */
function ShellFallback({
  state,
  retry,
  navigate,
}: {
  state: ShellState;
  retry: () => void;
  navigate: (to: string) => void;
}): ReactNode {
  if (state.status === 'loading') {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (state.status === 'signed-out') {
    return (
      <div className="mx-auto max-w-lg p-6">
        <Alert tone="info" headline="Please sign in again">
          <Button onClick={() => navigate('/signin')}>Sign in</Button>
        </Alert>
      </div>
    );
  }

  if (state.status === 'not-yours') {
    return (
      <div className="mx-auto max-w-lg p-6">
        <Alert tone="warn" headline={`You don’t work at ${state.slug}`}>
          <p className="mb-3 text-body">
            Signed in, but not at this store. If somebody invited you, open the invitation link they sent.
          </p>
          <Button variant="secondary" onClick={() => navigate('/signin')}>
            Choose another store
          </Button>
        </Alert>
      </div>
    );
  }

  // 'ready' never reaches here — the provider renders its children instead — but narrowing on it rather than
  // asserting means a sixth state added later is a type error here, not a blank screen.
  if (state.status !== 'failed') return null;

  return (
    <div className="mx-auto max-w-lg p-6">
      <Alert tone="danger" headline={state.error.message}>
        {state.error.hint === undefined ? null : <p className="mb-3 text-body">{state.error.hint}</p>}
        <Button variant="secondary" onClick={retry}>
          Try again
        </Button>
      </Alert>
    </div>
  );
}
