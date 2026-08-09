const momoConfig = require('../config/momo');
const walletService = require('./walletService');

let intervalHandle = null;
let running = false;

async function tick() {
  // Guard against overlapping runs if a previous tick is still going
  // (e.g. MoMo is slow to respond) — skip this cycle rather than stack up.
  if (running) return;
  running = true;

  try {
    await walletService.reconcilePendingCollections();
    await walletService.reconcilePendingDisbursements();

    const released = await walletService.releaseEligibleOrders();
    if (released.length > 0) {
      console.log(`[settlement] released ${released.length} order(s) from escrow`);
      const tenantIds = [...new Set(released.map(r => r.released_tenant_id))];
      for (const tenantId of tenantIds) {
        await walletService.maybeAutoPayout(tenantId);
      }
    }
  } catch (err) {
    console.error('[settlement] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function start() {
  if (intervalHandle) return; // already started
  console.log(`[settlement] scheduler starting — every ${momoConfig.schedulerIntervalMs}ms, ${momoConfig.holdMinutes}min hold window`);
  // Run once shortly after boot, then on the regular interval.
  setTimeout(tick, 5000);
  intervalHandle = setInterval(tick, momoConfig.schedulerIntervalMs);
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { start, stop, tick };