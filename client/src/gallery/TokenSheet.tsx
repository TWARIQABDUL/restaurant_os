/**
 * The token sheet — milestone 4's visual proof, and where milestone 14's UI kit
 * gallery lands.
 *
 * Everything below is built from the closed token set in ../styles/tokens.css and
 * nothing else. There is no @apply and no semantic class: if a utility used here
 * does not exist, the token is missing, which is the point of rendering it.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { applyStoreTheme, readStoreTheme, STORE_TOKEN_NAMES } from '../styles/store-theme.ts';
import type { StoreTheme, StoreTokenName } from '../styles/store-theme.ts';

/* --------------------------------------------------------------------------
   Fixtures, not a compiler.
   --------------------------------------------------------------------------
   Milestone 13 builds the theme engine: eight inputs to these nine values, with
   contrast enforcement. Until then these are LITERAL token sets, so that nothing
   here derives a colour and then has to agree with the engine later.
   Each is one of the canvas's brand presets (project/Main.dc.html). In the light
   mood the neutrals do not move — "Neutrals carry the interface. Only the brand
   color changes per store." — so only the last four differ. `tint` is the
   canvas's published mix, round(channel * 0.12 + 255 * 0.88) per channel.
   -------------------------------------------------------------------------- */
const NEUTRAL = {
  bg: '#F6F5F1',
  surface: '#FFFFFF',
  text: '#17160F',
  muted: '#5F5C53',
  border: '#E5E2DA',
  onPrimary: '#FFFFFF',
} as const;

const FIXTURES: readonly { readonly label: string; readonly theme: StoreTheme }[] = [
  { label: 'Platform default', theme: { ...NEUTRAL, primary: '#1D6B47', accent: '#1D6B47', tint: '#E4EDE9' } },
  { label: 'Ember', theme: { ...NEUTRAL, primary: '#C2410C', accent: '#C2410C', tint: '#F8E8E2' } },
  { label: 'Deep blue', theme: { ...NEUTRAL, primary: '#1F437F', accent: '#1F437F', tint: '#E4E8F0' } },
  { label: 'Plum', theme: { ...NEUTRAL, primary: '#9D174D', accent: '#9D174D', tint: '#F3E3EA' } },
  { label: 'Ink', theme: { ...NEUTRAL, primary: '#17160F', accent: '#17160F', tint: '#E3E3E2' } },
];

const NEUTRALS: readonly { readonly name: string; readonly hex: string; readonly klass: string }[] = [
  { name: 'Ink', hex: '#17160F', klass: 'bg-ink' },
  { name: 'Ink 2', hex: '#3B3A33', klass: 'bg-ink-2' },
  { name: 'Muted', hex: '#5F5C53', klass: 'bg-muted' },
  { name: 'Disabled', hex: '#A8A499', klass: 'bg-disabled' },
  { name: 'Control line', hex: '#CFCBC1', klass: 'bg-control-line' },
  { name: 'Line', hex: '#E5E2DA', klass: 'bg-line' },
  { name: 'Line subtle', hex: '#EFEDE7', klass: 'bg-line-subtle' },
  { name: 'Ground', hex: '#F6F5F1', klass: 'bg-ground' },
  { name: 'Surface', hex: '#FFFFFF', klass: 'bg-surface' },
];

const STATUSES: readonly { readonly name: string; readonly bg: string; readonly fg: string }[] = [
  { name: 'Neutral', bg: 'bg-status-neutral', fg: 'text-status-neutral-fg' },
  { name: 'Warn', bg: 'bg-status-warn', fg: 'text-status-warn-fg' },
  { name: 'Danger', bg: 'bg-status-danger', fg: 'text-status-danger-fg' },
  { name: 'Success', bg: 'bg-status-success', fg: 'text-status-success-fg' },
  { name: 'Info', bg: 'bg-status-info', fg: 'text-status-info-fg' },
];

const TYPE: readonly { readonly name: string; readonly spec: string; readonly klass: string; readonly sample: string }[] = [
  { name: 'Display', spec: '40/44 · 700', klass: 'font-display text-display', sample: 'Nyama & Co.' },
  { name: 'Heading', spec: '24/30 · 700', klass: 'font-display text-heading', sample: 'Grilled chicken' },
  { name: 'Title', spec: '17/24 · 600', klass: 'text-title', sample: 'Chicken burger' },
  { name: 'Body', spec: '15/22 · 400', klass: 'text-body', sample: 'Flame-grilled, brioche bun, house sauce.' },
  { name: 'Caption', spec: '13/18 · 500', klass: 'text-caption', sample: 'Ready in 20 minutes' },
  { name: 'Mono', spec: '13 · 500', klass: 'font-mono text-mono', sample: '#ORD-10293 · SKU TS-BLK-M' },
];

