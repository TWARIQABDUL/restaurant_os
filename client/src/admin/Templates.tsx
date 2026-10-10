// client/src/admin/Templates.tsx — milestone 27 part C, from project/AdminIndustries.dc.html.
//
// WHAT THE SCREEN CAN TELL YOU BECAUSE THE SCHEMA ENFORCES IT: a live version is frozen (V002), so "Save draft" on a live template
// starts the next version and says so — "v4 · live" becomes "v5 · draft" the moment you change a word — and "Publish" is the only way
// anything a store reads moves. The rollout choice is the board's: new stores only, or also repin the stores already on it (their own
// customisations are kept, because those live in a different column).
//
// ORDER STEPS ARE SHOWN, NOT EDITED, and product flags are shown for Pharmacy only because only Pharmacy has one: a step's key is
// what orders and history point at, so renaming or reordering one is a data migration, not a copy edit. "+ New template" is not
// built either — a business type is a product decision before it is a form.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, Toast } from '../shared/ui/index.ts';
import { adminOpsApi } from './adminApi.ts';
import type { Attribute, TemplateDetail, TemplateSummary } from './adminApi.ts';
import { TEMPLATE_WORDS, templateMeta } from './adminLines.ts';

const reason = (cause: unknown, fallback: string): string => (cause instanceof ApiFailure ? cause.message : fallback);

type Draft = { words: TemplateDetail['words']; modules: string[]; attributes: Attribute[] };
const draftOf = (d: TemplateDetail): Draft => ({ words: d.words, modules: d.modules, attributes: d.attributes });

type Props = { initialList?: TemplateSummary[]; initialDetail?: TemplateDetail; initialRollout?: 'new' | 'all' };

