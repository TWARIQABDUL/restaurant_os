// client/src/console/settingsLines.ts — milestone 25, from project/Settings.dc.html.
//
// THE WORDS OF SETTINGS, with no React in them — the gate calls these directly (the reason lines.ts, walletLines.ts and
// supportLines.ts give), so a rule that lives in JSX is only tested by whatever markup happens to be scraped.

import type { HoursRow, Member, MethodInfo, Zone } from './settingsApi.ts';
import { methodName } from './walletLines.ts';

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

/** The board's six, in its order, then the two only some businesses have. */
export const MODULE_ORDER = ['modifiers', 'delivery', 'pickup', 'table', 'scheduled', 'stock', 'appointments', 'rx'] as const;

/**
 * Wording for each module. The board's is food-flavoured ("Menu options and extras") because it is drawn for a food
 * store; a fashion store reading "Menu options" would be wrong, so these say the same thing without the industry in them.
 * The registry's own labels are internal ("Priced extras (modifiers)") and are not what a merchant should read.
 */
export const MODULE_COPY: Record<string, { label: string; desc: string }> = {
  modifiers: { label: 'Options and extras', desc: 'Let customers pick options like size or spice level, and paid extras.' },
  delivery: { label: 'Delivery', desc: 'Take delivery orders with zones and fees.' },
  pickup: { label: 'Pickup', desc: 'Customers order ahead and collect at your counter.' },
  table: { label: 'Table ordering', desc: 'Print a QR code per table. Orders arrive with the table number.' },
  scheduled: { label: 'Schedule orders ahead', desc: 'Accept orders for later today when you are closed or busy.' },
  stock: { label: 'Track stock', desc: 'Hide items automatically when they sell out.' },
  appointments: { label: 'Appointments', desc: 'Book a time with a staff member instead of dispatching.' },
  rx: { label: 'Prescription flag', desc: 'Mark products that need a prescription, and add the checkout step that goes with it.' },
};

/** Which modules to list: the board's six always, the two specialist ones only where they are already on. */
export function visibleModules(modules: Record<string, { enabled: boolean }>): string[] {
  return MODULE_ORDER.filter((key) => key in modules && (['appointments', 'rx'].includes(key) ? modules[key]!.enabled : true));
}

// ---------------------------------------------------------------------------
// Delivery and pickup
// ---------------------------------------------------------------------------

/** "Kigali city centre · Kacyiru, Kimihurura, Kiyovu" — the board's row, with the areas as many as there are. */
export function zoneAreasLine(z: Pick<Zone, 'areas'>): string {
  if (z.areas.length === 0) return 'No areas yet';
  return z.areas.length <= 4 ? z.areas.join(', ') : `${z.areas.slice(0, 3).join(', ')} and ${z.areas.length - 3} more`;
}

/** "1,000 RWF · 25–35 min", with the fee formatted by the caller and "Free" for nothing. */
export function zoneFeeLine(z: Pick<Zone, 'feeAmount' | 'etaMinMinutes' | 'etaMaxMinutes'>, money: (v: string) => string): string {
  const fee = Number(z.feeAmount) === 0 ? 'Free' : money(z.feeAmount);
  return `${fee} · ${z.etaMinMinutes}–${z.etaMaxMinutes} min`;
}

export const pickupLine = (p: { readyMinutes: number }): string => `Free · ready in ${p.readyMinutes} min`;

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

const PAYMENT_COPY: Record<string, { mark: string; desc: string; tone: string }> = {
  mtn_momo: { mark: 'MTN', desc: 'Customers approve on their phone.', tone: 'bg-status-warn text-status-warn-fg' },
  airtel_money: { mark: 'AIRTEL', desc: 'Customers approve on their phone.', tone: 'bg-status-danger text-status-danger-fg' },
  mpesa: { mark: 'M-PESA', desc: 'Customers approve on their phone.', tone: 'bg-status-success text-status-success-fg' },
  cash: { mark: 'CASH', desc: 'Riders collect cash. Marked unpaid until delivered.', tone: 'bg-brand-tint text-brand-strong' },
};

export function paymentCopy(key: string): { mark: string; desc: string; tone: string } {
  return PAYMENT_COPY[key] ?? { mark: key.slice(0, 5).toUpperCase(), desc: '', tone: 'bg-status-neutral text-status-neutral-fg' };
}

