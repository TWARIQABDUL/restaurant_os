// client/src/console/Verify.tsx — milestone 26, from project/KYC.dc.html (the flow) and project/KYCOutcomes.dc.html.
//
// ONE SCREEN, SEVEN STATES, because they are one conversation with the same person: "here is how to prove who you are"
// (intro, the two photos, the face video, review, done) and "here is what we decided" (the four outcomes). The server's
// status picks which half you land in — a merchant whose check is in review opens this and sees the result screen, not the
// start of a flow they have already finished.
//
// EACH PART IS UPLOADED THE MOMENT IT IS ACCEPTED, not all at the end. The board's "Use this photo" is the commit: the server
// has it, sealed, before the person has taken the next one, so a dropped connection or a closed tab loses one step instead
// of three, and "Continue" later picks up at the first missing part.
//
// THE MERCHANT'S SIDE NEVER SHOWS A DOCUMENT BACK. Previews are the browser's own object URLs for files taken in this
// session; a reload shows labels, not images. Nothing in the API returns a stored file to the person who sent it (see
// routes/storeKyc.ts) — an identity document is retrievable by a reviewer through an audited route and by nobody else.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, Spinner } from '../shared/ui/index.ts';
import { FaceCapture } from './FaceCapture.tsx';
import { kycApi } from './kycApi.ts';
import type { DocumentType, KycStatus, Part } from './kycApi.ts';
import { DOCUMENTS, PART_LABEL, outcomeCopy, partRow, retakePartOf, sentLine } from './kycLines.ts';
import type { PhotoCheck } from './kycLines.ts';
import { preparePhoto } from './photo.ts';
import type { Prepared } from './photo.ts';
import { useShell } from './ShellProvider.tsx';

export type VerifyStep = 'intro' | 'front' | 'back' | 'face' | 'review' | 'done' | 'outcome';

type Props = {
  navigate: (to: string) => void;
  /** The render gate's seam: effects do not run in static markup. Console.tsx passes none. */
  initial?: { status: KycStatus; step?: VerifyStep; prepared?: { checks: PhotoCheck[]; good: boolean }; documentType?: DocumentType };
};

const STEP_INDEX: Record<VerifyStep, number> = { intro: 0, front: 1, back: 1, face: 2, review: 3, done: 4, outcome: 4 };
const SUPPORT_TEL = 'tel:+250780000000';

const reason = (cause: unknown, fallback: string): string => (cause instanceof ApiFailure ? cause.message : fallback);