export function Templates({ initialList, initialDetail, initialRollout }: Props): ReactNode {
  const [list, setList] = useState<TemplateSummary[] | null>(initialList ?? null);
  const [sel, setSel] = useState<string | null>(initialDetail?.key ?? null);
  const [detail, setDetail] = useState<TemplateDetail | null>(initialDetail ?? null);
  const [draft, setDraft] = useState<Draft | null>(initialDetail === undefined ? null : draftOf(initialDetail));
  const [rollout, setRollout] = useState<'new' | 'all'>(initialRollout ?? 'new');
  const [newAttr, setNewAttr] = useState({ name: '', pick: 'one' as 'one' | 'several' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const seeded = useRef(initialList !== undefined);

  const flash = (m: string): void => {
    setToast(m);
    window.setTimeout(() => setToast((c) => (c === m ? null : c)), 3200);
  };

  const loadList = useCallback(async (): Promise<void> => {
    try {
      const r = await adminOpsApi.templates();
      setList(r.templates);
      setSel((cur) => cur ?? r.templates.find((t) => t.hasDraft)?.key ?? r.templates[0]?.key ?? null);
      setError(null);
    } catch (cause) {
      setError(reason(cause, 'Templates could not be loaded.'));
    }
  }, []);

  useEffect(() => {
    if (seeded.current) return;
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    if (sel === null) return setDetail(null);
    let live = true;
    void adminOpsApi.template(sel).then((d) => {
      if (!live) return;
      setDetail(d);
      setDraft(draftOf(d));
      setRollout('new');
    }).catch((cause: unknown) => live && setError(reason(cause, 'That template could not be loaded.')));
    return () => {
      live = false;
    };
  }, [sel]);

  const adopt = (d: TemplateDetail): void => {
    setDetail(d);
    setDraft(draftOf(d));
    setList((l) => (l === null ? l : l.map((t) => (t.key === d.key ? { key: d.key, name: d.name, accent: d.accent, stores: d.stores, liveVersion: d.liveVersion, hasDraft: d.hasDraft } : t))));
  };

  const dirty = detail !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(draftOf(detail));

  const save = async (): Promise<void> => {
    if (detail === null || draft === null) return;
    setBusy('save');
    setError(null);
    try {
      adopt(await adminOpsApi.saveTemplate(detail.key, draft));
      flash(`${detail.name} draft saved`);
    } catch (cause) {
      setError(reason(cause, 'That draft could not be saved.'));
    } finally {
      setBusy(null);
    }
  };

  const publish = async (): Promise<void> => {
    if (detail === null) return;
    setBusy('publish');
    setError(null);
    try {
      const r = await adminOpsApi.publishTemplate(detail.key, rollout);
      adopt(r.template);
      flash(`${detail.name} v${r.template.liveVersion ?? ''} published${rollout === 'all' && detail.stores > 0 ? ` · updated ${r.updated} ${r.updated === 1 ? 'store' : 'stores'}` : ' · new stores only'}`);
    } catch (cause) {
      setError(reason(cause, 'That could not be published.'));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (m: string): void => {
    if (draft === null) return;
    setDraft({ ...draft, modules: draft.modules.includes(m) ? draft.modules.filter((x) => x !== m) : [...draft.modules, m] });
  };

  const hasLive = detail !== null && detail.liveVersion !== null;
  const canPublish = detail !== null && detail.hasDraft && !dirty;

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:gap-7">
      <nav aria-label="Templates" className="flex shrink-0 flex-col gap-1 lg:w-[280px]">
        <h1 className="m-0 font-display text-[26px]">Industry templates</h1>
        <p className="m-0 mb-2 text-caption text-muted">What a store gets when a merchant picks this business type.</p>
        {list === null ? <p className="m-0 text-muted">Loading…</p> : null}
        {list?.map((t) => (
          <button key={t.key} type="button" aria-pressed={t.key === sel} onClick={() => setSel(t.key)} className={`flex min-h-[52px] items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left ${t.key === sel ? 'border border-line bg-surface [box-shadow:0_0_0_1px_var(--color-line)]' : 'border border-transparent bg-transparent'}`}>
            <span aria-hidden="true" className="size-2.5 shrink-0 rounded-pill" style={{ background: t.accent }} />
            <span className="flex grow flex-col">
              <span className="font-semibold">{t.name}</span>
              <span className="text-[12px] text-muted">{templateMeta(t)}</span>
            </span>
            {t.hasDraft ? <span className="rounded-pill bg-status-warn px-2 py-px text-[11px] font-bold text-status-warn-fg">Draft</span> : null}
          </button>
        ))}
      </nav>

      <div className="min-w-0 grow">
        {error === null ? null : <Alert tone="danger" headline={error} />}
        {detail === null || draft === null ? null : (
          <div className="flex flex-col gap-4">
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="m-0 font-display text-[28px]">{detail.name}</h2>
                  <span className={`rounded-pill px-2.5 py-[3px] text-[12px] font-bold ${detail.state === 'draft' ? 'bg-status-warn text-status-warn-fg' : 'bg-status-success text-status-success-fg'}`}>
                    v{detail.version} · {detail.state}
                  </span>
                </div>
                <p className="m-0 mt-0.5 text-body text-muted">
                  {templateMeta(detail)}
                  {hasLive && detail.state === 'draft' ? ` · v${detail.liveVersion} is still what stores read` : ''}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" disabled={!dirty} busy={busy === 'save'} busyLabel="Saving…" onClick={() => void save()}>
                  Save draft
                </Button>
                <Button tone="brand" disabled={!canPublish} busy={busy === 'publish'} busyLabel="Publishing…" onClick={() => void publish()}>
                  Publish
                </Button>
              </div>
            </header>
            {dirty ? <Alert tone="warn" headline="You have unsaved changes.">Save the draft, then publish it.</Alert> : null}

            <div className="grid gap-4 xl:grid-cols-2">
              <section className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-5">
                <h3 className="m-0 text-[16px]">Words merchants and customers see</h3>
                {TEMPLATE_WORDS.map((w) => (
                  <label key={w.key} className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-2.5 text-body">
                    <span className="text-muted">{w.label}</span>
                    <input aria-label={w.label} value={draft.words[w.key]} maxLength={40} onChange={(e) => setDraft({ ...draft, words: { ...draft.words, [w.key]: e.target.value } })} className="h-10 rounded-control border border-control-line bg-surface px-2.5" />
                  </label>
                ))}
              </section>

              <section className="rounded-card border border-line bg-surface p-5">
                <h3 className="m-0 text-[16px]">Modules turned on by default</h3>
                <p className="m-0 mb-1.5 mt-0.5 text-caption text-muted">Merchants can still change these in their Settings.</p>
                {detail.catalogue.modules.map((m) => {
                  const on = draft.modules.includes(m.key);
                  return (
                    <div key={m.key} className="flex items-center gap-3 border-t border-line-subtle py-2">
                      <span className="grow font-semibold">{m.label}</span>
                      <button type="button" role="switch" aria-checked={on} aria-label={m.label} onClick={() => toggle(m.key)} className={`flex h-[26px] w-11 shrink-0 rounded-pill border-0 p-[3px] ${on ? 'justify-end bg-brand' : 'justify-start bg-control-line'}`}>
                        <span className="size-5 rounded-pill bg-surface" />
                      </button>
                    </div>
                  );
                })}
              </section>

              <section className="flex flex-col gap-2 rounded-card border border-line bg-surface p-5">
                <h3 className="m-0 text-[16px]">Suggested attributes</h3>
                <p className="m-0 text-caption text-muted">Shown as one-tap suggestions in Add product.</p>
                <div className="flex flex-wrap gap-1.5">
                  {draft.attributes.map((a) => (
                    <span key={a.name} className="flex h-[34px] items-center gap-1.5 rounded-control bg-status-neutral pl-3 pr-1 font-semibold">
                      {a.name}
                      <span className="text-[12px] font-medium text-muted">{a.pick === 'one' ? 'pick one' : 'several'}</span>
                      <button type="button" aria-label={`Remove ${a.name}`} onClick={() => setDraft({ ...draft, attributes: draft.attributes.filter((x) => x.name !== a.name) })} className="flex size-7 items-center justify-center rounded-chip border-0 bg-transparent text-muted">
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input aria-label="New attribute" placeholder="e.g. Material" value={newAttr.name} maxLength={40} onChange={(e) => setNewAttr({ ...newAttr, name: e.target.value })} className="h-10 min-w-0 grow rounded-control border border-control-line bg-surface px-2.5" />
                  <select aria-label="How many can be picked" value={newAttr.pick} onChange={(e) => setNewAttr({ ...newAttr, pick: e.target.value as 'one' | 'several' })} className="h-10 rounded-control border border-control-line bg-surface px-2">
                    <option value="one">Pick one</option>
                    <option value="several">Several</option>
                  </select>
                  <Button variant="secondary" disabled={newAttr.name.trim() === ''} onClick={() => { setDraft({ ...draft, attributes: [...draft.attributes, { name: newAttr.name.trim(), pick: newAttr.pick }] }); setNewAttr({ name: '', pick: 'one' }); }}>
                    + Add
                  </Button>
                </div>
              </section>

              <section className="flex flex-col gap-2 rounded-card border border-line bg-surface p-5">
                <h3 className="m-0 text-[16px]">Order steps</h3>
                <p className="m-0 text-caption text-muted">The timeline customers see and the buttons merchants press. Changing steps is a data migration, not an edit here.</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {detail.steps.map((s, i) => (
                    <span key={s.key} className="flex items-center gap-1.5">
                      <span className="flex h-8 items-center rounded-pill bg-status-neutral px-3 text-caption font-semibold">{s.label}</span>
                      {i < detail.steps.length - 1 ? <span className="text-disabled">→</span> : null}
                    </span>
                  ))}
                </div>
                {detail.flags.map((f) => (
                  <div key={f.key} className="mt-1 rounded-control bg-status-info p-2.5 text-caption text-status-info-fg">
                    <strong>Product flag:</strong> {f.label}. {f.description}
                  </div>
                ))}
              </section>
            </div>

            <section className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-5">
              <h3 className="m-0 text-[16px]">When you publish</h3>
              <div role="radiogroup" aria-label="Rollout" className="grid gap-2.5 md:grid-cols-2">
                {([
                  ['new', 'New stores only', 'Existing stores keep their current setup. Safest option.'],
                  ['all', detail.stores > 0 ? `Also update ${detail.stores.toLocaleString('en-US')} existing ${detail.stores === 1 ? 'store' : 'stores'}` : 'Also update existing stores', 'Only defaults change. Anything a merchant customised is kept.'],
                ] as const).map(([id, title, body]) => (
                  <button key={id} type="button" role="radio" aria-checked={rollout === id} onClick={() => setRollout(id)} className={`flex items-start gap-2.5 rounded-card bg-surface p-3.5 text-left ${rollout === id ? 'border-2 border-brand' : 'border border-control-line'}`}>
                    <span aria-hidden="true" className={`mt-0.5 size-[18px] shrink-0 rounded-pill ${rollout === id ? 'border-[6px] border-brand' : 'border-[1.5px] border-control-line'}`} />
                    <span className="flex flex-col">
                      <span className="font-semibold">{title}</span>
                      <span className="text-caption text-muted">{body}</span>
                    </span>
                  </button>
                ))}
              </div>
              {!detail.hasDraft ? <span className="text-caption text-muted">Make a change and save a draft — there’s nothing to publish yet.</span> : null}
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
