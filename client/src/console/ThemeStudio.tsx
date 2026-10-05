// client/src/console/ThemeStudio.tsx — milestone 25, from project/ThemeStudio.dc.html.
//
// "Pick your colors. Vendlyfy builds the rest and keeps it readable." The merchant chooses a brand colour and a handful
// of personality inputs; the compiler (packages/core, the board's own `makeTheme` carried across against a frozen golden
// table at milestone 13) turns them into twelve colours and checks every text pair.
//
// THE PREVIEW AND THE PUBLISHED PALETTE ARE ONE FUNCTION. This screen calls the same `compileTheme` the server publishes
// with, so the readability table beside the preview is not a promise about what publishing will do — it is what
// publishing will do. And the server re-runs it on publish and refuses anything that is not its own output, so nothing
// the client sends can make a palette the compiler would not have made.
//
// THE DRAFT SAVES ITSELF. Nothing here asks the merchant to remember to save: a change is stored a moment after it is
// made (lookDraft.ts), "Publish look" is the one deliberate act, and Reset goes back to what is live.
//
// NOT HERE: "Start from your logo — Use these". It reads colours out of an uploaded image, which is image analysis the
// platform does not have, and a button that guessed would hand the merchant a palette that is not their logo's. The
// brand colour is chosen by eye, or typed.

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { CARD_TREATMENTS, HARMONIES, HEADING_FONTS, HEROES, MERCHANT_VISIBLE_TOKENS, MOODS, SHAPES, compileTheme, luminance, rgbToHsl, toRgb } from '../app/core.ts';
import type { CardTreatment, Harmony, HeadingFont, Hero, Mood, Shape, ThemeInputs } from '../app/core.ts';
import { Alert, Button, Segmented, Toast } from '../shared/ui/index.ts';
import { useLookDraft } from './lookDraft.ts';
import type { LookDraft } from './lookDraft.ts';
import { hrefFor } from './nav.ts';
import { SAMPLE_CATEGORIES, SAMPLE_PRODUCTS, StorePreview } from './StorePreview.tsx';
import { useShell } from './ShellProvider.tsx';

const BRANDS = ['#E4572E', '#1D6B47', '#1F437F', '#6B3E26', '#C6F432', '#9D174D', '#F4D35E', '#17160F'] as const;
const ACCENTS = ['#F4D35E', '#2EC4B6', '#FF6B6B', '#7B61FF', '#F28C28', '#1F437F', '#E8C7A0', '#FFFFFF'] as const;

const HARMONY_COPY: Record<Harmony, { label: string; desc: string }> = {
  complementary: { label: 'Contrast', desc: 'Opposite hue, most energetic' },
  analogous: { label: 'Neighbour', desc: 'Next hue over, calm and warm' },
  split: { label: 'Split', desc: 'Lively but less loud' },
  mono: { label: 'One family', desc: 'Shades of your brand color' },
};

const MOOD_LABEL: Record<Mood, string> = { light: 'Light', warm: 'Warm', dark: 'Dark' };
const SHAPE_LABEL: Record<Shape, string> = { sharp: 'Sharp', soft: 'Soft', round: 'Round' };
const FONT_LABEL: Record<HeadingFont, string> = { modern: 'Modern', editorial: 'Editorial', sport: 'Sport', classic: 'Classic' };
const CARD_LABEL: Record<CardTreatment, string> = { flat: 'Flat', outlined: 'Outlined', shadow: 'Raised' };
const HERO_LABEL: Record<Hero, string> = { soft: 'Soft tint', fill: 'Bold color' };

const HEX = /^#?[0-9a-fA-F]{6}$/;

/** "e4572e" or "#E4572E" -> "#E4572E". The input field accepts either; the compiler wants one form. */
export const normaliseHex = (value: string): string => `#${value.replace('#', '').toUpperCase()}`;

/**
 * "This is very close to your brand color" — the board's clash rule: a hand-picked second colour within 20° of the
 * brand's hue AND within 0.15 relative luminance makes sale badges vanish into the buttons.
 */
