// client/src/console/kycLines.ts — milestone 26, from project/KYC.dc.html and project/KYCOutcomes.dc.html.
//
// THE WORDS AND THE RULES of the identity check, with no React in them, so the render gate calls them directly (the reason
// lines.ts, walletLines.ts and settingsLines.ts give).
//
// TWO PLACES THE BOARD AND THE TRUTH DISAGREE, and the screen says the true thing:
//
//   * "[RETENTION PERIOD]" is the design admitting a question was open. It is answered now: the face video is deleted once
//     it has been used, and the ID photos are kept, encrypted. The sentence says exactly that — a merchant being photographed
//     should be told what happens to the photograph.
//   * "We'll text 078 …" — nothing sends SMS yet (milestone 28), so promising a text would be promising something the
//     system cannot do. The screen says where the news will be.

import type { KycStatus, Part, PartState } from './kycApi.ts';

export const PART_LABEL: Record<Part, string> = { id_front: 'ID front', id_back: 'ID back', face_video: 'Face video' };

export const RETENTION_LINE =
  'Your face video is deleted as soon as we’ve checked it. Your ID photos are kept, encrypted, so we can answer a bank or a regulator if one ever asks.';

export type PartRow = { label: string; tone: 'ok' | 'bad' | 'wait'; mark: string; note: string };

export function partRow(part: Part, state: PartState, outcome: KycStatus['outcome'], purged: boolean): PartRow {
  const label = PART_LABEL[part];
  if (state === 'retake') return { label, tone: 'bad', mark: '!', note: 'Retake' };
  if (state === 'accepted') return { label, tone: 'ok', mark: '✓', note: purged ? 'Accepted · deleted' : 'Accepted' };
  if (state === 'missing') return { label, tone: 'wait', mark: '…', note: 'Not sent' };
  // `received` on a decided case means the reviewer saw it and did not single it out; on one being checked it is waiting.
  if (outcome === 'rejected') return { label, tone: 'wait', mark: '•', note: purged ? 'Reviewed · deleted' : 'Reviewed' };
  return { label, tone: 'ok', mark: '✓', note: 'Received' };
}

export type OutcomeCopy = {
  icon: string;
  tone: 'success' | 'danger' | 'warn' | 'info';
  title: string;
  body: string;
  reasonLabel: string | null;
  reason: string | null;
  meanwhile: string;
  cta: string;
  cta2: string | null;
};

const SUPPORT_CTA = 'Call Vendlyfy support';

/** The board's four, in its own words, with the two corrections above. `retakePart` names what the redo is for. */
export function outcomeCopy(outcome: Exclude<KycStatus['outcome'], 'none' | 'building'>, note: string | null, retakePart: Part | null, sentAt: string | null): OutcomeCopy {
  switch (outcome) {
    case 'redoRequested':
      return {
        icon: '!',
        tone: 'warn',
        title: 'One photo needs redoing',
        body: 'Everything else is fine. Retake just this part and we’ll finish the check, usually within 24 hours.',
        reasonLabel: 'What our team said',
        reason: note,
        meanwhile: 'You can keep selling. Payouts stay on hold until the check is finished; your balance keeps adding up.',
        cta: retakePart === null ? 'Retake' : retakeLabel(retakePart),
        cta2: null,
      };
    case 'rejected':
      return {
        icon: '✕',
        tone: 'danger',
        title: 'We couldn’t verify you',
        body: 'Your identity check was not approved. You can try again with a different document, or talk to us.',
        reasonLabel: 'Reason',
        reason: note,
        meanwhile: 'Your store stays open and you can take cash and MoMo orders. Money you’ve earned is safe in your balance but can’t be withdrawn until you’re verified.',
        cta: 'Start again',
        cta2: SUPPORT_CTA,
      };
    case 'inReview':
      return {
        icon: '…',
        tone: 'info',
        title: 'We’re checking your ID',
        body: `${sentAt === null ? 'Sent.' : `Sent ${sentAt}.`} Most checks are done within 24 hours. We’ll show the result here and in your notifications.`,
        reasonLabel: null,
        reason: null,
        meanwhile: 'Payouts start the morning after you’re verified. Nothing to do for now.',
        cta: 'Back to my store',
        cta2: null,
      };
    case 'approved':
      return {
        icon: '✓',
        tone: 'success',
        title: 'You’re verified',
        body: 'Payouts are unlocked. Withdraw from Money, or let automatic payouts run if you’ve switched them on.',
        reasonLabel: null,
        reason: null,
        meanwhile: RETENTION_LINE,
        cta: 'See my money',
        cta2: null,
      };
  }
}

