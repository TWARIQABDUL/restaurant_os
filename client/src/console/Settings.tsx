// client/src/console/Settings.tsx — milestone 25, from project/Settings.dc.html.
//
// FIVE PANELS, THE BOARD'S THREE AND THE TWO IT OWES. Features, Delivery and pickup, and Payments are drawn; "Store
// details" and "Staff" are in the board's own left navigation and have no panel (Part 9: "owed by the designer"). They are
// built here in the board's visual language rather than left as dead links, because Staff is where a store admin creates
// managers and riders (§5.4) and nothing else in the product does that.
//
// A SCREEN OVER FIVE SERVER SURFACES. Features and business type are the config routes, Staff is the members routes, and
// the rest are the settings routes — none of them moved for this screen, which is why the panels each own their own state
// and a failure in one cannot blank another.
//
// THE PAYOUT NUMBER ASKS FOR THE PASSWORD. It is the one setting that redirects the store's money, so changing it
// re-authenticates the person making the change — a session cookie proves somebody signed in on that browser once, not that
// the person holding it now is the owner (routes/storeSettings.ts).
//
// A CHANGE OF BUSINESS TYPE OR FEATURE TAKES EFFECT EVERYWHERE AT ONCE. The server's answer is handed to the shell
// (`setConfig`), so the sidebar, the vocabulary and every `has()` gate follow immediately instead of on the next page load.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, ConfirmModal, Switch, TextField, Toast, useDialog } from '../shared/ui/index.ts';
import { cleanAmount, cleanCount } from './catalogue.ts';
import { configApi, settingsApi, staffApi } from './settingsApi.ts';
import type { HoursRow, Member, OfferedTemplate, SettingsBase, SettingsExtra, Zone } from './settingsApi.ts';
import {
  DAY_NAMES,
  MODULE_COPY,
  ROLE_BLURB,
  ROLE_LABEL,
  generatePassword,
  grantableRoles,
  hoursSummary,
  paymentCopy,
  paymentState,
  payoutSentence,
  pickupLine,
  visibleModules,
  weekFrom,
  weekToRows,
  zoneAreasLine,
  zoneFeeLine,
} from './settingsLines.ts';
import { DEFAULT_INPUTS } from './lookDraft.ts';
import { posterHtml, printHtml, qrSvg } from './printables.ts';
import { useShell } from './ShellProvider.tsx';
import { compileTheme } from '../app/core.ts';
import { lookApi } from './api.ts';
import { methodName } from './walletLines.ts';

type Props = {
  navigate: (to: string) => void;
  /** The render gate's seam: effects do not run in static markup. Console.tsx passes none. */
  initial?: { base: SettingsBase; extra: SettingsExtra; members: Member[]; templates?: OfferedTemplate[] };
  initialOpen?: 'zone' | 'pickup' | 'payout' | 'staff' | 'template';
};

const SECTIONS = [
  { id: 'features', label: 'Features' },
  { id: 'fulfilment', label: 'Delivery and pickup' },
  { id: 'payments', label: 'Payments' },
  { id: 'details', label: 'Store details' },
  { id: 'staff', label: 'Staff' },
] as const;