export type PaymentState = 'connected' | 'connectable' | 'unavailable';

/** A live method is Connected or ready to connect; a draft or paused one is not the merchant's to switch on. */
export function paymentState(m: Pick<MethodInfo, 'status'>, connected: boolean): PaymentState {
  if (connected) return 'connected';
  return m.status === 'live' ? 'connectable' : 'unavailable';
}

/** The board's last line under Payments: "Payouts go to MTN MoMo 078 ••• 4412 every morning at 08:00." */
export function payoutSentence(p: { methodKey: string; phone: string; settlementMode: 'manual' | 'automatic'; automaticAt: string | null } | null): string {
  if (p === null) return 'Add the MoMo number your payouts go to.';
  const where = `${methodName(p.methodKey)} ${maskPhone(p.phone)}`;
  return p.settlementMode === 'automatic' ? `Payouts go to ${where} every morning at ${p.automaticAt ?? '08:00'}.` : `Payouts go to ${where} when you withdraw.`;
}

/** "078 ••• 4412". Mirrors the server's maskPhone(). */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const local = digits.startsWith('250') && digits.length === 12 ? `0${digits.slice(3)}` : digits;
  return local.length < 7 ? '•••' : `${local.slice(0, 3)} ••• ${local.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Store details
// ---------------------------------------------------------------------------

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/** The editor's seven rows from what is stored: a day with no row is closed. */
export function weekFrom(rows: readonly HoursRow[]): { day: number; open: boolean; opens: string; closes: string }[] {
  return DAY_NAMES.map((_, i) => {
    const found = rows.find((r) => r.day === i + 1);
    return { day: i + 1, open: found !== undefined, opens: found?.opens ?? '09:00', closes: found?.closes ?? '18:00' };
  });
}

/** What goes to the server: only the open days. */
export const weekToRows = (week: { day: number; open: boolean; opens: string; closes: string }[]): HoursRow[] =>
  week.filter((d) => d.open).map((d) => ({ day: d.day, opens: d.opens, closes: d.closes }));

/** "Mon–Fri 09:00–18:00" style summary, collapsing runs of days with the same hours. */
export function hoursSummary(rows: readonly HoursRow[]): string {
  if (rows.length === 0) return 'Closed every day';
  const short = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const parts: string[] = [];
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1]!.day === rows[j]!.day + 1 && rows[j + 1]!.opens === rows[i]!.opens && rows[j + 1]!.closes === rows[i]!.closes) j += 1;
    const first = short[rows[i]!.day - 1]!;
    const last = short[rows[j]!.day - 1]!;
    parts.push(`${i === j ? first : `${first}–${last}`} ${rows[i]!.opens}–${rows[i]!.closes}`);
    i = j + 1;
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

export const ROLE_LABEL: Record<Member['role'], string> = { owner: 'Owner', admin: 'Admin', manager: 'Manager', rider: 'Rider' };

/**
 * The roles the signed-in person may create, from §5.4: an OWNER can add admins, managers and riders; an ADMIN adds managers
 * and riders; nobody creates an owner here (ownership is a transfer, not a sign-up). The server enforces the same — this is
 * what the form OFFERS, so a merchant is never shown a role the API will refuse.
 */
export function grantableRoles(myRole: 'owner' | 'admin' | 'manager' | 'rider' | null): ('admin' | 'manager' | 'rider')[] {
  if (myRole === 'owner') return ['manager', 'rider', 'admin'];
  if (myRole === 'admin') return ['manager', 'rider'];
  return [];
}

export const ROLE_BLURB: Record<'admin' | 'manager' | 'rider', string> = {
  admin: 'Everything you can do, including money and settings.',
  manager: 'Accept and update orders, assign riders, edit products and stock, answer customers. Can’t see payouts, the wallet or store settings.',
  rider: 'Sees only their own deliveries, in the rider app.',
};

/** A sign-in password to hand over once: 12 characters, letters and digits, never ambiguous ones, always with a digit. */
export function generatePassword(random: (n: number) => number = (n) => Math.floor(Math.random() * n)): string {
  const letters = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const pick = (set: string): string => set.charAt(random(set.length));
  const chars = Array.from({ length: 10 }, () => pick(letters)).concat([pick(digits), pick(digits)]);
  // A fixed shuffle step so the digits are not always last.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
