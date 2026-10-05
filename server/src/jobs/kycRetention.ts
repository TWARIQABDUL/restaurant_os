// server/src/jobs/kycRetention.ts — milestone 26.
//
// "The face video is deleted once it has been used." V028 makes the video due the moment a case is decided or the video
// is replaced; this is the loop that deletes the object. Hourly is plenty: nothing about a deletion is urgent to the
// second, and a case decided at 14:10 having its footage gone by 15:00 is the promise the screen makes in spirit.
//
// IDEMPOTENT AND SAFE TO RUN ANYWHERE: it only ever deletes what the database says is due, so a second process doing the
// same sweep finds nothing, and a sweep that fails halfway is finished by the next one.

import { purgeDue } from '../repositories/kyc.ts';

let timer: NodeJS.Timeout | null = null;

export async function sweep(): Promise<number> {
  return purgeDue();
}

export function startKycRetentionLoop(everyMs = Number(process.env['KYC_RETENTION_INTERVAL_MS']) || 3_600_000): void {
  if (timer !== null || process.env['KYC_RETENTION_SCHEDULER'] === 'off') return;
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    sweep()
      .then((n) => {
        if (n > 0) console.log(`[kyc] deleted ${n} face video${n === 1 ? '' : 's'} past retention`);
      })
      .catch((cause: unknown) => console.error('[kyc] retention sweep failed:', cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        running = false;
      });
  };
  timer = setInterval(tick, everyMs);
  timer.unref();
  // Once at start, so a server that was down over the due time catches up without waiting an hour.
  tick();
}

export function stopKycRetentionLoop(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}
