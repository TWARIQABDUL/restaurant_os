// client/src/console/chime.ts — milestone 19, for the new-order alert.
//
// "Chime repeats every 20 seconds until someone accepts or opens it." — project/Notifications.dc.html.
//
// SYNTHESISED, NOT A FILE. Two sine notes through WebAudio, which is about 30 lines and no asset: no request
// that can fail on a slow connection at the exact moment an order arrives, no format to serve twice, nothing to
// cache. It is a doorbell, not music.
//
// IT MAY SIMPLY NOT PLAY, AND THAT IS HANDLED RATHER THAN REPORTED. Browsers refuse audio until the page has
// had a real user gesture, so the first chime on a freshly reloaded tab can be silently dropped — which is
// correct behaviour by the browser and survivable here, because the board already says what happens when there
// is no sound: "The alert still shows on screen." So every call is best-effort and nothing throws.
//
// THE REPEAT IS NOT HERE. A timer belongs with the component that knows whether the alert is still up; this
// module knows only how to make one noise.

let context: AudioContext | null = null;

type AudioContextConstructor = new () => AudioContext;

function audioContextClass(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** One context for the tab's lifetime. Browsers cap how many a page may hold, and each one costs a thread. */
function ensureContext(): AudioContext | null {
  if (context !== null) return context;
  const Ctor = audioContextClass();
  if (Ctor === null) return null;
  try {
    context = new Ctor();
  } catch {
    return null;
  }
  return context;
}

/** True once the browser will actually let us make a noise — the switch in the panel reflects intent, not this. */
export function soundIsAvailable(): boolean {
  return audioContextClass() !== null;
}

/**
 * Two notes, a fifth apart, 140 ms each. Rings clearly through a kitchen without being an alarm.
 *
 * The gain envelope is not decoration: a sine that starts and stops at full amplitude clicks, and a click at
 * volume through a phone speaker is the part people flinch at.
 */
export function playChime(): void {
  const ctx = ensureContext();
  if (ctx === null) return;

  try {
    // Suspended is the normal state before the first gesture; resume() rejects rather than throws, so the catch
    // on the promise is the one that matters.
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);

    const start = ctx.currentTime;
    for (const [index, frequency] of [880, 1320].entries()) {
      const at = start + index * 0.16;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.18, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.15);
    }
  } catch {
    // An exhausted or closed context. Silence is the documented fallback.
  }
}

/**
 * Lets the next chime through by waking the context on the first real interaction.
 *
 * Called once when the console mounts. It is not a chime and makes no sound — it only spends the gesture the
 * browser is waiting for, so that a chime twenty seconds later is not dropped.
 */
export function unlockSoundOnFirstGesture(): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const wake = (): void => {
    const ctx = ensureContext();
    if (ctx !== null && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    detach();
  };

  const detach = (): void => {
    window.removeEventListener('pointerdown', wake);
    window.removeEventListener('keydown', wake);
  };

  window.addEventListener('pointerdown', wake, { once: true });
  window.addEventListener('keydown', wake, { once: true });
  return detach;
}