const SPACES: readonly { readonly step: string; readonly px: number; readonly klass: string }[] = [
  { step: 'p-1', px: 4, klass: 'w-1' },
  { step: 'p-2', px: 8, klass: 'w-2' },
  { step: 'p-3', px: 12, klass: 'w-3' },
  { step: 'p-4', px: 16, klass: 'w-4' },
  { step: 'p-6', px: 24, klass: 'w-6' },
  { step: 'p-8', px: 32, klass: 'w-8' },
  { step: 'p-12', px: 48, klass: 'w-12' },
  { step: 'p-16', px: 64, klass: 'w-16' },
];

const RADII: readonly { readonly name: string; readonly klass: string }[] = [
  { name: '8 · chips', klass: 'rounded-chip' },
  { name: '10 · controls', klass: 'rounded-control' },
  { name: '14 · cards', klass: 'rounded-card' },
  { name: '20 · sheets', klass: 'rounded-sheet' },
  { name: 'pill · badges', klass: 'rounded-pill' },
];

function Panel({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="bg-surface border border-line rounded-card p-6">
      <h2 className="m-0 text-caption uppercase tracking-[0.08em] text-muted">{title}</h2>
      {note !== undefined && <p className="mt-2 mb-4 text-caption text-ink-2">{note}</p>}
      <div className={note === undefined ? 'mt-3' : ''}>{children}</div>
    </section>
  );
}