export function Verify({ navigate, initial }: Props): ReactNode {
  const { store } = useShell();
  const [status, setStatus] = useState<KycStatus | null>(initial?.status ?? null);
  const [step, setStep] = useState<VerifyStep>(initial?.step ?? 'intro');
  const [docType, setDocType] = useState<DocumentType>(initial?.documentType ?? initial?.status.submission?.documentType ?? 'national_id');
  const [prepared, setPrepared] = useState<Pick<Prepared, 'checks' | 'good'> & { blob?: Blob; previewUrl?: string } | null>(initial?.prepared ?? null);
  const [previews, setPreviews] = useState<Partial<Record<Part, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A retake asks for ONE part; after it goes up the case is sent again without making the person walk the whole flow. */
  const [retakeOnly, setRetakeOnly] = useState<Part | null>(null);
  const seeded = useRef(initial !== undefined);

  const load = useCallback(async (): Promise<void> => {
    try {
      const s = await kycApi.status(store.id);
      setStatus(s);
      if (s.submission !== null) setDocType(s.submission.documentType);
      setStep(['inReview', 'redoRequested', 'rejected', 'approved'].includes(s.outcome) ? 'outcome' : 'intro');
      setError(null);
    } catch (cause) {
      setError(reason(cause, 'Your identity check could not be loaded.'));
    }
  }, [store.id]);

  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    void load();
  }, [load]);

  const has = (part: Part): boolean => status?.submission?.parts.find((p) => p.part === part)?.state !== undefined && status.submission.parts.find((p) => p.part === part)?.state !== 'missing';
  const twoSided = docType !== 'passport';

  /** The first part still missing: where "Start" or "Continue" should land. */
  const firstStep = (): VerifyStep => (!has('id_front') ? 'front' : twoSided && !has('id_back') ? 'back' : !has('face_video') ? 'face' : 'review');

  const finish = async (): Promise<void> => {
    setBusy(true);
    try {
      setStatus(await kycApi.submit(store.id));
      setRetakeOnly(null);
      setStep('done');
    } catch (cause) {
      setError(reason(cause, 'We couldn’t send your check. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const after = async (part: Part): Promise<void> => {
    setPrepared(null);
    if (retakeOnly === part) return finish();
    setStep(part === 'id_front' ? (twoSided ? 'back' : 'face') : part === 'id_back' ? 'face' : 'review');
  };

  const sendPart = async (part: Part, blob: Blob): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await kycApi.upload(store.id, part, blob, docType));
      return true;
    } catch (cause) {
      setError(reason(cause, 'That didn’t upload. Check your connection and try again.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const choose = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setError(null);
    setBusy(true);
    try {
      setPrepared(await preparePhoto(file));
    } catch (cause) {
      setError(reason(cause, 'That photo could not be read. Try another.'));
    } finally {
      setBusy(false);
    }
  };

  const confirmPhoto = async (part: Part): Promise<void> => {
    if (prepared?.blob === undefined) return;
    if (await sendPart(part, prepared.blob)) {
      if (prepared.previewUrl !== undefined) setPreviews((p) => ({ ...p, [part]: prepared.previewUrl }));
      await after(part);
    }
  };

  const onRecorded = async (video: Blob): Promise<void> => {
    if (await sendPart('face_video', video)) {
      setPreviews((p) => ({ ...p, face_video: URL.createObjectURL(video) }));
      await after('face_video');
    } else {
      // The recording is gone with the stream; a failed upload means recording again, and the tips say how.
      setStep('face');
    }
  };

  // The camera owns the whole screen, so it sits outside the page chrome.
  if (step === 'face' && busy) {
    return (
      <Frame step={step} onBack={() => undefined} chrome={false}>
        <div className="flex flex-col items-center gap-3 py-24" aria-busy="true">
          <Spinner />
          <span className="text-ink-2">Saving your video…</span>
        </div>
      </Frame>
    );
  }
  if (step === 'face') {
    return (
      <Frame step={step} onBack={() => setStep(retakeOnly === 'face_video' ? 'outcome' : twoSided ? 'back' : 'front')} chrome={false}>
        {error === null ? null : <Alert tone="danger" headline={error} />}
        <FaceCapture onRecorded={onRecorded} onClose={() => setStep(retakeOnly === 'face_video' ? 'outcome' : 'review')} />
      </Frame>
    );
  }

  if (status === null) {
    return (
      <Frame step="intro" onBack={() => navigate(`/app/${store.slug}`)}>
        {error === null ? (
          <div className="flex justify-center py-16" aria-busy="true">
            <Spinner />
          </div>
        ) : (
          <Alert tone="danger" headline={error}>
            <Button variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          </Alert>
        )}
      </Frame>
    );
  }

  if (step === 'outcome') {
    return <Outcome status={status} navigate={navigate} slug={store.slug} onRetake={(part) => { setRetakeOnly(part); setStep(part === 'id_front' ? 'front' : part === 'id_back' ? 'back' : 'face'); }} onAgain={() => { setRetakeOnly(null); setStep('intro'); }} />;
  }

  const back = (): void => {
    setPrepared(null);
    setError(null);
    if (retakeOnly !== null) return setStep('outcome');
    setStep(step === 'front' ? 'intro' : step === 'back' ? 'front' : step === 'review' ? 'face' : 'intro');
  };

  return (
    <Frame step={step} onBack={step === 'intro' ? () => navigate(`/app/${store.slug}`) : back} stepLabel={step === 'done' ? '' : `Step ${STEP_INDEX[step] + 1} of 4`}>
      {error === null ? null : <Alert tone="danger" headline={error} />}

      {step === 'intro' ? (
        <div className="flex flex-col gap-5">
          <div>
            <h1 className="m-0 font-display text-[28px] leading-tight">Before you get paid, we need to know it’s you</h1>
            <p className="m-0 mt-1.5 text-ink-2">Takes about 2 minutes. It protects your money and your customers.</p>
          </div>
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            <Numbered n={1} title="Photo of your ID" sub={twoSided ? 'Front and back, all corners in view' : 'The photo page, all corners in view'} />
            <Numbered n={2} title="5-second face video" sub="Starts by itself when we see your face" />
          </ol>
          <div role="radiogroup" aria-label="Which document do you have?" className="flex flex-col gap-2">
            <span className="text-body font-semibold">Which document do you have?</span>
            {DOCUMENTS.map((d) => (
              <button key={d.id} type="button" role="radio" aria-checked={docType === d.id} onClick={() => setDocType(d.id)} className={`flex items-center gap-3 rounded-card bg-surface p-3.5 text-left ${docType === d.id ? 'border-2 border-brand' : 'border border-control-line'}`}>
                <span aria-hidden="true" className={`size-5 shrink-0 rounded-pill bg-surface ${docType === d.id ? 'border-[6px] border-brand' : 'border-[1.5px] border-control-line'}`} />
                <span className="flex flex-col">
                  <span className="font-semibold">{d.label}</span>
                  <span className="text-caption text-muted">{d.sub}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="flex gap-2.5 rounded-control bg-status-neutral p-3 text-body text-ink-2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-0.5 shrink-0">
              <rect x="4" y="11" width="16" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            <span>Encrypted. Only Vendlyfy’s verification team sees it, and it’s never shown to customers.</span>
          </div>
          <Button tone="brand" block onClick={() => setStep(firstStep())}>
            {status.outcome === 'building' && status.submission !== null && status.submission.parts.some((p) => p.state !== 'missing') ? 'Continue' : 'Start'}
          </Button>
        </div>
      ) : null}

      {step === 'front' || step === 'back' ? (
        <Capture
          part={step === 'front' ? 'id_front' : 'id_back'}
          title={docType === 'passport' ? 'Photo page of your passport' : step === 'front' ? 'Front of your ID' : 'Back of your ID'}
          prepared={prepared}
          busy={busy}
          onFile={(f) => void choose(f)}
          onRetake={() => setPrepared(null)}
          onUse={(part) => void confirmPhoto(part)}
        />
      ) : null}

      {step === 'review' ? (
        <div className="flex flex-col gap-5">
          <div>
            <h1 className="m-0 font-display text-[28px] leading-tight">Check and send</h1>
            <p className="m-0 mt-1.5 text-ink-2">Make sure everything is clear. You can redo any part.</p>
          </div>
          <div className="flex flex-col rounded-card border border-line bg-surface">
            {(status.submission?.parts ?? []).map((p) => (
              <div key={p.part} className="flex items-center gap-3 border-b border-line-subtle p-3 last:border-b-0">
                {previews[p.part] !== undefined && p.part !== 'face_video' ? (
                  <img src={previews[p.part]} alt="" className="h-12 w-[72px] rounded-chip object-cover" />
                ) : (
                  <span aria-hidden="true" className={`flex h-12 w-[72px] items-center justify-center rounded-chip text-[11px] font-bold ${p.part === 'face_video' ? 'bg-ink-raised text-white' : 'bg-status-neutral text-status-neutral-fg'}`}>
                    {p.part === 'face_video' ? '▶ 0:05' : p.part === 'id_front' ? 'FRONT' : 'BACK'}
                  </span>
                )}
                <span className="flex grow flex-col">
                  <span className="font-semibold">{docType === 'passport' && p.part === 'id_front' ? 'Passport photo page' : PART_LABEL[p.part]}</span>
                  <span className="text-caption text-muted">{p.state === 'missing' ? 'Not sent yet' : p.part === 'face_video' ? '5 seconds' : 'Received'}</span>
                </span>
                <Button variant="text" tone="brand" onClick={() => setStep(p.part === 'id_front' ? 'front' : p.part === 'id_back' ? 'back' : 'face')}>
                  {p.state === 'missing' ? 'Add' : 'Redo'}
                </Button>
              </div>
            ))}
          </div>
          <Button tone="brand" block busy={busy} busyLabel="Sending…" disabled={(status.submission?.parts ?? []).some((p) => p.state === 'missing')} onClick={() => void finish()}>
            Send for verification
          </Button>
        </div>
      ) : null}

      {step === 'done' ? (
        <div className="flex flex-col gap-5">
          <span aria-hidden="true" className="flex size-[60px] items-center justify-center rounded-pill bg-status-success text-[28px] font-extrabold text-status-success-fg">
            ✓
          </span>
          <div>
            <h1 className="m-0 font-display text-[28px] leading-tight">We’ve got everything</h1>
            <p className="m-0 mt-1.5 text-ink-2">Most checks are finished within 24 hours. You can keep selling in the meantime.</p>
          </div>
          <div className="flex flex-col rounded-card border border-line bg-surface">
            {[
              ['ID photos received', 'Just now', '✓'],
              ['Face video received', 'Just now', '✓'],
              ['Review by our team', 'Within 24 h', ''],
            ].map(([label, note, mark]) => (
              <div key={label} className="flex items-center gap-3 border-b border-line-subtle p-3 last:border-b-0">
                <span aria-hidden="true" className={`flex size-[22px] items-center justify-center rounded-pill text-[12px] font-extrabold ${mark === '' ? 'border-[1.5px] border-control-line' : 'bg-status-success text-status-success-fg'}`}>
                  {mark}
                </span>
                <span className="grow">{label}</span>
                <span className="text-caption text-muted">{note}</span>
              </div>
            ))}
          </div>
          <Button tone="brand" block onClick={() => void load()}>
            See where it stands
          </Button>
        </div>
      ) : null}
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// The photo screen
// ---------------------------------------------------------------------------

function Capture({ part, title, prepared, busy, onFile, onRetake, onUse }: { part: Part; title: string; prepared: { checks: PhotoCheck[]; good: boolean; previewUrl?: string } | null; busy: boolean; onFile: (f: File | undefined) => void; onRetake: () => void; onUse: (part: Part) => void }): ReactNode {
  const camera = useRef<HTMLInputElement | null>(null);
  const gallery = useRef<HTMLInputElement | null>(null);
  const [override, setOverride] = useState(false);
  const preview = prepared?.previewUrl;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="m-0 font-display text-[26px] leading-tight">{title}</h1>
        <p className="m-0 mt-1.5 text-ink-2">Place it on a dark, flat surface. We check the photo right away.</p>
      </div>

      <div className="relative flex aspect-[1.58] items-center justify-center overflow-hidden rounded-card bg-ink-raised">
        {preview !== undefined ? (
          <img src={preview} alt="The photo you took" className="size-full object-contain" />
        ) : busy ? (
          <span className="flex items-center gap-2 text-body text-white" aria-busy="true">
            <Spinner /> Checking photo…
          </span>
        ) : (
          <span className="px-6 text-center text-body text-on-ink-muted">Fit the card inside the frame, then take the photo.</span>
        )}
      </div>

      {prepared === null ? null : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {prepared.checks.map((c) => (
            <li key={c.label} className="flex items-center gap-2.5">
              <span aria-hidden="true" className={`flex size-[22px] shrink-0 items-center justify-center rounded-pill text-[12px] font-extrabold ${c.ok ? 'bg-status-success text-status-success-fg' : 'bg-status-danger text-status-danger-fg'}`}>
                {c.ok ? '✓' : '!'}
              </span>
              <span className={c.ok ? '' : 'font-semibold text-status-danger-fg'}>{c.label}</span>
            </li>
          ))}
        </ul>
      )}

      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
      <input ref={gallery} type="file" accept="image/*" hidden onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />

      {prepared === null ? (
        <div className="flex flex-col gap-2">
          <Button tone="brand" block disabled={busy} onClick={() => camera.current?.click()}>
            Take photo
          </Button>
          <Button variant="secondary" block disabled={busy} onClick={() => gallery.current?.click()}>
            Upload from gallery
          </Button>
        </div>
      ) : prepared.good || override ? (
        <div className="flex flex-col gap-2">
          <Button tone="brand" block busy={busy} busyLabel="Uploading…" onClick={() => onUse(part)}>
            Use this photo
          </Button>
          <Button variant="secondary" block disabled={busy} onClick={onRetake}>
            Retake
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Button tone="brand" block disabled={busy} onClick={onRetake}>
            Retake photo
          </Button>
          {/* The checks are measurements of pixels, not a judgement of the card: a glossy ID in good light can trip the glare
              one. A person who has looked at their own photo and is sure is allowed to send it — the reviewer decides. */}
          <Button variant="text" block disabled={busy} onClick={() => setOverride(true)}>
            It’s fine — use it anyway
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The outcomes
// ---------------------------------------------------------------------------

const TONE: Record<string, { icon: string; box: string }> = {
  success: { icon: 'bg-status-success text-status-success-fg', box: 'bg-status-success text-status-success-fg' },
  danger: { icon: 'bg-status-danger text-status-danger-fg', box: 'bg-status-danger text-status-danger-fg' },
  warn: { icon: 'bg-status-warn text-status-warn-fg', box: 'bg-status-warn text-status-warn-fg' },
  info: { icon: 'bg-status-info text-status-info-fg', box: 'bg-status-info text-status-info-fg' },
};
const MARK: Record<string, string> = { ok: 'bg-status-success text-status-success-fg', bad: 'bg-status-danger text-status-danger-fg', wait: 'bg-status-info text-status-info-fg' };
const NOTE: Record<string, string> = { ok: 'text-status-success-fg', bad: 'text-status-danger-fg', wait: 'text-status-info-fg' };

export function Outcome({ status, navigate, slug, onRetake, onAgain }: { status: KycStatus; navigate: (to: string) => void; slug: string; onRetake: (p: Part) => void; onAgain: () => void }): ReactNode {
  const o = status.outcome;
  if (o === 'none' || o === 'building' || status.submission === null) return null;
  const retake = retakePartOf(status);
  const copy = outcomeCopy(o, status.submission.decisionNote, retake, o === 'inReview' ? sentLine(status.submission.submittedAt) : null);
  const tone = TONE[copy.tone]!;

  const act = (): void => {
    if (o === 'redoRequested' && retake !== null) return onRetake(retake);
    if (o === 'rejected') return onAgain();
    navigate(o === 'approved' ? `/app/${slug}/money` : `/app/${slug}`);
  };

  return (
    <Frame step="outcome" onBack={() => navigate(`/app/${slug}`)} title="Identity check">
      <div className="flex flex-col gap-4">
        <span aria-hidden="true" className={`flex size-[60px] items-center justify-center rounded-pill text-[28px] font-extrabold ${tone.icon}`}>
          {copy.icon}
        </span>
        <h1 className="m-0 font-display text-[28px] leading-tight">{copy.title}</h1>
        <p className="m-0 text-ink-2">{copy.body}</p>
        {copy.reason === null ? null : (
          <div className={`flex flex-col gap-1 rounded-card p-3.5 ${tone.box}`}>
            <strong className="text-[13px]">{copy.reasonLabel}</strong>
            <span>{copy.reason}</span>
          </div>
        )}
        <section className="rounded-card border border-line bg-surface px-3.5 py-1">
          {status.submission.parts.map((p) => {
            const row = partRow(p.part, p.state, o, p.purged);
            return (
              <div key={p.part} className="flex items-center gap-2.5 border-b border-line-subtle py-3 text-body last:border-b-0">
                <span aria-hidden="true" className={`flex size-[22px] shrink-0 items-center justify-center rounded-pill text-[12px] font-extrabold ${MARK[row.tone]}`}>
                  {row.mark}
                </span>
                <span className="grow">{row.label}</span>
                <span className={`text-caption font-semibold ${NOTE[row.tone]}`}>{row.note}</span>
              </div>
            );
          })}
        </section>
        <div className="rounded-control bg-status-neutral p-3 text-caption text-ink-2">{copy.meanwhile}</div>
        <div className="flex flex-col gap-2">
          <Button tone="brand" block onClick={act}>
            {copy.cta}
          </Button>
          {copy.cta2 === null ? null : (
            <a href={SUPPORT_TEL} className="flex h-11 items-center justify-center font-semibold text-ink-2 no-underline">
              {copy.cta2}
            </a>
          )}
        </div>
      </div>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

function Numbered({ n, title, sub }: { n: number; title: string; sub: string }): ReactNode {
  return (
    <li className="flex items-center gap-3">
      <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-pill bg-brand-tint text-body font-bold text-brand-strong">
        {n}
      </span>
      <span className="flex flex-col">
        <strong>{title}</strong>
        <span className="text-caption text-muted">{sub}</span>
      </span>
    </li>
  );
}

function Frame({ step, onBack, children, stepLabel, title = 'Verify your identity', chrome = true }: { step: VerifyStep; onBack: () => void; children: ReactNode; stepLabel?: string; title?: string; chrome?: boolean }): ReactNode {
  const index = STEP_INDEX[step];
  return (
    <div className="mx-auto flex min-h-dvh max-w-[440px] flex-col bg-ground text-ink">
      {chrome ? (
        <>
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
            <button type="button" aria-label="Back" onClick={onBack} className="flex size-11 items-center justify-center text-ink">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <span className="grow font-bold">{title}</span>
            <span className="text-caption text-muted">{stepLabel ?? ''}</span>
          </header>
          {step === 'outcome' ? null : (
            <div className="flex gap-1 px-4 pt-3" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={`h-1 grow rounded-pill ${i <= index && step !== 'intro' ? 'bg-brand' : i === 0 && step === 'intro' ? 'bg-brand' : 'bg-line'}`} />
              ))}
            </div>
          )}
        </>
      ) : null}
      <div className="flex grow flex-col gap-4 px-5 py-6">{children}</div>
    </div>
  );
}
