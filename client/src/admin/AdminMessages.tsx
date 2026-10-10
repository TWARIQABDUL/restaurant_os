// client/src/admin/AdminMessages.tsx — milestone 28, from project/Messages.dc.html ("Emails and SMS, in each store's colours").
//
// THE BOARD IS A TEMPLATE GALLERY, AND SO IS THE TOP OF THIS SCREEN: eleven messages, the email as it will look in a store's colours,
// the SMS as it will read with its character count out of 160. Both previews are drawn by the SAME functions the server uses to write
// the real message (packages/core/src/messages), so the preview cannot describe a message the system would not send.
//
// THE BOTTOM HALF IS THE BOARD'S MISSING SENTENCE — what happens next. "Delivery" says whether anything is actually leaving (no SMS
// provider has been chosen; email likewise) and shows the last thirty messages with where each one got to, recipients masked. A
// message with no phone number is a visible "Skipped", and "why didn't they hear from us?" has an answer on this page.
//
// THE SAMPLE STORES ARE THE BOARD'S THREE. They exist to show the one thing a gallery of templates is for: that the button stays
// readable when a store's colour is light (lime flips to dark text) — not to preview a particular merchant.

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { CUSTOMER_MESSAGES, MESSAGE_LABEL, SMS_LIMIT, SMS_ONLY_MESSAGES, emailColours, isCustomerMessage, renderCustomerEmail, renderEmailHtml, renderSms, sampleContext, senderId, smsFit } from '../app/core.ts';
import type { MessageKey } from '../app/core.ts';
import { Alert } from '../shared/ui/index.ts';
import { adminMessagesApi } from './adminApi.ts';
import type { MessageQueue, OutboxRow } from './adminApi.ts';
import { OUTBOX_STATUS, SAMPLE_STORES, whenText } from './adminLines.ts';

