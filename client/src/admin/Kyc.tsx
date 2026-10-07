// client/src/admin/Kyc.tsx — milestone 27, from project/AdminKYC.dc.html.
//
// THE BOARD'S REVIEWER IS HANDED A FINISHED REPORT — six automatic checks, every one ticked by a vendor — and presses
// Approve. Here there is no vendor, so the screen is honest about who is doing what:
//   * TWO CHECKS ARE COMPUTED (the number is not on another store's case; the name on the ID is the name on the account) and
//     say so. They need the number and the name typed in, because nothing reads them off the photo.
//   * FOUR ARE THE REVIEWER'S OWN CALL — genuine document, face in view, live person, face matches — three buttons each,
//     unticked until a person ticks them, and recorded as the reviewer's.
//
// PHOTOS LOAD ON A BUTTON, NOT ON SELECTION. Every load of an identity document writes an audit entry, so a queue that
// opened each case's photos as you clicked down it would log twenty views nobody meant. One deliberate "Show photos" is one
// entry per image, and the screen says so beside the button.
//
// THE FULL ID NUMBER IS ASKED FOR WITH A REASON, shown once, and gone when the case changes or the reviewer hides it. It is
// never part of a case's own response (test/api/admin.test.ts).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, TextField, Toast } from '../shared/ui/index.ts';
import { adminApi } from './adminApi.ts';
import type { CaseDetail, Part, QueueItem } from './adminApi.ts';
import { CHECK_ICON, FLAG_TONE, KYC_RETENTION_LINE, ageText, overSla } from './adminLines.ts';
import { useAdmin } from './Admin.tsx';

const reason = (cause: unknown, fallback: string): string => (cause instanceof ApiFailure ? cause.message : fallback);

type Props = { initialQueue?: QueueItem[]; initialCase?: CaseDetail; initialShown?: boolean; initialRevealed?: string };

