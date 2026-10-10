// client/src/console/MobileLook.tsx — milestone 28, from project/MobileTheme.dc.html.
//
// THE PHONE'S VERSION OF STORE DESIGN. Customize and ThemeStudio are desktop layouts with a preview beside them; on a phone the board
// stacks it instead — a small live preview and its readability checks above, three tabs below (Colours, Style, More) — and says what the
// phone leaves out: "The full studio, with logo colours, your own second colour and every readability score, is on a bigger screen."
//
// IT IS THE SAME DRAFT. `useLookDraft` is what Customize and ThemeStudio edit, so a colour chosen here is the colour in the studio and
// "Publish" puts the palette and the layout live in the same single transaction. Nothing on this screen is stored anywhere of its own.
//
// THE BOARD'S THREE HEADING FONTS ARE THE ENGINE'S FOUR, for the reason Customize's header gives (the compiler and the database CHECK
// know Modern, Editorial, Sport and Classic; "Clean" has no counterpart). The board's eight swatches are kept as drawn, and any colour
// at all is one tap away through the colour input at the end of the row.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { CARD_TREATMENTS, HARMONIES, HEADING_FONTS, MOODS, SHAPES } from '../app/core.ts';
import type { CardTreatment, Harmony, HeadingFont, Mood, Shape, ThemeInputs } from '../app/core.ts';
import { Alert, Button, Toast } from '../shared/ui/index.ts';
import { useLookDraft } from './lookDraft.ts';
import type { LookDraft } from './lookDraft.ts';
import { SAMPLE_CATEGORIES, SAMPLE_PRODUCTS, StorePreview } from './StorePreview.tsx';
import { useShell } from './ShellProvider.tsx';

export const SWATCHES: readonly string[] = ['#E4572E', '#1D6B47', '#1F437F', '#6B3E26', '#C6F432', '#9D174D', '#F4D35E', '#17160F'];

export const HARMONY_LABEL: Record<Harmony, string> = { complementary: 'Contrast', analogous: 'Neighbour', split: 'Split', mono: 'One family' };

type Group = { key: keyof Pick<ThemeInputs, 'mood' | 'shape' | 'headingFont' | 'cardTreatment'>; label: string; options: readonly { id: string; label: string }[] };

export const STYLE_GROUPS: readonly Group[] = [
  { key: 'mood', label: 'Mood', options: MOODS.map((m: Mood) => ({ id: m, label: { light: 'Light', warm: 'Warm', dark: 'Dark' }[m] })) },
  { key: 'shape', label: 'Shape', options: SHAPES.map((s: Shape) => ({ id: s, label: { sharp: 'Sharp', soft: 'Soft', round: 'Round' }[s] })) },
  { key: 'headingFont', label: 'Headings', options: HEADING_FONTS.map((f: HeadingFont) => ({ id: f, label: { modern: 'Modern', editorial: 'Editorial', sport: 'Sport', classic: 'Classic' }[f] })) },
  { key: 'cardTreatment', label: 'Cards', options: CARD_TREATMENTS.map((c: CardTreatment) => ({ id: c, label: { flat: 'Flat', outlined: 'Outlined', shadow: 'Raised' }[c] })) },
];

type Tab = 'colors' | 'style' | 'full';

/** The phone's frame is 150×308 around a 390×776 page scaled to fit; this is the scale, so the preview is the real component, shrunk. */
const SCALE = 140 / 390;