export function TokenSheet() {
  const [fixture, setFixture] = useState(0);
  const previewRef = useRef<HTMLDivElement>(null);
  const [inEffect, setInEffect] = useState<StoreTheme | null>(null);

  const chosen = FIXTURES[fixture] ?? FIXTURES[0];

  useEffect(() => {
    const node = previewRef.current;
    if (node === null || chosen === undefined) return;
    // The plumbing under test: nine custom properties onto a SUBTREE, not :root.
    // It works because tokens.css declares them with `@theme inline`.
    applyStoreTheme(chosen.theme, node);
    setInEffect(readStoreTheme(node));
  }, [chosen]);

  return (
    <main className="mx-auto max-w-[1440px] px-4 py-12 md:px-16 flex flex-col gap-7">
      <header>
        <span className="text-caption uppercase tracking-[0.08em] text-muted font-semibold">
          Vendlyfy · L0 token layer
        </span>
        <h1 className="mt-2 mb-0 font-display text-display max-w-[820px]">
          One set of parts. Every kind of shop.
        </h1>
        <p className="mt-3 mb-0 text-title font-normal text-ink-2 max-w-[820px]">
          Every value below comes from the design canvas. The token set is closed — Tailwind&rsquo;s own
          palette, radii and type sizes are cleared in <code className="font-mono text-mono">tokens.css</code>,
          so an off-design value is a build error rather than a review comment.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Color · fixed neutrals" note="Neutrals carry the interface. Only the brand colour changes per store.">
          <div className="flex flex-wrap gap-3">
            {NEUTRALS.map((c) => (
              <div key={c.name} className="flex flex-col gap-1 items-center">
                <span className={`${c.klass} w-11 h-11 rounded-control border border-control-line`} />
                <span className="text-caption font-semibold">{c.name}</span>
                <span className="font-mono text-mono text-muted">{c.hex}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Status · not themeable" note="A “Paid” badge means the same thing in every store, so the theme engine cannot reach these.">
          <div className="flex flex-col gap-2">
            {STATUSES.map((s) => (
              <div key={s.name} className="flex items-center gap-3">
                <span className={`${s.bg} ${s.fg} rounded-pill px-3 py-1 text-caption font-semibold`}>
                  {s.name}
                </span>
                <span className="text-caption text-muted">{s.bg} · {s.fg}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Typography" note="Bricolage Grotesque for display, Figtree for everything you read, JetBrains Mono for codes.">
          <div className="flex flex-col">
            {TYPE.map((t) => (
              <div key={t.name} className="flex items-baseline gap-3 py-2 border-t border-line-subtle first:border-t-0">
                <span className="w-20 shrink-0 text-caption text-muted">
                  {t.name}
                  <br />
                  {t.spec}
                </span>
                <span className={`${t.klass} min-w-0 truncate`}>{t.sample}</span>
              </div>
            ))}
          </div>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title="Spacing · 4-point">
            <div className="flex items-end gap-2">
              {SPACES.map((s) => (
                <div key={s.step} className="flex flex-col items-center gap-1">
                  <span className={`${s.klass} h-6 bg-store-tint border border-control-line rounded-[3px]`} />
                  <span className="text-caption text-muted">{s.px}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Radius">
            <div className="flex gap-3">
              {RADII.map((r) => (
                <div key={r.name} className="flex flex-col items-center gap-1">
                  <span className={`${r.klass} w-14 h-14 bg-surface border border-control-line`} />
                  <span className="text-caption text-muted">{r.name}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Elevation" note="Flat on borders. Shadow only for things that float.">
            <div className="flex gap-3 p-3 bg-ground rounded-control">
              <span className="flex-1 h-14 rounded-control bg-surface border border-line grid place-items-center text-caption text-ink-2">
                0 · border
              </span>
              <span className="flex-1 h-14 rounded-control bg-surface shadow-menu grid place-items-center text-caption text-ink-2">
                1 · menus
              </span>
              <span className="flex-1 h-14 rounded-control bg-surface shadow-sheet grid place-items-center text-caption text-ink-2">
                2 · sheets
              </span>
            </div>
          </Panel>
        </div>
      </div>

      {/* ------------------------------------------------------------------
          The nine per-store tokens, applied to a subtree.
          ------------------------------------------------------------------ */}
      <Panel
        title="The nine per-store tokens"
        note="Switching a fixture writes nine custom properties onto the panel below — not onto :root. Everything outside it keeps the platform default, which is what StorePreview and ThemeStudio's live preview need."
      >
        <div className="flex flex-wrap gap-2 mb-4" role="radiogroup" aria-label="Theme fixture">
          {FIXTURES.map((f, i) => (
            <button
              key={f.label}
              type="button"
              role="radio"
              aria-checked={i === fixture}
              onClick={() => setFixture(i)}
              className={`h-10 px-4 rounded-chip text-caption font-semibold border ${
                i === fixture ? 'border-ink bg-ground' : 'border-control-line bg-surface'
              }`}
            >
              <span
                className="inline-block w-3 h-3 rounded-pill mr-2 align-middle"
                style={{ background: f.theme.primary }}
              />
              {f.label}
            </button>
          ))}
        </div>

        <div ref={previewRef} className="bg-store-bg border border-store-border rounded-card p-6 flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-4">
            <span className="font-display text-heading text-store-text">Nyama &amp; Co.</span>
            <span className="text-caption text-store-muted">A themed subtree</span>
          </div>
          <div className="bg-store-surface border border-store-border rounded-card p-4 flex flex-col gap-3">
            <span className="text-title text-store-text">Chicken burger</span>
            <span className="text-body text-store-muted">Flame-grilled, brioche bun, house sauce.</span>
            <div className="flex gap-2 items-center">
              <button type="button" className="h-11 px-4 rounded-control bg-store-primary text-store-on-primary text-body font-semibold">
                Add to cart
              </button>
              <span className="h-11 px-4 rounded-control bg-store-tint text-store-text text-body font-semibold grid place-items-center">
                Selected
              </span>
              <span className="text-caption font-semibold text-store-accent">Highlight</span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {STORE_TOKEN_NAMES.map((name: StoreTokenName) => (
              <span key={name} className="flex items-center gap-2 text-caption text-store-muted">
                <span
                  className="w-4 h-4 rounded-[3px] border border-store-border shrink-0"
                  style={{ background: inEffect?.[name] ?? 'transparent' }}
                />
                <span className="font-mono text-mono truncate">
                  {name} {inEffect?.[name] ?? '—'}
                </span>
              </span>
            ))}
          </div>
        </div>
      </Panel>

      <footer className="text-caption text-muted">
        Read back through <code className="font-mono text-mono">readStoreTheme()</code>, so the swatches above are
        the values the cascade actually resolved — not the fixture echoed back.
      </footer>
    </main>
  );
}