export function Kyc({ initialQueue, initialCase, initialShown, initialRevealed }: Props): ReactNode {
  const { navigate, refreshBadges } = useAdmin();
  const [queue, setQueue] = useState<QueueItem[] | null>(initialQueue ?? null);
  const [selected, setSelected] = useState<string | null>(initialCase?.id ?? null);
  const [detail, setDetail] = useState<CaseDetail | null>(initialCase ?? null);
  const [shown, setShown] = useState(initialShown ?? false);
  const [revealed, setRevealed] = useState<string | null>(initialRevealed ?? null);
  const [askReveal, setAskReveal] = useState(false);
  const [revealWhy, setRevealWhy] = useState('');
  const [form, setForm] = useState({ fullName: initialCase?.fields.fullName ?? '', dateOfBirth: initialCase?.fields.dateOfBirth ?? '', expiresOn: initialCase?.fields.expiresOn ?? '', idNumber: '' });
  const [redo, setRedo] = useState<'' | 'front' | 'back' | 'video'>('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const seeded = useRef(initialQueue !== undefined);

  const flash = (m: string): void => {
    setToast(m);
    window.setTimeout(() => setToast((c) => (c === m ? null : c)), 3000);
  };

  const loadQueue = useCallback(async (): Promise<void> => {
    try {
      const r = await adminApi.queue();
      setQueue(r.queue);
      const wanted = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('case');
      setSelected((cur) => cur ?? (wanted !== null && r.queue.some((x) => x.id === wanted) ? wanted : (r.queue[0]?.id ?? null)));
      setError(null);
    } catch (cause) {
      setError(reason(cause, 'The queue could not be loaded.'));
    }
  }, []);

  useEffect(() => {
    if (seeded.current) return;
    void loadQueue();
  }, [loadQueue]);

  const adopt = (c: CaseDetail): void => {
    setDetail(c);
    setForm((f) => ({ fullName: c.fields.fullName ?? '', dateOfBirth: c.fields.dateOfBirth ?? '', expiresOn: c.fields.expiresOn ?? '', idNumber: f.idNumber }));
  };

  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    setShown(false);
    setRevealed(null);
    setAskReveal(false);
    setRedo('');
    setMessage('');
    setError(null);
    if (selected === null) return setDetail(null);
    let live = true;
    void adminApi.case(selected).then((c) => {
      if (!live) return;
      adopt(c);
      setForm((f) => ({ ...f, idNumber: '' }));
    }).catch((cause: unknown) => live && setError(reason(cause, 'That check could not be loaded.')));
    return () => {
      live = false;
    };
  }, [selected]);

  const run = async (what: string, fn: () => Promise<CaseDetail>, done?: string): Promise<void> => {
    setBusy(what);
    setError(null);
    try {
      adopt(await fn());
      if (done !== undefined) flash(done);
    } catch (cause) {
      setError(reason(cause, 'That did not go through.'));
    } finally {
      setBusy(null);
    }
  };

  const decide = async (outcome: 'approve' | 'reject' | 'redo'): Promise<void> => {
    if (detail === null) return;
    const label = detail.owner;
    setBusy(outcome);
    setError(null);
    try {
      await adminApi.decide(detail.id, outcome, message.trim(), outcome === 'redo' && redo !== '' ? redo : undefined);
      flash(outcome === 'approve' ? `${label} verified · payouts unlocked for ${detail.storeName}` : outcome === 'reject' ? `${label} rejected · they can apply again` : `Asked ${label.split(' ')[0]} to redo one part`);
      setSelected(null);
      setDetail(null);
      setMessage('');
      refreshBadges();
      const next = await adminApi.queue();
      setQueue(next.queue);
      setSelected(next.queue[0]?.id ?? null);
    } catch (cause) {
      setError(reason(cause, 'That decision did not go through.'));
    } finally {
      setBusy(null);
    }
  };

  const doReveal = async (): Promise<void> => {
    if (detail === null) return;
    setBusy('reveal');
    try {
      setRevealed((await adminApi.reveal(detail.id, revealWhy.trim())).idNumber);
      setAskReveal(false);
      setRevealWhy('');
    } catch (cause) {
      setError(reason(cause, 'The number could not be revealed.'));
    } finally {
      setBusy(null);
    }
  };

  const decided = detail !== null && detail.status !== 'in_review';
  const docs = detail === null ? [] : detail.documents;
  const photo = (part: Part): ReactNode => {
    const d = docs.find((x) => x.part === part);
    if (d === undefined) return <span className="text-muted">Not sent</span>;
    if (d.purged) return <span className="text-muted">Deleted</span>;
    if (!shown) return <span className="text-muted">Hidden</span>;
    return part === 'face_video' ? (
      <video src={adminApi.documentUrl(detail!.id, part)} controls preload="none" playsInline className="size-full object-contain" />
    ) : (
      <img src={adminApi.documentUrl(detail!.id, part)} alt={part === 'id_front' ? 'ID front' : 'ID back'} className="size-full object-contain" />
    );
  };
  const slots: { part: Part; label: string }[] = detail === null ? [] : [{ part: 'id_front', label: detail.documentType === 'passport' ? 'Passport photo page' : 'ID front' }, ...(detail.documentType === 'passport' ? [] : [{ part: 'id_back' as const, label: 'ID back' }]), { part: 'face_video', label: 'Face video · 5 s' }];

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:gap-7">
      <nav aria-label="Verification queue" className="flex shrink-0 flex-col gap-1.5 lg:w-[300px]">
        <h1 className="m-0 font-display text-[26px]">Identity checks</h1>
        <p className="m-0 mb-2 text-body text-muted">ID photos and face videos waiting for a decision.</p>
        {queue === null ? <p className="m-0 text-muted">Loading…</p> : null}
        {queue?.map((x) => (
          <button key={x.id} type="button" aria-pressed={x.id === selected} onClick={() => setSelected(x.id)} className={`flex flex-col gap-1 rounded-card p-3 text-left ${x.id === selected ? 'border border-line bg-surface [box-shadow:0_0_0_1px_var(--color-line)]' : 'border border-transparent bg-transparent'}`}>
            <span className="flex items-baseline justify-between gap-2">
              <span className="font-semibold">{x.owner}</span>
              <span className={`text-caption font-semibold ${overSla(x.ageHours) ? 'text-status-danger-fg' : 'text-muted'}`}>{ageText(x.ageHours)}</span>
            </span>
            <span className="text-caption text-muted">
              {x.store} · {x.documentType === 'passport' ? 'Passport' : 'National ID'}
            </span>
            <span className={`self-start rounded-pill px-2 py-[2px] text-[12px] font-bold ${FLAG_TONE[x.flag.tone]}`}>{x.flag.label}</span>
          </button>
        ))}
        {queue !== null && queue.length === 0 ? <div className="rounded-card border border-line bg-surface p-6 text-center text-muted">All caught up.</div> : null}
      </nav>

      <div className="min-w-0 grow">
        {error === null ? null : <Alert tone="danger" headline={error} />}
        {detail === null ? (
          queue !== null && queue.length > 0 ? <p className="py-16 text-center text-muted">Select a case.</p> : null
        ) : (
          <div className="flex flex-col gap-4">
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="m-0 text-[22px]">{detail.owner}</h2>
                  <span className={`rounded-pill px-2 py-[3px] text-[12px] font-bold ${decided ? 'bg-status-neutral text-status-neutral-fg' : 'bg-status-info text-status-info-fg'}`}>{decided ? 'Decided' : 'Waiting for review'}</span>
                </div>
                <span className="text-caption text-muted">
                  {detail.storeName} · {detail.documentType === 'passport' ? 'Passport' : 'National ID'} · case KYC-{detail.reference} · sent {new Date(detail.submittedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <Button variant="secondary" onClick={() => navigate('/admin/merchants')}>
                Open store
              </Button>
            </header>

            <section className="rounded-card border border-line bg-surface p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="m-0 text-body">Documents</h3>
                {shown ? (
                  <Button variant="text" onClick={() => setShown(false)}>
                    Hide
                  </Button>
                ) : (
                  <span className="flex items-center gap-2.5">
                    <span className="text-caption text-muted">Viewing is recorded in the audit log.</span>
                    <Button tone="brand" disabled={docs.every((d) => d.purged)} onClick={() => setShown(true)}>
                      Show photos
                    </Button>
                  </span>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {slots.map((s) => (
                  <figure key={s.part} className="m-0 flex flex-col gap-1.5">
                    <div className="flex aspect-[1.58] items-center justify-center overflow-hidden rounded-control bg-ink-raised text-body">{photo(s.part)}</div>
                    <figcaption className="text-caption font-semibold">{s.label}</figcaption>
                  </figure>
                ))}
              </div>
            </section>

            <div className="grid gap-4 xl:grid-cols-2">
              <section className="rounded-card border border-line bg-surface p-4">
                <h3 className="m-0 mb-1 text-body">Checks</h3>
                <p className="m-0 mb-2 text-caption text-muted">Two are worked out by the system; four are your own call.</p>
                {detail.checks.map((k) => {
                  const ic = CHECK_ICON[k.state]!;
                  return (
                    <div key={k.code} className="flex flex-col gap-1.5 border-t border-line-subtle py-2.5">
                      <div className="flex items-center gap-2.5 text-body">
                        <span aria-hidden="true" className={`flex size-[22px] shrink-0 items-center justify-center rounded-pill text-[12px] font-extrabold ${ic.tone}`}>
                          {ic.mark}
                        </span>
                        <span className="grow">{k.label}</span>
                        <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">{k.by === 'computed' ? 'System' : 'You'}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 pl-8">
                        <span className={`text-caption ${ic.note}`}>{k.note}</span>
                        {k.by === 'reviewer' && !decided ? (
                          <span className="flex gap-1" role="group" aria-label={`${k.label}: your call`}>
                            {(['pass', 'warn', 'fail'] as const).map((o) => (
                              <button key={o} type="button" aria-pressed={k.state === o} disabled={busy !== null} onClick={() => void run(`check-${k.code}`, () => adminApi.setCheck(detail.id, k.code, o))} className={`h-8 rounded-chip border px-2.5 text-[12px] font-bold ${k.state === o ? 'border-ink bg-ink text-white' : 'border-control-line bg-surface text-ink'}`}>
                                {o === 'pass' ? 'Yes' : o === 'warn' ? 'Unsure' : 'No'}
                              </button>
                            ))}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </section>

              <section className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-4">
                <div className="flex items-baseline justify-between">
                  <h3 className="m-0 text-body">Read from the ID</h3>
                  <span className="text-caption text-muted">Compared with the account</span>
                </div>
                <div className="text-caption text-muted">Account name: {detail.fields.accountName}</div>
                <TextField label="Full name on the ID" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} disabled={decided} />
                <div className="grid grid-cols-2 gap-2.5">
                  <TextField label="Date of birth" type="date" value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} disabled={decided} />
                  <TextField label="Expires" type="date" value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} disabled={decided} />
                </div>
                <TextField label="ID number" value={form.idNumber} placeholder={detail.fields.idNumberMasked ?? 'As printed on the card'} hint={detail.fields.hasIdNumber ? 'Recorded and encrypted. Type a new one to replace it.' : 'Encrypted the moment you save.'} onChange={(e) => setForm({ ...form, idNumber: e.target.value })} disabled={decided} />
                {decided ? null : (
                  <div>
                    <Button variant="secondary" busy={busy === 'details'} busyLabel="Saving…" onClick={() => void run('details', () => adminApi.saveDetails(detail.id, form), 'Saved')}>
                      Save what I read
                    </Button>
                  </div>
                )}

                {detail.fields.hasIdNumber ? (
                  revealed !== null ? (
                    <div className="flex items-center justify-between gap-2 rounded-control bg-status-warn p-2.5 text-status-warn-fg">
                      <span className="font-mono text-body">{revealed}</span>
                      <Button variant="text" onClick={() => setRevealed(null)}>
                        Hide
                      </Button>
                    </div>
                  ) : askReveal ? (
                    <div className="flex flex-col gap-2 rounded-control bg-ground p-2.5">
                      <TextField label="Why do you need the full number?" value={revealWhy} onChange={(e) => setRevealWhy(e.target.value)} placeholder="e.g. matching the RDB record" maxLength={200} />
                      <div className="flex justify-end gap-2">
                        <Button variant="text" onClick={() => { setAskReveal(false); setRevealWhy(''); }}>
                          Cancel
                        </Button>
                        <Button tone="brand" busy={busy === 'reveal'} busyLabel="Revealing…" disabled={revealWhy.trim().length < 3} onClick={() => void doReveal()}>
                          Reveal
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <Button variant="secondary" onClick={() => setAskReveal(true)}>
                        Show full ID number
                      </Button>
                      <span className="text-caption text-muted">Revealing the full ID number is recorded in the audit log, with your reason.</span>
                    </div>
                  )
                ) : null}
              </section>
            </div>

            <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
              <h3 className="m-0 text-body">Decision</h3>
              {decided ? (
                <p className="m-0 text-body text-ink-2">
                  This check is {detail.status.replace('_', ' ')}.{detail.decisionNote === null ? '' : ` The merchant was told: “${detail.decisionNote}”`}
                </p>
              ) : (
                <>
                  <label className="flex flex-col gap-1 text-caption font-semibold">
                    Message to the merchant <span className="font-normal text-muted">(required to reject or ask for a retake — they read this sentence)</span>
                    <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} maxLength={500} placeholder="e.g. The back of your ID is blurry, so we can’t read the numbers." className="rounded-control border border-control-line bg-surface p-2.5 text-body font-normal" />
                  </label>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <Button tone="brand" busy={busy === 'approve'} busyLabel="Approving…" disabled={busy !== null} onClick={() => void decide('approve')}>
                      Approve identity
                    </Button>
                    <select aria-label="What to redo" value={redo} onChange={(e) => setRedo(e.target.value as typeof redo)} className="h-11 rounded-control border border-control-line bg-surface px-2.5 text-body">
                      <option value="">Ask them to redo…</option>
                      <option value="front">ID front photo</option>
                      {detail.documentType === 'passport' ? null : <option value="back">ID back photo</option>}
                      <option value="video">Face video</option>
                    </select>
                    <Button variant="secondary" busy={busy === 'redo'} busyLabel="Sending…" disabled={redo === '' || message.trim() === '' || busy !== null} onClick={() => void decide('redo')}>
                      Send request
                    </Button>
                    <span className="grow" />
                    <Button variant="secondary" busy={busy === 'reject'} busyLabel="Rejecting…" disabled={message.trim() === '' || busy !== null} onClick={() => void decide('reject')}>
                      Reject
                    </Button>
                  </div>
                  <span className="text-caption text-muted">The merchant is told in the app. {KYC_RETENTION_LINE}</span>
                </>
              )}
            </section>
          </div>
        )}
      </div>

      {toast === null ? null : (
        <div className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}