export function AdminMessages({ initial, initialKey, initialStore }: { initial?: { queue: MessageQueue; recent: OutboxRow[] }; initialKey?: MessageKey; initialStore?: (typeof SAMPLE_STORES)[number]['key'] }): ReactNode {
  const [key, setKey] = useState<MessageKey>(initialKey ?? 'assigned');
  const [storeKey, setStoreKey] = useState<(typeof SAMPLE_STORES)[number]['key']>(initialStore ?? 'nyama');
  const [data, setData] = useState(initial ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initial !== undefined) return;
    void adminMessagesApi.messages().then(setData).catch((c: unknown) => setError(c instanceof ApiFailure ? c.message : 'The message log could not be loaded.'));
  }, [initial]);

  const store = SAMPLE_STORES.find((s) => s.key === storeKey)!;
  const customer = isCustomerMessage(key);
  const ctx = sampleContext(store.name);
  const sms = renderSms(key, ctx);
  const fit = smsFit(sms);
  const email = customer ? renderCustomerEmail(key, ctx) : null;
  const colours = emailColours(store.brand);
  const html = email === null ? null : renderEmailHtml(email, { name: store.name, mark: store.mark, phone: '078 812 3456', brand: store.brand }, { number: 1026, placedAt: 'Wed 23 Sep, 13:58', lines: [{ quantity: 2, name: store.item, amount: '7,000 RWF' }], delivery: '2,000 RWF', total: '9,000 RWF' }, 'https://vndl.fy/k3x9');
  const from = customer ? senderId(store.name) : 'VENDLYFY';

  const list = (keys: readonly MessageKey[], label: string): ReactNode => (
    <div className="flex flex-col gap-1">
      <span className="px-2 pt-2 text-[12px] font-bold uppercase tracking-[0.06em] text-muted">{label}</span>
      {keys.map((k) => (
        <button key={k} type="button" aria-pressed={k === key} onClick={() => setKey(k)} className={`min-h-11 rounded-control border-0 px-2.5 py-2 text-left text-body font-semibold ${k === key ? 'bg-surface [box-shadow:0_0_0_1px_var(--color-line)]' : 'bg-transparent text-ink-2'}`}>
          {MESSAGE_LABEL[k]}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <span className="text-caption font-semibold uppercase tracking-[0.08em] text-muted">Transactional messages</span>
          <h1 className="m-0 mt-1 font-display text-[28px]">Emails and SMS, in each store’s colours</h1>
        </div>
        <div role="radiogroup" aria-label="Sample store" className="flex rounded-control bg-status-neutral p-[3px]">
          {SAMPLE_STORES.map((s) => (
            <button key={s.key} type="button" role="radio" aria-checked={s.key === storeKey} onClick={() => setStoreKey(s.key)} className={`h-10 rounded-chip border-0 bg-transparent px-3 text-caption font-semibold ${s.key === storeKey ? 'bg-surface [box-shadow:0_1px_2px_rgb(23_22_15/.12)]' : 'text-ink-2'}`}>
              {s.name}
            </button>
          ))}
        </div>
      </header>

      <div className="flex flex-col gap-5 xl:flex-row">
        <nav aria-label="Templates" className="flex shrink-0 flex-col gap-1 xl:w-[240px]">
          {list(CUSTOMER_MESSAGES, 'Customer · email + SMS')}
          {list(SMS_ONLY_MESSAGES, 'Merchant and rider · SMS only')}
        </nav>

        <section aria-label="Email preview" className={`flex w-full max-w-[600px] shrink-0 flex-col overflow-hidden rounded-card border border-line bg-surface ${customer ? '' : 'opacity-45'}`}>
          <div className="flex flex-col gap-0.5 border-b border-line bg-ground px-4 py-2.5 text-[12px] text-ink-2">
            <span>
              <strong>From:</strong> {store.name} &lt;orders@{store.key}.example&gt;
            </span>
            <span>
              <strong>Subject:</strong> {email === null ? 'SMS only' : email.subject}
            </span>
          </div>
          {email === null || html === null ? (
            <div className="p-8 text-body text-muted">
              <strong className="text-ink">No email for this message.</strong>
              <br />
              This one is sent by SMS only, because it needs to reach someone quickly on the move.
            </div>
          ) : (
            // The email's own HTML, in a frame: what is drawn is the document the server would send, not a lookalike of it.
            <iframe title="Email preview" srcDoc={html} sandbox="" className="h-[560px] w-full border-0" />
          )}
        </section>

        <section aria-label="SMS preview" className="flex grow flex-col gap-3.5">
          <div className="w-[300px] rounded-[30px] bg-ink p-2">
            <div className="flex min-h-[360px] flex-col gap-2.5 rounded-[22px] bg-surface px-3.5 py-[18px]">
              <span className="self-center text-[12px] font-bold text-muted">{from}</span>
              <div className="max-w-[240px] self-start rounded-[16px_16px_16px_4px] bg-status-neutral px-3 py-2.5 text-body">{sms}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-caption">
            <span className={`rounded-pill px-2.5 py-0.5 font-bold ${fit.fits ? 'bg-status-success text-status-success-fg' : 'bg-status-danger text-status-danger-fg'}`}>
              {fit.count} / {SMS_LIMIT}
            </span>
            <span className="text-muted">{fit.fits ? 'Fits one SMS' : 'Too long: would be split in two'}</span>
          </div>
          <span className="max-w-[360px] text-caption text-ink-2">SMS is plain text, so it carries the store name, not its colours. Links go to the store’s own tracking page.</span>
          {customer ? (
            <span className="max-w-[360px] text-caption text-muted">
              The button is <strong>{colours.onButton === '#17160F' ? 'dark' : 'white'}</strong> text on {store.name}’s colour — it flips to dark when the colour is light.
            </span>
          ) : null}
        </section>
      </div>

      <section aria-label="Delivery" className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5">
        <h2 className="m-0 text-[18px]">Delivery</h2>
        {error === null ? null : <Alert tone="danger" headline={error} />}
        {data === null ? <p className="m-0 text-muted">Loading…</p> : (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              {(['sms', 'email'] as const).map((c) => {
                const q = data.queue[c];
                return (
                  <div key={c} className={`rounded-control p-3.5 ${q.configured ? 'bg-status-success text-status-success-fg' : 'bg-status-warn text-status-warn-fg'}`}>
                    <strong>{c === 'sms' ? 'SMS' : 'Email'}: {q.configured ? 'development transport' : 'no provider connected'}</strong>
                    <div className="text-caption">
                      {q.queued === 0 ? 'Nothing waiting.' : `${q.queued} ${q.queued === 1 ? 'message is' : 'messages are'} waiting${q.oldestMinutes === null ? '' : `, the oldest for ${q.oldestMinutes} min`}.`}
                      {q.configured ? '' : ' They are sent once a provider is chosen; messages older than a few hours are skipped rather than sent late.'}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="overflow-x-auto">
              <div className="grid min-w-[720px] grid-cols-[120px_70px_minmax(0,1.4fr)_100px_minmax(0,1fr)_90px] gap-3 bg-ground px-3 py-2 text-[12px] font-semibold text-muted">
                <span>Queued</span>
                <span>Channel</span>
                <span>Message</span>
                <span>To</span>
                <span>Store</span>
                <span>Status</span>
              </div>
              {data.recent.length === 0 ? <p className="m-0 px-3 py-6 text-center text-muted">No messages yet.</p> : null}
              {data.recent.map((m) => {
                const st = OUTBOX_STATUS[m.status] ?? OUTBOX_STATUS['queued']!;
                return (
                  <div key={m.id} className="grid min-w-[720px] grid-cols-[120px_70px_minmax(0,1.4fr)_100px_minmax(0,1fr)_90px] items-center gap-3 border-t border-line-subtle px-3 py-2 text-body">
                    <span className="text-caption text-muted">{whenText(m.at)}</span>
                    <span className="text-caption font-semibold uppercase">{m.channel}</span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{m.label}</span>
                      {m.error === null ? null : <span className="truncate text-[12px] text-muted">{m.error}</span>}
                    </span>
                    <span className="font-mono text-[12px]">{m.recipient}</span>
                    <span className="truncate text-ink-2">{m.store ?? '—'}</span>
                    <span className={`justify-self-start rounded-pill px-2 py-0.5 text-[12px] font-bold ${st.tone}`}>{st.label}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