export function Settings({ initial, initialOpen }: Props): ReactNode {
  const { store, may } = useShell();
  const [base, setBase] = useState<SettingsBase | null>(initial?.base ?? null);
  const [extra, setExtra] = useState<SettingsExtra | null>(initial?.extra ?? null);
  const [members, setMembers] = useState<Member[] | null>(initial?.members ?? null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const seeded = useRef(initial !== undefined);

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((current) => (current === m ? null : current)), 3200);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await settingsApi.load(store.id);
      setBase(r.base);
      setExtra(r.extra);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : 'Settings could not be loaded.');
    }
  }, [store.id]);

  const loadMembers = useCallback(async (): Promise<void> => {
    try {
      setMembers((await staffApi.list(store.id)).members);
    } catch {
      setMembers([]);
    }
  }, [store.id]);

  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    void load();
    void loadMembers();
  }, [load, loadMembers]);

  if (!may('settings.write')) {
    return (
      <Alert tone="info" headline="Your role can’t see settings.">
        <span>Settings are for owners and admins. Ask the owner of {store.name} to change your role.</span>
      </Alert>
    );
  }

  if (base === null || extra === null) {
    return error === null ? (
      <div className="flex flex-col gap-3" aria-busy="true">
        <div className="h-40 animate-pulse rounded-card bg-status-neutral" />
        <div className="h-40 animate-pulse rounded-card bg-status-neutral" />
      </div>
    ) : (
      <Alert tone="danger" headline={error}>
        <Button variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:gap-10">
      <nav aria-label="Settings sections" className="flex shrink-0 gap-1 overflow-x-auto lg:w-[200px] lg:flex-col lg:gap-0.5">
        <h1 className="m-0 hidden font-display text-[30px] lg:mb-4 lg:block">Settings</h1>
        {SECTIONS.map((s, i) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            onClick={(e) => {
              e.preventDefault();
              document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            className={`flex h-10 shrink-0 items-center rounded-chip px-3 text-body font-semibold no-underline ${i === 0 ? 'bg-status-neutral text-ink' : 'text-ink-2'}`}
          >
            {s.label}
          </a>
        ))}
      </nav>

      <div className="flex max-w-[760px] grow flex-col gap-5">
        <h1 className="m-0 font-display text-[26px] lg:hidden">Settings</h1>
        <FeaturesPanel flash={flash} initialOpen={initialOpen === 'template'} initialTemplates={initial?.templates} />
        <FulfilmentPanel extra={extra} base={base} flash={flash} onChanged={load} initialOpen={initialOpen === 'zone' ? 'zone' : initialOpen === 'pickup' ? 'pickup' : undefined} />
        <PaymentsPanel extra={extra} base={base} flash={flash} onChanged={load} initialOpen={initialOpen === 'payout'} />
        <DetailsPanel extra={extra} flash={flash} onChanged={load} />
        <StaffPanel members={members} flash={flash} onChanged={loadMembers} initialOpen={initialOpen === 'staff'} />
      </div>

      {toast === null ? null : (
        <div className="fixed bottom-24 left-1/2 z-30 -translate-x-1/2 lg:bottom-6">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Card({ id, title, intro, action, children }: { id: string; title: string; intro?: ReactNode; action?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <section id={id} className="flex scroll-mt-4 flex-col gap-3 rounded-card border border-line bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="m-0 text-[18px] font-bold">{title}</h2>
          {intro === undefined ? null : <p className="m-0 mt-0.5 text-body text-muted">{intro}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

const reason = (cause: unknown, fallback: string): string => (cause instanceof ApiFailure ? cause.message : fallback);

/** A dialog the kit does not have a component for: a form in the centre of the screen. See useDialog's own header. */
function FormDialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }): ReactNode {
  const ref = useDialog(open);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-auto w-[min(480px,calc(100vw-32px))] rounded-card bg-surface p-5 text-ink backdrop:bg-ink/40"
    >
      <div className="flex flex-col gap-3.5">
        <strong className="text-title">{title}</strong>
        {children}
      </div>
    </dialog>
  );
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

function FeaturesPanel({ flash, initialOpen, initialTemplates }: { flash: (m: string) => void; initialOpen: boolean; initialTemplates: OfferedTemplate[] | undefined }): ReactNode {
  const { store, config, setConfig, templateName } = useShell();
  const [busy, setBusy] = useState<string | null>(null);
  const [pickOpen, setPickOpen] = useState(initialOpen);
  const [templates, setTemplates] = useState<OfferedTemplate[] | null>(initialTemplates ?? null);
  const [chosen, setChosen] = useState<string | null>(null);

  const toggle = async (key: string, on: boolean): Promise<void> => {
    setBusy(key);
    try {
      const r = await configApi.setModules(store.id, { [key]: on });
      setConfig(r.config);
    } catch (cause) {
      flash(reason(cause, 'That could not be changed.'));
    } finally {
      setBusy(null);
    }
  };

  const openPicker = (): void => {
    setPickOpen(true);
    if (templates === null) {
      void configApi
        .templates(store.id)
        .then((r) => setTemplates(r.templates))
        .catch(() => flash('The business types could not be loaded.'));
    }
  };

  const switchTo = async (): Promise<void> => {
    if (chosen === null) return;
    setBusy('template');
    try {
      await configApi.setTemplate(store.id, chosen);
      // The new template changes words, modules and order steps: re-read the whole resolved config rather than guess.
      const refreshed = await configApi.setModules(store.id, {});
      setConfig(refreshed.config);
      flash('Business type changed. Anything you customised is kept.');
      setPickOpen(false);
    } catch (cause) {
      flash(reason(cause, 'That could not be changed.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      id="features"
      title="Features"
      intro={
        <>
          {templateName === null ? 'No business type chosen yet.' : <>Set up for <strong className="text-ink">{templateName}</strong>.</>} Turn on only what you use; your store and dashboard adapt.
        </>
      }
      action={
        <Button variant="secondary" type="button" onClick={openPicker}>
          Change business type
        </Button>
      }
    >
      <div>
        {visibleModules(config.modules).map((key) => {
          const copy = MODULE_COPY[key] ?? { label: config.modules[key]!.label, desc: '' };
          const on = config.modules[key]!.enabled;
          return (
            <div key={key} className="flex items-center gap-4 border-t border-line-subtle py-3.5">
              <span className="flex grow flex-col">
                <span className="font-semibold">{copy.label}</span>
                <span className="text-body text-muted">{copy.desc}</span>
              </span>
              <Switch tone="brand" label={copy.label} checked={on} disabled={busy === key} onChange={(next) => void toggle(key, next)} />
            </div>
          );
        })}
      </div>

      <FormDialog open={pickOpen} title="Change business type" onClose={() => setPickOpen(false)}>
        <p className="m-0 text-body text-ink-2">
          This changes the words your store uses and the features it starts with. Anything you’ve customised — renamed sections, features you switched on or off — is kept.
        </p>
        <div role="radiogroup" aria-label="Business type" className="flex flex-col gap-1.5">
          {(templates ?? []).map((t) => (
            <label key={t.key} className={`flex cursor-pointer items-center gap-2.5 rounded-control p-3 ${chosen === t.key ? 'border-2 border-ink' : 'border border-line'}`}>
              <input type="radio" name="template" checked={chosen === t.key} onChange={() => setChosen(t.key)} className="size-[18px] accent-brand" />
              <span className="grow font-semibold">{t.name}</span>
              {t.name === templateName ? <span className="text-caption text-muted">Current</span> : null}
            </label>
          ))}
          {templates === null ? <span className="text-caption text-muted">Loading…</span> : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="text" tone="brand" type="button" onClick={() => setPickOpen(false)}>
            Cancel
          </Button>
          <Button tone="brand" type="button" disabled={chosen === null || templates?.find((t) => t.key === chosen)?.name === templateName} busy={busy === 'template'} busyLabel="Switching…" onClick={() => void switchTo()}>
            Switch
          </Button>
        </div>
      </FormDialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Delivery and pickup
// ---------------------------------------------------------------------------

type ZoneDraft = { id: string | null; name: string; fee: string; etaMin: string; etaMax: string; areas: string };

const BLANK_ZONE: ZoneDraft = { id: null, name: '', fee: '', etaMin: '25', etaMax: '35', areas: '' };

function FulfilmentPanel({ extra, base, flash, onChanged, initialOpen }: { extra: SettingsExtra; base: SettingsBase; flash: (m: string) => void; onChanged: () => Promise<void>; initialOpen: 'zone' | 'pickup' | undefined }): ReactNode {
  const { store, money, has } = useShell();
  const [zone, setZone] = useState<ZoneDraft | null>(initialOpen === 'zone' ? BLANK_ZONE : null);
  const [pickup, setPickup] = useState<{ on: boolean; address: string; ready: string; instructions: string } | null>(
    initialOpen === 'pickup' ? { on: true, address: base.pickup?.address ?? '', ready: String(base.pickup?.readyMinutes ?? 15), instructions: base.pickup?.instructions ?? '' } : null,
  );
  const [doomed, setDoomed] = useState<Zone | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const saveZone = async (): Promise<void> => {
    if (zone === null) return;
    setBusy(true);
    setProblem(null);
    const input = { name: zone.name, fee: zone.fee === '' ? '0' : zone.fee, etaMin: Number(zone.etaMin), etaMax: Number(zone.etaMax), areas: zone.areas.split(',').map((a) => a.trim()).filter((a) => a !== '') };
    try {
      if (zone.id === null) await settingsApi.createZone(store.id, input);
      else await settingsApi.updateZone(store.id, zone.id, input);
      setZone(null);
      await onChanged();
      flash('Delivery zone saved');
    } catch (cause) {
      setProblem(reason(cause, 'That zone could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  const savePickup = async (): Promise<void> => {
    if (pickup === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await settingsApi.savePickup(store.id, pickup.on ? { enabled: true, address: pickup.address, readyMinutes: Number(pickup.ready), ...(pickup.instructions.trim() === '' ? {} : { instructions: pickup.instructions }) } : { enabled: false });
      setPickup(null);
      await onChanged();
      flash(pickup.on ? 'Pickup saved' : 'Pickup is off');
    } catch (cause) {
      setProblem(reason(cause, 'Pickup could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card id="fulfilment" title="Delivery and pickup" intro={has('delivery') || has('pickup') ? undefined : 'Delivery and pickup are switched off in Features.'}>
      <div className="rounded-card border border-line">
        {extra.zones.map((z) => (
          <div key={z.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line-subtle px-4 py-3.5">
            <span>
              <strong>{z.name}</strong> <span className="text-muted">· {zoneAreasLine(z)}</span>
            </span>
            <span className="flex items-center gap-3">
              <span className="font-semibold">{zoneFeeLine(z, money)}</span>
              <Button variant="text" tone="brand" type="button" onClick={() => setZone({ id: z.id, name: z.name, fee: z.feeAmount.replace(/\.00$/, ''), etaMin: String(z.etaMinMinutes), etaMax: String(z.etaMaxMinutes), areas: z.areas.join(', ') })}>
                Edit
              </Button>
              <Button variant="text" type="button" onClick={() => setDoomed(z)}>
                Remove
              </Button>
            </span>
          </div>
        ))}
        {extra.zones.length > 0 ? null : <div className="border-b border-line-subtle px-4 py-3.5 text-body text-muted">No delivery zones yet. Customers can’t order delivery until you add one.</div>}
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3.5">
          <span>
            <strong>Pickup</strong> <span className="text-muted">· {base.pickup === null ? 'Off' : base.pickup.address}</span>
          </span>
          <span className="flex items-center gap-3">
            <span className="font-semibold">{base.pickup === null ? 'Not offered' : pickupLine(base.pickup)}</span>
            <Button
              variant="text"
              tone="brand"
              type="button"
              onClick={() => setPickup({ on: true, address: base.pickup?.address ?? extra.store.address ?? '', ready: String(base.pickup?.readyMinutes ?? 15), instructions: base.pickup?.instructions ?? '' })}
            >
              {base.pickup === null ? 'Turn on' : 'Edit'}
            </Button>
          </span>
        </div>
      </div>
      <Button variant="secondary" type="button" onClick={() => setZone(BLANK_ZONE)}>
        + Add delivery zone
      </Button>

      <FormDialog open={zone !== null} title={zone?.id === null ? 'Add a delivery zone' : 'Edit delivery zone'} onClose={() => setZone(null)}>
        {zone === null ? null : (
          <>
            {problem === null ? null : <Alert tone="danger" headline={problem} />}
            <TextField label="Zone name" value={zone.name} onChange={(e) => setZone({ ...zone, name: e.target.value })} placeholder="e.g. Kigali city centre" maxLength={80} />
            <div className="grid grid-cols-3 gap-2">
              <TextField label={`Fee (${store.currency.code})`} inputMode="decimal" value={zone.fee} onChange={(e) => setZone({ ...zone, fee: cleanAmount(e.target.value) })} placeholder="0" />
              <TextField label="Fastest (min)" inputMode="numeric" value={zone.etaMin} onChange={(e) => setZone({ ...zone, etaMin: cleanCount(e.target.value) })} />
              <TextField label="Slowest (min)" inputMode="numeric" value={zone.etaMax} onChange={(e) => setZone({ ...zone, etaMax: cleanCount(e.target.value) })} />
            </div>
            <TextField label="Areas" hint="Separate with commas. An area can be in one zone only." value={zone.areas} onChange={(e) => setZone({ ...zone, areas: e.target.value })} placeholder="Kacyiru, Kimihurura, Kiyovu" />
            <div className="flex justify-end gap-2">
              <Button variant="text" tone="brand" type="button" onClick={() => setZone(null)}>
                Cancel
              </Button>
              <Button tone="brand" type="button" busy={busy} busyLabel="Saving…" disabled={zone.name.trim() === ''} onClick={() => void saveZone()}>
                Save zone
              </Button>
            </div>
          </>
        )}
      </FormDialog>

      <FormDialog open={pickup !== null} title="Pickup" onClose={() => setPickup(null)}>
        {pickup === null ? null : (
          <>
            {problem === null ? null : <Alert tone="danger" headline={problem} />}
            <Switch tone="brand" label="Customers can order ahead and collect" checked={pickup.on} onChange={(on) => setPickup({ ...pickup, on })} />
            {!pickup.on ? null : (
              <>
                <TextField label="Where customers collect" value={pickup.address} onChange={(e) => setPickup({ ...pickup, address: e.target.value })} maxLength={200} />
                <TextField label="Ready in (minutes)" inputMode="numeric" value={pickup.ready} onChange={(e) => setPickup({ ...pickup, ready: cleanCount(e.target.value) })} />
                <TextField label="Instructions (optional)" hint="Shown to the customer, e.g. “Ask at the counter”." value={pickup.instructions} onChange={(e) => setPickup({ ...pickup, instructions: e.target.value })} maxLength={300} />
              </>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="text" tone="brand" type="button" onClick={() => setPickup(null)}>
                Cancel
              </Button>
              <Button tone="brand" type="button" busy={busy} busyLabel="Saving…" onClick={() => void savePickup()}>
                Save
              </Button>
            </div>
          </>
        )}
      </FormDialog>

      <ConfirmModal
        open={doomed !== null}
        onClose={() => setDoomed(null)}
        title={`Remove “${doomed?.name ?? ''}”?`}
        body="Customers in its areas won’t be able to order delivery until they’re in another zone. Past orders are not affected."
        confirmLabel="Remove zone"
        onConfirm={() => {
          const z = doomed;
          setDoomed(null);
          if (z === null) return;
          void settingsApi
            .deleteZone(store.id, z.id)
            .then(() => onChanged())
            .then(() => flash('Zone removed'))
            .catch((cause: unknown) => flash(reason(cause, 'That zone could not be removed.')));
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

function PaymentsPanel({ extra, base, flash, onChanged, initialOpen }: { extra: SettingsExtra; base: SettingsBase; flash: (m: string) => void; onChanged: () => Promise<void>; initialOpen: boolean }): ReactNode {
  const { store } = useShell();
  const [busy, setBusy] = useState<string | null>(null);
  const [payoutOpen, setPayoutOpen] = useState(initialOpen);
  const [method, setMethod] = useState(base.payout?.methodKey ?? 'mtn_momo');
  const [phone, setPhone] = useState(base.payout?.phone ?? '');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const connectedKeys = new Set(base.paymentMethods.filter((m) => m.isConnected).map((m) => m.key));
  const payoutMethods = extra.catalogue.filter((m) => m.kind === 'online' && m.status === 'live');

  const set = async (key: string, on: boolean): Promise<void> => {
    setBusy(key);
    try {
      await settingsApi.setMethod(store.id, key, on);
      await onChanged();
    } catch (cause) {
      flash(reason(cause, 'That could not be changed.'));
    } finally {
      setBusy(null);
    }
  };

  const savePayout = async (): Promise<void> => {
    setBusy('payout');
    setProblem(null);
    try {
      await settingsApi.savePayout(store.id, { methodKey: method, phone, password });
      setPayoutOpen(false);
      setPassword('');
      await onChanged();
      flash('Payout number changed');
    } catch (cause) {
      setProblem(reason(cause, 'That could not be changed.'));
      // A wrong password must not stay in the box for the next attempt to build on.
      setPassword('');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card id="payments" title="Payments">
      <div>
        {extra.catalogue.map((m) => {
          const copy = paymentCopy(m.key);
          const state = paymentState(m, connectedKeys.has(m.key));
          return (
            <div key={m.key} className="flex items-center gap-3.5 border-t border-line-subtle py-3">
              <span aria-hidden="true" className={`flex h-[34px] w-12 items-center justify-center rounded-chip text-[11px] font-bold ${copy.tone}`}>
                {copy.mark}
              </span>
              <span className="flex grow flex-col">
                <span className="font-semibold">{m.name}</span>
                <span className="text-body text-muted">{copy.desc}</span>
              </span>
              {state === 'connected' ? (
                <span className="flex items-center gap-2">
                  <span className="rounded-pill bg-status-success px-2.5 py-[3px] text-[12px] font-semibold text-status-success-fg">Connected</span>
                  <Button variant="text" type="button" disabled={busy === m.key} onClick={() => void set(m.key, false)}>
                    Turn off
                  </Button>
                </span>
              ) : state === 'connectable' ? (
                <Button tone="brand" type="button" busy={busy === m.key} busyLabel="Connecting…" onClick={() => void set(m.key, true)}>
                  Connect
                </Button>
              ) : (
                <span className="rounded-pill bg-status-neutral px-2.5 py-[3px] text-[12px] font-semibold text-status-neutral-fg">Coming soon</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-ground p-3.5 text-body text-ink-2">
        <span>{payoutSentence(base.payout)}</span>
        <Button variant="secondary" type="button" onClick={() => setPayoutOpen(true)}>
          {base.payout === null ? 'Add number' : 'Change'}
        </Button>
      </div>

      <FormDialog open={payoutOpen} title="Where your payouts go" onClose={() => setPayoutOpen(false)}>
        <p className="m-0 text-body text-ink-2">Money you’ve earned is paid to this mobile money account. Because it moves your money, we ask for your password.</p>
        {problem === null ? null : <Alert tone="danger" headline={problem} />}
        <label className="flex flex-col gap-1.5 text-body font-semibold">
          Mobile money account
          <select value={method} onChange={(e) => setMethod(e.target.value)} className="h-11 rounded-control border border-control-line bg-surface px-2.5 font-normal">
            {payoutMethods.map((m) => (
              <option key={m.key} value={m.key}>
                {methodName(m.key)}
              </option>
            ))}
          </select>
        </label>
        <TextField label="Phone number" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="078 123 4567" />
        <TextField label="Your password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button variant="text" tone="brand" type="button" onClick={() => setPayoutOpen(false)}>
            Cancel
          </Button>
          <Button tone="brand" type="button" busy={busy === 'payout'} busyLabel="Saving…" disabled={phone.trim() === '' || password === ''} onClick={() => void savePayout()}>
            Change number
          </Button>
        </div>
      </FormDialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Store details and opening hours
// ---------------------------------------------------------------------------

function DetailsPanel({ extra, flash, onChanged }: { extra: SettingsExtra; flash: (m: string) => void; onChanged: () => Promise<void> }): ReactNode {
  const { store } = useShell();
  const [name, setName] = useState(extra.store.name);
  const [phone, setPhone] = useState(extra.store.publicPhone ?? '');
  const [address, setAddress] = useState(extra.store.address ?? '');
  const [zone, setZone] = useState(extra.store.timeZone);
  const [week, setWeek] = useState(() => weekFrom(extra.hours));
  const [busy, setBusy] = useState<'details' | 'hours' | 'poster' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const zones = typeof Intl !== 'undefined' && 'supportedValuesOf' in Intl ? (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone') : ['Africa/Kigali'];

  const saveDetails = async (): Promise<void> => {
    setBusy('details');
    setProblem(null);
    try {
      await settingsApi.saveDetails(store.id, { name, publicPhone: phone.trim() === '' ? null : phone, address: address.trim() === '' ? null : address, timeZone: zone });
      await onChanged();
      flash('Store details saved');
    } catch (cause) {
      setProblem(reason(cause, 'Those could not be saved.'));
    } finally {
      setBusy(null);
    }
  };

  // "A5 or A4, brand colour band": the colours are the PUBLISHED theme's, compiled the way the storefront's are, so the band is exactly
  // the colour customers see and the text on it is the one the compiler proved readable. A store that never published uses the default.
  const printPoster = async (): Promise<void> => {
    setBusy('poster');
    setProblem(null);
    try {
      const look = await lookApi.load(store.id);
      const colors = compileTheme((look.published ?? null)?.inputs ?? DEFAULT_INPUTS).colors;
      const host = window.location.host;
      printHtml(posterHtml({ store: { name: extra.store.name, address: extra.store.address, phone: extra.store.publicPhone, slug: extra.store.slug }, host, hours: extra.hours.length === 0 ? null : hoursSummary(extra.hours), brand: colors.primary, onBrand: colors.onPrimary }, qrSvg(`${window.location.protocol}//${host}/${extra.store.slug}`)));
    } catch (cause) {
      setProblem(reason(cause, 'The poster could not be prepared.'));
    } finally {
      setBusy(null);
    }
  };

  const saveHours = async (): Promise<void> => {
    setBusy('hours');
    setProblem(null);
    try {
      await settingsApi.saveHours(store.id, weekToRows(week) satisfies HoursRow[]);
      await onChanged();
      flash('Opening hours saved');
    } catch (cause) {
      setProblem(reason(cause, 'Those hours could not be saved.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card id="details" title="Store details" intro="What customers see about your store, and when you’re open.">
      {problem === null ? null : <Alert tone="danger" headline={problem} />}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField label="Store name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        <TextField label="Phone customers can call" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="078 123 4567" />
        <div className="sm:col-span-2">
          <TextField label="Address" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} placeholder="KG 7 Ave, Kacyiru" />
        </div>
        <label className="flex flex-col gap-1.5 text-body font-semibold">
          Time zone
          <input list="time-zones" value={zone} onChange={(e) => setZone(e.target.value)} className="h-11 rounded-control border border-control-line bg-surface px-3 font-normal" />
          <datalist id="time-zones">
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          <span className="text-caption font-normal text-muted">“Today” on every screen starts at midnight here.</span>
        </label>
        <div className="flex flex-col gap-1.5 text-body font-semibold">
          Your store’s address online
          <span className="flex h-11 items-center rounded-control bg-ground px-3 font-mono text-[13px] font-normal text-ink-2">/{extra.store.slug}</span>
          <span className="text-caption font-normal text-muted">This is how customers find you, so it can’t be changed here.</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button tone="brand" type="button" busy={busy === 'details'} busyLabel="Saving…" disabled={name.trim().length < 2} onClick={() => void saveDetails()}>
          Save details
        </Button>
        <Button variant="secondary" type="button" busy={busy === 'poster'} busyLabel="Preparing…" onClick={() => void printPoster()}>
          Print store QR poster
        </Button>
      </div>

      <div className="mt-2 flex flex-col gap-2 border-t border-line-subtle pt-4">
        <h3 className="m-0 text-title">Opening hours</h3>
        <span className="text-caption text-muted">{hoursSummary(weekToRows(week))}. A closing time before the opening time runs past midnight.</span>
        {week.map((d, i) => (
          <div key={d.day} className="flex items-center gap-3">
            <span className="w-24 text-body font-semibold">{DAY_NAMES[i]}</span>
            <Switch tone="brand" label={`${DAY_NAMES[i]} open`} checked={d.open} onChange={(open) => setWeek(week.map((x) => (x.day === d.day ? { ...x, open } : x)))} />
            {d.open ? (
              <span className="flex items-center gap-2">
                <input type="time" aria-label={`${DAY_NAMES[i]} opens`} value={d.opens} onChange={(e) => setWeek(week.map((x) => (x.day === d.day ? { ...x, opens: e.target.value } : x)))} className="h-10 rounded-control border border-control-line bg-surface px-2" />
                <span className="text-muted">to</span>
                <input type="time" aria-label={`${DAY_NAMES[i]} closes`} value={d.closes} onChange={(e) => setWeek(week.map((x) => (x.day === d.day ? { ...x, closes: e.target.value } : x)))} className="h-10 rounded-control border border-control-line bg-surface px-2" />
              </span>
            ) : (
              <span className="text-body text-muted">Closed</span>
            )}
          </div>
        ))}
        <div className="mt-1">
          <Button tone="brand" type="button" busy={busy === 'hours'} busyLabel="Saving…" onClick={() => void saveHours()}>
            Save hours
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

function StaffPanel({ members, flash, onChanged, initialOpen }: { members: Member[] | null; flash: (m: string) => void; onChanged: () => Promise<void>; initialOpen: boolean }): ReactNode {
  const { store, me } = useShell();
  const roles = grantableRoles(me.role);
  const [adding, setAdding] = useState(initialOpen);
  const [form, setForm] = useState({ name: '', email: '', role: (roles[0] ?? 'manager') as 'admin' | 'manager' | 'rider', phone: '', plate: '', password: '' });
  const [created, setCreated] = useState<{ name: string; email: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [doomed, setDoomed] = useState<Member | null>(null);
  const [resetting, setResetting] = useState<Member | null>(null);
  const [newPassword, setNewPassword] = useState('');

  const create = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await staffApi.create(store.id, {
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        role: form.role,
        ...(form.phone.trim() === '' ? {} : { phone: form.phone.trim() }),
        ...(form.role === 'rider' ? { plateNumber: form.plate.trim() } : {}),
      });
      setCreated({ name: form.name.trim(), email: form.email.trim(), password: form.password });
      setAdding(false);
      setForm({ ...form, name: '', email: '', phone: '', plate: '', password: '' });
      await onChanged();
    } catch (cause) {
      setProblem(reason(cause, 'That person could not be added.'));
    } finally {
      setBusy(false);
    }
  };

  const startAdding = (): void => {
    setProblem(null);
    setForm((f) => ({ ...f, password: generatePassword() }));
    setAdding(true);
  };

  const resetPassword = async (): Promise<void> => {
    if (resetting === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await staffApi.resetPassword(store.id, resetting.user_id, newPassword);
      setCreated({ name: resetting.name, email: resetting.email, password: newPassword });
      setResetting(null);
      setNewPassword('');
    } catch (cause) {
      setProblem(reason(cause, 'That password could not be set.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      id="staff"
      title="Staff"
      intro="Managers answer customers and run orders; riders see only their own deliveries. You decide who has access."
      action={
        roles.length === 0 ? null : (
          <Button tone="brand" type="button" onClick={startAdding}>
            Add staff
          </Button>
        )
      }
    >
      {created === null ? null : (
        <Alert tone="info" headline={`${created.name} can sign in now.`}>
          <span>
            Give them <strong>{created.email}</strong> and the password <code className="font-mono">{created.password}</code>. It won’t be shown again — they can change it after signing in.
          </span>
          <Button variant="text" tone="brand" type="button" onClick={() => setCreated(null)}>
            Done
          </Button>
        </Alert>
      )}

      <div className="rounded-card border border-line">
        {(members ?? []).map((m) => (
          <div key={m.user_id} className="flex flex-wrap items-center gap-3 border-b border-line-subtle px-4 py-3 last:border-b-0">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-pill bg-brand-tint text-[13px] font-bold text-brand-strong">
              {m.name
                .split(/\s+/)
                .map((p) => p.charAt(0))
                .join('')
                .slice(0, 2)
                .toUpperCase()}
            </span>
            <span className="flex min-w-0 grow flex-col">
              <span className="truncate font-semibold">
                {m.name} {m.user_id === me.id ? <span className="font-normal text-muted">(you)</span> : null}
              </span>
              <span className="truncate text-caption text-muted">
                {m.email}
                {m.role === 'rider' && m.plate_number !== null ? ` · ${m.plate_number}` : m.phone === null ? '' : ` · ${m.phone}`}
              </span>
            </span>
            <span className="rounded-pill bg-status-neutral px-2.5 py-[3px] text-[12px] font-semibold text-status-neutral-fg">{ROLE_LABEL[m.role]}</span>
            {m.role === 'owner' || m.user_id === me.id ? null : (
              <span className="flex gap-1">
                <Button variant="text" tone="brand" type="button" onClick={() => { setResetting(m); setNewPassword(generatePassword()); setProblem(null); }}>
                  Reset password
                </Button>
                <Button variant="text" type="button" onClick={() => setDoomed(m)}>
                  Remove
                </Button>
              </span>
            )}
          </div>
        ))}
        {members === null ? <div className="p-4 text-body text-muted">Loading…</div> : null}
      </div>

      <FormDialog open={adding} title="Add staff" onClose={() => setAdding(false)}>
        {problem === null ? null : <Alert tone="danger" headline={problem} />}
        <label className="flex flex-col gap-1.5 text-body font-semibold">
          Role
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'admin' | 'manager' | 'rider' })} className="h-11 rounded-control border border-control-line bg-surface px-2.5 font-normal">
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          <span className="text-caption font-normal text-muted">{ROLE_BLURB[form.role]}</span>
        </label>
        <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} />
        <TextField label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <TextField label="Phone (optional)" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        {form.role !== 'rider' ? null : <TextField label="Plate number" value={form.plate} onChange={(e) => setForm({ ...form, plate: e.target.value })} maxLength={40} />}
        <div className="flex items-end gap-2">
          <div className="grow">
            <TextField label="Password to start with" hint="At least 10 characters. They can change it after signing in." value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>
          <Button variant="secondary" type="button" onClick={() => setForm({ ...form, password: generatePassword() })}>
            Generate
          </Button>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="text" tone="brand" type="button" onClick={() => setAdding(false)}>
            Cancel
          </Button>
          <Button tone="brand" type="button" busy={busy} busyLabel="Adding…" disabled={form.name.trim() === '' || form.email.trim() === '' || form.password.length < 10 || (form.role === 'rider' && form.plate.trim() === '')} onClick={() => void create()}>
            Add {ROLE_LABEL[form.role].toLowerCase()}
          </Button>
        </div>
      </FormDialog>

      <FormDialog open={resetting !== null} title={`Reset ${resetting?.name ?? ''}’s password`} onClose={() => setResetting(null)}>
        {problem === null ? null : <Alert tone="danger" headline={problem} />}
        <p className="m-0 text-body text-ink-2">They’ll be signed out everywhere and need this new password to get back in.</p>
        <div className="flex items-end gap-2">
          <div className="grow">
            <TextField label="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </div>
          <Button variant="secondary" type="button" onClick={() => setNewPassword(generatePassword())}>
            Generate
          </Button>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="text" tone="brand" type="button" onClick={() => setResetting(null)}>
            Cancel
          </Button>
          <Button tone="brand" type="button" busy={busy} busyLabel="Setting…" disabled={newPassword.length < 10} onClick={() => void resetPassword()}>
            Set password
          </Button>
        </div>
      </FormDialog>

      <ConfirmModal
        open={doomed !== null}
        onClose={() => setDoomed(null)}
        title={`Remove ${doomed?.name ?? ''}?`}
        body="They lose access to this store on their very next request. Their past work stays in your records."
        confirmLabel="Remove access"
        onConfirm={() => {
          const m = doomed;
          setDoomed(null);
          if (m === null) return;
          void staffApi
            .remove(store.id, m.user_id)
            .then(() => onChanged())
            .then(() => flash(`${m.name} no longer has access`))
            .catch((cause: unknown) => flash(reason(cause, 'That person could not be removed.')));
        }}
      />
    </Card>
  );
}