export const retakeLabel = (p: Part): string => (p === 'id_front' ? 'Retake the front of my ID' : p === 'id_back' ? 'Retake the back of my ID' : 'Record my face video again');

/** The one part a retake asks for — the server accepts every other part, so exactly one is `retake`. */
export const retakePartOf = (s: KycStatus): Part | null => s.submission?.parts.find((p) => p.state === 'retake')?.part ?? null;

/** "today at 14:10", "yesterday", or the date — the board's "Sent today at 14:10". */
export function sentLine(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const same = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (same(d, now)) return `today at ${clock}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  return same(d, yesterday) ? `yesterday at ${clock}` : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ---------------------------------------------------------------------------
// The photo checks — the board's "We check the photo right away"
// ---------------------------------------------------------------------------
//
// ONLY WHAT CAN BE MEASURED IS CLAIMED. The board's three ticks are "all four corners visible", "no glare or shadow" and
// "text is sharp and readable". The second and third are pixels; the first would need a card detector, and a tick that
// says "corners visible" without looking is a lie told to somebody about to hand over their ID. So two are computed, and
// the verdict on the rest is a person's.

export type Pixels = { data: ArrayLike<number>; width: number; height: number };

const luma = (d: ArrayLike<number>, i: number): number => 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);

/** Variance of the Laplacian over the grey image: low means soft. Works on the downscaled frame the screen passes in. */
export function sharpness(px: Pixels): number {
  const { data, width: w, height: h } = px;
  if (w < 3 || h < 3) return 0;
  const grey = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) grey[i] = luma(data, i * 4);
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const c = y * w + x;
      const lap = 4 * grey[c]! - grey[c - 1]! - grey[c + 1]! - grey[c - w]! - grey[c + w]!;
      sum += lap;
      sumSq += lap * lap;
      n += 1;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** The share of the frame that is blown out to white — a reflection off a laminated card. */
export function glareShare(px: Pixels): number {
  const { data, width: w, height: h } = px;
  let hot = 0;
  for (let i = 0; i < w * h; i += 1) if (luma(data, i * 4) >= 250) hot += 1;
  return hot / (w * h);
}

export const BLUR_BELOW = 40;
export const GLARE_ABOVE = 0.06;

export type PhotoCheck = { label: string; ok: boolean };

export function photoChecks(px: Pixels): { checks: PhotoCheck[]; good: boolean } {
  const glare = glareShare(px) > GLARE_ABOVE;
  const blurry = sharpness(px) < BLUR_BELOW;
  const checks: PhotoCheck[] = [
    { label: glare ? 'Glare is covering your details. Tilt the card away from the light.' : 'No glare or shadow', ok: !glare },
    { label: blurry ? 'The text is blurry. Hold the phone steady and let it focus.' : 'Text is sharp and readable', ok: !blurry },
  ];
  return { checks, good: !glare && !blurry };
}

// ---------------------------------------------------------------------------
// The face video
// ---------------------------------------------------------------------------

/** The board's prompts, by the second they start at. */
export const PROMPTS: readonly { at: number; title: string; sub: string }[] = [
  { at: 0, title: 'Look straight at the camera', sub: 'Keep your face inside the oval' },
  { at: 1.2, title: 'Slowly turn your head left', sub: 'Just a little' },
  { at: 2.5, title: 'Now slowly to the right', sub: 'Keep your face in the oval' },
  { at: 3.8, title: 'Blink twice', sub: 'Almost done' },
];

export const VIDEO_SECONDS = 5;

export function promptAt(seconds: number): { title: string; sub: string } {
  let current = PROMPTS[0]!;
  for (const p of PROMPTS) if (seconds >= p.at) current = p;
  return current;
}

/** The recorder's own choice of container: WebM where it can, MP4 on Safari. The server reads either. */
export function pickVideoType(supported: (t: string) => boolean): string | null {
  for (const t of ['video/webm;codecs=vp8', 'video/webm', 'video/mp4']) if (supported(t)) return t;
  return null;
}

export const TIPS: readonly { title: string; body: string }[] = [
  { title: 'Good light', body: 'Face a window or lamp' },
  { title: 'No hat or glasses', body: 'Your whole face visible' },
  { title: 'Just you', body: 'No one else in view' },
  { title: 'Hold steady', body: 'Phone at eye level' },
];

export const DOCUMENTS: readonly { id: 'national_id' | 'passport'; label: string; sub: string }[] = [
  { id: 'national_id', label: 'National ID', sub: 'Front and back' },
  { id: 'passport', label: 'Passport', sub: 'Photo page only' },
];
