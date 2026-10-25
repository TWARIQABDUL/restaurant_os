// server/src/payments/disbursements.ts — the provider-selection shim for payouts, decided 2026-10-25.
//
// Disbursements (merchant payouts) stay on MTN MoMo for now. Urubuto Pay supports disbursements, but that
// integration is not built — payments/urubuto.ts and collections.ts only cover checkout, which is as far
// as the reference integration this was ported from ever got too (it has callback TYPES for
// BULK_DISBURSEMENT_* events but no outbound "pay someone" call).
//
// THIS SHIM EXISTS SO TURNING IT ON LATER IS DISBURSEMENT_PROVIDER=urubuto IN THE ENVIRONMENT, NOT A
// DEPLOY — the same "vendor decision is one line" rule as messaging/transport.ts and the storage drivers
// (MEDIA_STORE/PRIVATE_STORE). repositories/payouts.ts calls only the functions below and never
// payments/momo.ts directly, so the day Urubuto Pay disbursements are built, the branch below gets real
// code in ONE place and the config flip is the only thing left to do to go live.

import * as momo from './momo.ts';
import type { MomoStatus } from './momo.ts';

export { DisbursementRefused } from './momo.ts';

export function disbursementProvider(): 'momo' | 'urubuto' {
  return (process.env['DISBURSEMENT_PROVIDER'] ?? 'momo').trim().toLowerCase() === 'urubuto' ? 'urubuto' : 'momo';
}

function notBuilt(): never {
  throw new Error(
    'DISBURSEMENT_PROVIDER=urubuto, but Urubuto Pay disbursements are not built yet (TODO, decided 2026-10-25). ' +
      'Set DISBURSEMENT_PROVIDER=momo, or unset it, until that work ships.',
  );
}

export function isDisbursementConfigured(): boolean {
  return disbursementProvider() === 'urubuto' ? false : momo.isDisbursementConfigured();
}

/** Provider-agnostic — just randomUUID(). Kept here so payouts.ts never imports payments/momo.ts. */
export function newReferenceId(): string {
  return momo.newReferenceId();
}

export async function transfer(
  input: { amount: string; phone: string; referenceId: string; payerMessage?: string; payeeNote?: string },
): Promise<void> {
  if (disbursementProvider() === 'urubuto') notBuilt();
  return momo.transfer(input);
}

export async function transferStatus(referenceId: string): Promise<{ status: MomoStatus | 'UNKNOWN'; reason: string | null }> {
  if (disbursementProvider() === 'urubuto') notBuilt();
  return momo.transferStatus(referenceId);
}