export function MobileLook({ navigate, initial, initialTab }: { navigate: (to: string) => void; initial?: Parameters<typeof useLookDraft>[1]; initialTab?: Tab }): ReactNode {
  const { store } = useShell();
  const look: LookDraft = useLookDraft(store.id, initial);
  const [tab, setTab] = useState<Tab>(initialTab ?? 'colors');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const publish = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    const r = await look.publish();
    setBusy(false);
    if (r.ok) {
      setToast('Your new look is live');
      window.setTimeout(() => setToast(null), 2600);
    } else {
      setMessage(r.message);
    }
  };

  const set = (patch: Partial<ThemeInputs>): void => look.setInputs((prev) => ({ ...prev, ...patch }));
  const brand = look.inputs.brand;
  const notes = look.theme.notes;
  const failing = look.theme.checks.filter((c) => !c.pass && !c.satisfiedByOutline).length;

  return (
    <div className="mx-auto flex min-h-dvh max-w-[440px] flex-col bg-ground text-ink">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <button type="button" aria-label="Back" onClick={() => navigate(`/app/${store.slug}/more`)} className="flex size-11 items-center justify-center border-0 bg-transparent text-ink">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span className="grow font-bold">Store look</span>
        <Button tone="brand" disabled={!look.ready || !look.unpublished} busy={busy} busyLabel="Publishing…" onClick={() => void publish()}>
          Publish
        </Button>
      </header>

      {look.loadError !== null ? <div className="p-4"><Alert tone="danger" headline={look.loadError}><Button variant="secondary" onClick={look.reload}>Try again</Button></Alert></div> : null}
      {message === null ? null : <div className="px-4 pt-3"><Alert tone="danger" headline={message} /></div>}

      <div className="flex shrink-0 items-center justify-center gap-3.5 bg-status-neutral px-4 py-5">
        <div className="shrink-0 rounded-[20px] bg-ink p-[5px]" style={{ width: 150, height: 308 }}>
          <div className="overflow-hidden rounded-[16px]" style={{ width: 140, height: 298 }}>
            <div style={{ width: 390, transform: `scale(${SCALE})`, transformOrigin: 'top left' }}>
              <StorePreview theme={look.theme} design={look.design} device="mobile" storeName={store.name} products={SAMPLE_PRODUCTS} categories={SAMPLE_CATEGORIES} cartTotal="0" />
            </div>
          </div>
        </div>
        <div className="flex w-[150px] flex-col gap-2 text-[12px]">
          <span className="text-[13px] font-bold">Readability</span>
          {look.theme.checks.slice(0, 3).map((c) => (
            <span key={c.label} className="flex items-center gap-1.5">
              <span aria-hidden="true" className={`flex size-[18px] shrink-0 items-center justify-center rounded-pill text-[10px] font-extrabold ${c.pass ? 'bg-status-success text-status-success-fg' : 'bg-status-info text-status-info-fg'}`}>
                {c.pass ? '✓' : '!'}
              </span>
              {c.label}
            </span>
          ))}
          {notes.length === 0 && failing === 0 ? null : <span className="rounded-control bg-status-info p-2 text-status-info-fg">{notes[0] ?? 'Colours were adjusted so text stays readable.'}</span>}
        </div>
      </div>

      <div role="tablist" className="flex border-b border-line bg-surface">
        {([['colors', 'Colours'], ['style', 'Style'], ['full', 'More']] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`h-12 flex-1 border-0 border-b-[3px] bg-transparent text-body font-bold ${tab === id ? 'border-ink text-ink' : 'border-transparent text-muted'}`}>
            {label}
          </button>
        ))}
      </div>

      <div className="flex grow flex-col gap-4 bg-surface px-4 py-4">
        {tab === 'colors' ? (
          <>
            <div className="flex flex-col gap-2">
              <strong className="text-body">Brand colour</strong>
              <div className="flex flex-wrap items-center gap-2">
                {SWATCHES.map((hex) => (
                  <button key={hex} type="button" aria-label={`Brand ${hex}`} aria-pressed={brand.toLowerCase() === hex.toLowerCase()} onClick={() => set({ brand: hex })} style={{ background: hex }} className={`size-10 rounded-pill border-[3px] border-white p-0 ${brand.toLowerCase() === hex.toLowerCase() ? '[box-shadow:0_0_0_2px_var(--color-ink)]' : '[box-shadow:0_0_0_1px_var(--color-control-line)]'}`} />
                ))}
                <label className="flex size-10 items-center justify-center overflow-hidden rounded-pill border border-dashed border-control-line">
                  <input type="color" aria-label="Any colour" value={/^#[0-9a-f]{6}$/i.test(brand) ? brand.toLowerCase() : '#1d6b47'} onChange={(e) => set({ brand: e.target.value.toUpperCase() })} className="size-[30px] border-0 bg-transparent p-0" />
                </label>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <strong className="text-body">Second colour · Vendlyfy picks</strong>
              <div className="grid grid-cols-2 gap-2">
                {HARMONIES.map((h) => (
                  <button key={h} type="button" aria-pressed={look.inputs.harmony === h && look.inputs.accent === null} onClick={() => set({ harmony: h, accent: null })} className={`min-h-11 rounded-control bg-surface px-2.5 py-2 text-left text-caption font-bold ${look.inputs.harmony === h && look.inputs.accent === null ? 'border-2 border-ink' : 'border border-control-line'}`}>
                    {HARMONY_LABEL[h]}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : null}

        {tab === 'style' ? (
          <div className="flex flex-col gap-3">
            {STYLE_GROUPS.map((g) => (
              <div key={g.key} className="flex flex-col gap-1.5">
                <span className="text-caption font-bold">{g.label}</span>
                <div role="radiogroup" aria-label={g.label} className="flex rounded-control bg-status-neutral p-[3px]">
                  {g.options.map((o) => (
                    <button key={o.id} type="button" role="radio" aria-checked={look.inputs[g.key] === o.id} onClick={() => set({ [g.key]: o.id } as Partial<ThemeInputs>)} className={`h-10 flex-1 rounded-chip border-0 bg-transparent text-caption font-semibold ${look.inputs[g.key] === o.id ? 'bg-surface [box-shadow:0_1px_2px_rgb(23_22_15/.12)]' : 'text-ink-2'}`}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {tab === 'full' ? (
          <div className="flex flex-col gap-2.5 text-body">
            <span>The full studio, with logo colours, your own second colour and every readability score, is on a bigger screen.</span>
            <a href={`/app/${store.slug}/store-design/theme`} onClick={(e) => { e.preventDefault(); navigate(`/app/${store.slug}/store-design/theme`); }} className="flex h-12 items-center justify-center rounded-control border border-control-line font-bold text-ink no-underline">
              Open the full studio
            </a>
          </div>
        ) : null}
      </div>

      {toast === null ? null : (
        <div className="fixed inset-x-4 bottom-5 z-30">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}