export function accentClashes(brand: string, accent: string): boolean {
  const hue = (hex: string): number => rgbToHsl(toRgb(hex))[0];
  const d = Math.abs(hue(brand) - hue(accent)) % 360;
  const apart = d > 180 ? 360 - d : d;
  return apart < 20 && Math.abs(luminance(brand) - luminance(accent)) < 0.15;
}

const SHUFFLE_PICK = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

type Props = {
  navigate: (to: string) => void;
  /** The render gate's seam: effects do not run in static markup. Console.tsx passes none. */
  initial?: { inputs: ThemeInputs; design: LookDraft['design'] };
};

export function ThemeStudio({ navigate, initial }: Props): ReactNode {
  const { store, currency, may } = useShell();
  const look = useLookDraft(store.id, initial);
  const [toast, setToast] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [manualAccent, setManualAccent] = useState(false);
  const [brandText, setBrandText] = useState<string | null>(null);

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((current) => (current === m ? null : current)), 2800);
  }, []);

  if (!may('settings.write')) {
    return (
      <div className="p-6">
        <Alert tone="info" headline="Your role can’t change the store’s look.">
          <span>Ask the owner of {store.name} to change your role.</span>
        </Alert>
      </div>
    );
  }

  if (!look.ready) {
    return look.loadError === null ? (
      <div className="p-6 text-body text-muted" aria-busy="true">Opening the studio…</div>
    ) : (
      <div className="p-6">
        <Alert tone="danger" headline={look.loadError}>
          <Button variant="secondary" onClick={look.reload}>
            Try again
          </Button>
        </Alert>
      </div>
    );
  }

  const { inputs, theme } = look;
  const set = (patch: Partial<ThemeInputs>): void => look.setInputs((prev) => ({ ...prev, ...patch }));
  const accentManual = manualAccent || inputs.accent !== null;
  const clash = accentManual && inputs.accent !== null && accentClashes(inputs.brand, inputs.accent);

  const publish = async (): Promise<void> => {
    setPublishing(true);
    const r = await look.publish();
    setPublishing(false);
    flash(r.ok ? 'Your look is live' : r.message);
  };

  const pickBrand = (hex: string): void => {
    set({ brand: hex });
    setBrandText(null);
  };

  const shuffle = (): void => {
    look.setInputs((prev) => ({
      ...prev,
      accent: null,
      harmony: SHUFFLE_PICK(HARMONIES),
      mood: SHUFFLE_PICK<Mood>(['light', 'light', 'warm', 'dark']),
      shape: SHUFFLE_PICK(SHAPES),
      headingFont: SHUFFLE_PICK(HEADING_FONTS),
      cardTreatment: SHUFFLE_PICK(CARD_TREATMENTS),
      hero: SHUFFLE_PICK(HEROES),
    }));
    setManualAccent(false);
  };

  const groups: { label: string; value: string; options: readonly { value: string; label: string }[]; onChange: (v: string) => void }[] = [
    { label: 'Mood', value: inputs.mood, options: MOODS.map((v) => ({ value: v, label: MOOD_LABEL[v] })), onChange: (v) => set({ mood: v as Mood }) },
    { label: 'Shape', value: inputs.shape, options: SHAPES.map((v) => ({ value: v, label: SHAPE_LABEL[v] })), onChange: (v) => set({ shape: v as Shape }) },
    { label: 'Headings', value: inputs.headingFont, options: HEADING_FONTS.map((v) => ({ value: v, label: FONT_LABEL[v] })), onChange: (v) => set({ headingFont: v as HeadingFont }) },
    { label: 'Product cards', value: inputs.cardTreatment, options: CARD_TREATMENTS.map((v) => ({ value: v, label: CARD_LABEL[v] })), onChange: (v) => set({ cardTreatment: v as CardTreatment }) },
    { label: 'Top banner', value: inputs.hero, options: HEROES.map((v) => ({ value: v, label: HERO_LABEL[v] })), onChange: (v) => set({ hero: v as Hero }) },
  ];

  return (
    <div className="flex min-h-dvh flex-col bg-ground">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-5 py-3">
        <a
          href={hrefFor(store.slug, '')}
          onClick={(e) => {
            e.preventDefault();
            navigate(hrefFor(store.slug, ''));
          }}
          className="flex items-center gap-1 text-caption font-semibold"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Dashboard
        </a>
        <div className="grow">
          <h1 className="m-0 font-display text-[22px] leading-tight">Store look</h1>
          <span className="text-caption text-muted">Pick your colors. Vendlyfy builds the rest and keeps it readable.</span>
        </div>
        <span aria-live="polite" className="text-caption text-muted">
          {look.save === 'saving' ? 'Saving…' : look.save === 'failed' ? 'Couldn’t save your draft' : look.unpublished ? 'Draft saved · not live yet' : 'Live'}
        </span>
        <Button variant="secondary" type="button" onClick={shuffle}>
          Try a combination
        </Button>
        <Button
          variant="secondary"
          type="button"
          onClick={() => {
            look.reset();
            setManualAccent(false);
            setBrandText(null);
          }}
        >
          Reset
        </Button>
        <Button tone="brand" busy={publishing} busyLabel="Publishing…" onClick={() => void publish()}>
          Publish look
        </Button>
      </header>

      <div className="grid grid-cols-1 gap-5 p-5 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)_minmax(0,360px)]">
        <div className="flex flex-col gap-4">
          <Panel title="Brand color" hint="Used for buttons, your logo mark and the cart.">
            <div className="flex flex-wrap items-center gap-2.5">
              {BRANDS.map((hex) => (
                <Swatch key={hex} hex={hex} label={`Brand ${hex}`} on={inputs.brand === hex} onPick={() => pickBrand(hex)} />
              ))}
            </div>
            <div className="flex items-center gap-2.5">
              <input type="color" aria-label="Pick any brand color" value={inputs.brand.toLowerCase()} onChange={(e) => pickBrand(e.target.value.toUpperCase())} className="size-11 cursor-pointer rounded-control border border-control-line bg-surface p-1" />
              <input
                aria-label="Brand hex"
                value={brandText ?? inputs.brand}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  setBrandText(v);
                  if (HEX.test(v)) set({ brand: normaliseHex(v) });
                }}
                onBlur={() => setBrandText(null)}
                className="h-11 w-32 rounded-control border border-control-line bg-surface px-3 font-mono text-[13px]"
              />
            </div>
          </Panel>

          <Panel
            title="Second color"
            hint="For sale badges and highlights."
            action={
              <Segmented
                label="Second color"
                value={accentManual ? 'manual' : 'auto'}
                options={[
                  { value: 'auto', label: 'Let Vendlyfy pick' },
                  { value: 'manual', label: 'I’ll pick' },
                ]}
                onChange={(v) => {
                  setManualAccent(v === 'manual');
                  set({ accent: v === 'manual' ? (inputs.accent ?? theme.colors.accent) : null });
                }}
              />
            }
          >
            {!accentManual ? (
              <div className="grid grid-cols-2 gap-2">
                {HARMONIES.map((h) => {
                  const t = compileTheme({ ...inputs, accent: null, harmony: h });
                  const strip = [t.colors.bg, t.colors.primary, t.colors.tint, t.colors.accent, t.colors.text];
                  return (
                    <button
                      key={h}
                      type="button"
                      aria-pressed={inputs.harmony === h}
                      onClick={() => set({ harmony: h })}
                      className={`flex flex-col gap-1.5 rounded-control bg-surface p-2.5 text-left ${inputs.harmony === h ? 'border-2 border-ink' : 'border border-line'}`}
                    >
                      <span className="flex h-5 overflow-hidden rounded-chip" aria-hidden="true">
                        {strip.map((hex, i) => (
                          <span key={i} className="grow" style={{ background: hex }} />
                        ))}
                      </span>
                      <span className="text-caption font-bold">{HARMONY_COPY[h].label}</span>
                      <span className="text-[12px] text-muted">{HARMONY_COPY[h].desc}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2.5">
                  {ACCENTS.map((hex) => (
                    <Swatch key={hex} hex={hex} label={`Second color ${hex}`} on={inputs.accent === hex} onPick={() => set({ accent: hex })} />
                  ))}
                  <input type="color" aria-label="Pick any second color" value={(inputs.accent ?? theme.colors.accent).toLowerCase()} onChange={(e) => set({ accent: e.target.value.toUpperCase() })} className="size-10 cursor-pointer rounded-control border border-control-line bg-surface p-1" />
                </div>
                {!clash ? null : (
                  <div className="rounded-control bg-status-warn p-2.5 text-caption text-status-warn-fg">
                    This is very close to your brand color, so sale badges won’t stand out.{' '}
                    <button
                      type="button"
                      onClick={() => {
                        setManualAccent(false);
                        set({ accent: null, harmony: 'complementary' });
                      }}
                      className="border-0 bg-transparent p-0 font-bold underline"
                    >
                      Use a matching contrast color
                    </button>
                  </div>
                )}
              </>
            )}
          </Panel>

          <Panel title="Personality">
            {groups.map((g) => (
              <div key={g.label} className="flex flex-col gap-1.5">
                <span className="text-caption font-semibold text-ink-2">{g.label}</span>
                <Segmented label={g.label} value={g.value} options={g.options} onChange={g.onChange} />
              </div>
            ))}
          </Panel>
        </div>

        <div className="flex flex-col items-center gap-2 overflow-x-auto">
          <StorePreview
            theme={theme}
            design={look.design}
            device="mobile"
            storeName={store.name}
            products={SAMPLE_PRODUCTS}
            categories={SAMPLE_CATEGORIES}
            cartTotal={`113,000 ${currency.code}`}
          />
          <span className="text-caption text-muted">Live preview · {store.slug}</span>
        </div>

        <div className="flex flex-col gap-4">
          <Panel title="Your generated theme" hint={`9 colors from your ${manualAccent || inputs.accent !== null ? '2 picks' : '1 pick'}, on a ${inputs.mood} page.`}>
            <div className="grid grid-cols-3 gap-2">
              {MERCHANT_VISIBLE_TOKENS.map(([token, label]) => (
                <div key={token} className="flex flex-col gap-1">
                  <span className="h-10 rounded-control border border-line" style={{ background: theme.colors[token] }} aria-hidden="true" />
                  <span className="text-[12px] font-semibold">{label}</span>
                  <span className="font-mono text-[11px] text-muted">{theme.colors[token]}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Readability">
            {theme.checks.map((c) => (
              <div key={c.label} className="flex items-center gap-2.5 text-caption">
                <span className="flex h-8 w-10 items-center justify-center rounded-chip font-bold" style={{ background: c.background, color: c.foreground }} aria-hidden="true">
                  Aa
                </span>
                <span className="grow font-semibold">{c.label}</span>
                <span className="tabular-nums text-muted">{c.ratio.toFixed(1)}:1</span>
                <span className={`rounded-pill px-2 py-[2px] text-[11px] font-bold ${c.pass ? 'bg-status-success text-status-success-fg' : 'bg-status-info text-status-info-fg'}`}>
                  {c.pass ? 'Pass' : c.satisfiedByOutline ? 'Outlined' : 'Fixed'}
                </span>
              </div>
            ))}
            <span className="text-[12px] text-muted">
              Text needs 4.5:1 against its background, buttons need 3:1 against the page. Vendlyfy adjusts automatically so no store can publish something unreadable.
            </span>
          </Panel>

          <Panel title="What Vendlyfy adjusted">
            {theme.notes.length === 0 ? (
              <div className="text-caption text-muted">Nothing. Your colors work exactly as picked.</div>
            ) : (
              theme.notes.map((n) => (
                <div key={n} className="rounded-control bg-status-info p-2.5 text-caption text-status-info-fg">
                  {n}
                </div>
              ))
            )}
          </Panel>
        </div>
      </div>

      {toast === null ? null : (
        <div className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}

function Panel({ title, hint, action, children }: { title: string; hint?: string; action?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="m-0 text-title">{title}</h2>
          {hint === undefined ? null : <span className="text-caption text-muted">{hint}</span>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A colour the merchant can pick. The ring is the board's: a white gap, then ink when chosen, a hairline when not. */
function Swatch({ hex, label, on, onPick }: { hex: string; label: string; on: boolean; onPick: () => void }): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      onClick={onPick}
      style={{ background: hex }}
      className={`size-10 rounded-pill border-[3px] border-white p-0 ${on ? '[box-shadow:0_0_0_2px_var(--color-ink)]' : '[box-shadow:0_0_0_1px_var(--color-control-line)]'}`}
    />
  );
}

