// client/src/onboarding/Onboarding.tsx — milestone 26, from project/Onboarding.dc.html.
//
// "Create your store", in the board's four steps with ONE ADDED: Your account. The board starts at the business and assumes
// the person already has an account; nothing in the new system made one, so the account step sits second — after the
// business (so the first screen is the board's) and before anything is written (so a person who changes their mind loses
// nothing). The store and the account are created together at the end of that step, in one transaction, and the person is
// signed in by the same response.
//
// FROM THEN ON THE STEPS ARE THE REAL SCREENS' ENDPOINTS: "Look and feel" is Customize's draft (lookDraft.ts), "First
// product" is the Products editor's own create call. There is no onboarding-only way to write a theme or a product, so there
// is nothing here to drift from the real ones.
//
// WHAT IS NOT BUILT, deliberately: the board's "Banner photo — optional". The storefront has a logo and a colour (M25's
// design) and no banner image, so an upload box that stored a picture nothing displays would be a promise this screen cannot
// keep. It arrives with whatever gives the storefront a banner.

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, TextField } from '../shared/ui/index.ts';
import { categoriesApi, lookApi, productsApi } from '../console/api.ts';
import type { ProductDoc } from '../console/api.ts';
import { useLookDraft } from '../console/lookDraft.ts';
import { StorePreview } from '../console/StorePreview.tsx';
import { SAMPLE_CATEGORIES, SAMPLE_PRODUCTS } from '../console/StorePreview.tsx';
import { onboardingApi } from './api.ts';
import type { Industry } from './api.ts';
import { BRAND_COLORS, OTHER, STEPS, accountProblem, businessReady, cleanPrice, whatFor } from './lines.ts';
import type { AccountDraft, Step } from './lines.ts';

type Props = {
  navigate: (to: string) => void;
  /** The render gate's seam: effects do not run in static markup. */
  initial?: { step?: Step; industries?: Industry[]; business?: { name: string; industry: string | null; slug: string }; created?: { storeId: string; slug: string } };
};

const reason = (cause: unknown, fallback: string): string => (cause instanceof ApiFailure ? cause.message : fallback);

export function Onboarding({ navigate, initial }: Props): ReactNode {
  const [step, setStep] = useState<Step>(initial?.step ?? 0);
  const [industries, setIndustries] = useState<Industry[] | null>(initial?.industries ?? null);
  const [name, setName] = useState(initial?.business?.name ?? '');
  const [industry, setIndustry] = useState<string | null>(initial?.business?.industry ?? null);
  const [slug, setSlug] = useState<{ slug: string; available: boolean }>({ slug: initial?.business?.slug ?? '', available: initial?.business !== undefined });
  const [account, setAccount] = useState<AccountDraft>({ name: '', email: '', phone: '', password: '' });
  const [created, setCreated] = useState<{ storeId: string; slug: string } | null>(initial?.created ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailTaken, setEmailTaken] = useState(false);
  const seeded = useRef(initial !== undefined);

  useEffect(() => {
    if (seeded.current) return;
    void onboardingApi.templates().then((r) => setIndustries(r.templates)).catch(() => setIndustries([]));
  }, []);

  // The address follows the name, a moment after the last keystroke — not one request per letter.
  useEffect(() => {
    if (seeded.current) return;
    if (name.trim().length < 2) {
      setSlug({ slug: '', available: false });
      return;
    }
    const id = window.setTimeout(() => {
      void onboardingApi.slug(name).then(setSlug).catch(() => setSlug({ slug: '', available: false }));
    }, 350);
    return () => window.clearTimeout(id);
  }, [name]);

  const tiles: { key: string; name: string }[] = [...(industries ?? []).map((i) => ({ key: i.key, name: i.name })), { key: OTHER, name: 'Other' }];
  const what = whatFor(industry);
  const templateKey = industry === null || industry === OTHER ? null : industry;

  const createStore = async (): Promise<void> => {
    const problem = accountProblem(account);
    if (problem !== null) return setError(problem);
    setBusy(true);
    setError(null);
    setEmailTaken(false);
    try {
      const r = await onboardingApi.create({
        name: account.name.trim(),
        email: account.email.trim(),
        ...(account.phone.trim() === '' ? {} : { phone: account.phone.trim() }),
        password: account.password,
        businessName: name.trim(),
        slug: slug.slug,
        templateKey,
      });
      setCreated({ storeId: r.storeId, slug: r.slug });
      setStep(2);
    } catch (cause) {
      if (cause instanceof ApiFailure && cause.code === 'EMAIL_TAKEN') setEmailTaken(true);
      if (cause instanceof ApiFailure && cause.code === 'SLUG_TAKEN') {
        setStep(0);
        setSlug((s) => ({ ...s, available: false }));
      }
      setError(reason(cause, 'We couldn’t create your store. Check your connection and try again.'));
    } finally {
      setBusy(false);
    }
  };

  const blocked = step === 0 && !businessReady(name, industry, slug.available);

  return (
    <div className="flex min-h-dvh flex-col bg-ground text-ink lg:flex-row">
      <aside className="flex shrink-0 flex-col gap-6 bg-ink px-6 py-6 text-ground lg:w-[340px] lg:gap-10 lg:px-9 lg:py-10">
        <div className="flex items-center gap-2.5">
          <span aria-hidden="true" className="flex size-[30px] items-center justify-center rounded-chip bg-ground font-display font-bold text-ink">
            V
          </span>
          <span className="font-display text-[22px] font-bold">Vendlyfy</span>
        </div>
        <ol className="m-0 flex list-none gap-3 overflow-x-auto p-0 lg:flex-col lg:gap-[22px]" aria-label="Steps">
          {STEPS.map((label, i) => {
            const done = i < step;
            const now = i === step;
            return (
              <li key={label} aria-current={now ? 'step' : undefined} className="flex shrink-0 items-center gap-3.5">
                <span aria-hidden="true" className={`flex size-8 items-center justify-center rounded-pill text-body font-bold ${done ? 'bg-ground text-ink' : now ? 'border-2 border-ground text-ground' : 'border-2 border-muted text-disabled'}`}>
                  {done ? '✓' : i + 1}
                </span>
                <span className={`text-[16px] ${now ? 'font-bold text-white' : done ? 'text-ground' : 'text-disabled'} ${now ? '' : 'max-lg:hidden'}`}>{label}</span>
              </li>
            );
          })}
        </ol>
        <p className="m-0 text-body text-on-ink-muted max-lg:hidden lg:mt-auto">Takes about 3 minutes. You can change everything later.</p>
      </aside>

      <main className="flex grow flex-col gap-5 px-5 py-8 lg:px-16 lg:py-12">
        {error === null ? null : (
          <Alert tone="danger" headline={error}>
            {emailTaken ? (
              <Button variant="secondary" onClick={() => navigate('/signin')}>
                Sign in instead
              </Button>
            ) : null}
          </Alert>
        )}

        {step === 0 ? (
          <div className="flex max-w-[640px] flex-col gap-5">
            <div>
              <h1 className="m-0 font-display text-[34px] leading-tight">Create your store</h1>
              <p className="m-0 mt-1.5 text-muted">Tell us about your business. We set up the right tools for it.</p>
            </div>
            <TextField label="Business name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nyama & Co." maxLength={80} autoComplete="organization" />
            <fieldset className="m-0 border-0 p-0">
              <legend className="mb-2 p-0 text-body font-semibold">What do you sell?</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {industries === null ? <span className="col-span-full text-caption text-muted">Loading…</span> : null}
                {tiles.map((t) => (
                  <button key={t.key} type="button" aria-pressed={industry === t.key} onClick={() => setIndustry(t.key)} className={`h-14 rounded-card px-2 text-body font-semibold ${industry === t.key ? 'border border-ink bg-ink text-white' : 'border border-control-line bg-surface text-ink'}`}>
                    {t.name}
                  </button>
                ))}
              </div>
            </fieldset>
            {industry === null ? null : (
              <div className="rounded-card bg-brand-tint p-3.5 text-body text-brand-strong">
                <strong>We’ll set up:</strong> {what.sets}
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="ob-url" className="text-body font-semibold">
                Store address
              </label>
              <div className="flex h-12 overflow-hidden rounded-control border border-control-line bg-surface">
                <span className="flex items-center bg-ground px-3.5 text-muted">{typeof window === 'undefined' ? '' : window.location.host}/</span>
                <input id="ob-url" value={slug.slug} readOnly className="min-w-0 grow border-0 bg-transparent px-3.5 text-[16px]" />
              </div>
              <span className={`text-caption ${slug.available ? 'text-status-success-fg' : 'text-muted'}`}>
                {name.trim().length < 2 ? 'Fills in from your business name' : slug.available ? `${slug.slug} is available` : 'Use letters or numbers in the name to get an address'}
              </span>
            </div>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="flex max-w-[640px] flex-col gap-4">
            <div>
              <h1 className="m-0 font-display text-[34px] leading-tight">Your account</h1>
              <p className="m-0 mt-1.5 text-muted">You’ll sign in with this to manage {name.trim() === '' ? 'your store' : name.trim()}.</p>
            </div>
            <TextField label="Your name" value={account.name} onChange={(e) => setAccount({ ...account, name: e.target.value })} autoComplete="name" maxLength={120} />
            <TextField label="Email" type="email" value={account.email} onChange={(e) => setAccount({ ...account, email: e.target.value })} autoComplete="email" />
            <TextField label="Phone (optional)" inputMode="tel" value={account.phone} onChange={(e) => setAccount({ ...account, phone: e.target.value })} autoComplete="tel" placeholder="078 123 4567" />
            <TextField label="Password" type="password" value={account.password} onChange={(e) => setAccount({ ...account, password: e.target.value })} autoComplete="new-password" hint="At least 10 characters." />
            <p className="m-0 text-caption text-muted">
              Already have an account?{' '}
              <a href="/signin" onClick={(e) => { e.preventDefault(); navigate('/signin'); }} className="font-semibold">
                Sign in
              </a>
            </p>
          </div>
        ) : null}

        {step === 2 && created !== null ? <LookStep storeId={created.storeId} storeName={name} onDone={() => setStep(3)} /> : null}

        {step === 3 && created !== null ? (
          <ProductStep
            storeId={created.storeId}
            industry={industry}
            onDone={() => setStep(4)}
          />
        ) : null}

        {step === 4 ? (
          <div className="my-auto flex max-w-[560px] flex-col gap-4">
            <span aria-hidden="true" className="flex size-16 items-center justify-center rounded-pill bg-brand text-white">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </span>
            <h1 className="m-0 font-display text-[40px] leading-[1.1]">Your store is ready</h1>
            <p className="m-0 text-[17px] text-muted">
              {name.trim() || 'Your store'} is live at <strong className="text-ink">{typeof window === 'undefined' ? '' : window.location.host}/{created?.slug ?? slug.slug}</strong>. Share the link on WhatsApp or Instagram to get your first order.
            </p>
            <div className="mt-2 flex flex-wrap gap-3">
              <Button variant="secondary" onClick={() => navigate(`/${created?.slug ?? slug.slug}`)}>
                View store
              </Button>
              <Button tone="brand" onClick={() => navigate(`/app/${created?.slug ?? slug.slug}`)}>
                Go to dashboard
              </Button>
            </div>
          </div>
        ) : null}

        {step < 2 ? (
          <div className="mt-auto flex max-w-[940px] items-center justify-between pt-6">
            <Button variant="text" disabled={step === 0} onClick={() => { setError(null); setStep(0); }}>
              Back
            </Button>
            <Button tone="brand" disabled={blocked} busy={busy} busyLabel="Creating your store…" onClick={() => { setError(null); if (step === 0) setStep(1); else void createStore(); }}>
              {step === 0 ? 'Continue' : 'Create my store'}
            </Button>
          </div>
        ) : null}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Look and feel
// ---------------------------------------------------------------------------

function LookStep({ storeId, storeName, onDone }: { storeId: string; storeName: string; onDone: () => void }): ReactNode {
  const look = useLookDraft(storeId);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const file = useRef<HTMLInputElement | null>(null);

  const upload = async (f: File | undefined): Promise<void> => {
    if (f === undefined) return;
    setProblem(null);
    try {
      const { url } = await lookApi.uploadLogo(storeId, f);
      look.setDesign((d) => ({ ...d, logoUrl: url }));
    } catch (cause) {
      setProblem(reason(cause, 'That logo could not be uploaded. Use a JPEG, PNG or WebP photo under 5 MB.'));
    }
  };

  // "Continue" publishes first: what the merchant chose is live before they see the next step, so the store they are about
  // to share already looks like theirs.
  const next = async (): Promise<void> => {
    setBusy(true);
    const r = await look.publish();
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    onDone();
  };

  return (
    <LookLayout
      ready={look.ready}
      error={look.loadError}
      problem={problem}
      color={look.inputs.brand}
      onColor={(hex) => look.setInputs((p) => ({ ...p, brand: hex }))}
      logoUrl={look.design.logoUrl}
      onPickLogo={() => file.current?.click()}
      onRemoveLogo={() => look.setDesign((d) => ({ ...d, logoUrl: null }))}
      preview={<StorePreview theme={look.theme} design={look.design} device="mobile" storeName={storeName.trim() || 'Your store'} products={SAMPLE_PRODUCTS} categories={SAMPLE_CATEGORIES} cartTotal="0" />}
      fileInput={<input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />}
      action={
        <Button tone="brand" busy={busy} busyLabel="Saving…" disabled={!look.ready} onClick={() => void next()}>
          Continue
        </Button>
      }
    />
  );
}

export function LookLayout(p: {
  ready: boolean;
  error: string | null;
  problem: string | null;
  color: string;
  onColor: (hex: string) => void;
  logoUrl: string | null;
  onPickLogo: () => void;
  onRemoveLogo: () => void;
  preview: ReactNode;
  fileInput: ReactNode;
  action: ReactNode;
}): ReactNode {
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex max-w-[640px] flex-col gap-5">
        <div>
          <h1 className="m-0 font-display text-[34px] leading-tight">Make it yours</h1>
          <p className="m-0 mt-1.5 text-muted">Add your logo and pick a color. The preview updates as you go.</p>
        </div>
        {p.error === null ? null : <Alert tone="danger" headline={p.error} />}
        {p.problem === null ? null : <Alert tone="danger" headline={p.problem} />}
        {p.fileInput}
        <div className="flex gap-4">
          <button type="button" onClick={p.onPickLogo} className="flex size-[120px] flex-col items-center justify-center gap-1 overflow-hidden rounded-card border-2 border-dashed border-control-line bg-surface text-body font-semibold">
            {p.logoUrl === null ? (
              <>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />
                </svg>
                Logo
              </>
            ) : (
              <img src={p.logoUrl} alt="Your logo" className="size-full object-contain" />
            )}
          </button>
          {p.logoUrl === null ? null : (
            <Button variant="text" tone="brand" onClick={p.onRemoveLogo}>
              Remove logo
            </Button>
          )}
        </div>
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-2.5 p-0 text-body font-semibold">Brand color</legend>
          <div className="flex items-center gap-2.5">
            {BRAND_COLORS.map((c) => (
              <button
                key={c.hex}
                type="button"
                aria-label={c.name}
                aria-pressed={p.color.toLowerCase() === c.hex.toLowerCase()}
                onClick={() => p.onColor(c.hex)}
                style={{ background: c.hex }}
                className={`size-11 rounded-pill border-[3px] border-white p-0 ${p.color.toLowerCase() === c.hex.toLowerCase() ? '[box-shadow:0_0_0_2px_var(--color-ink)]' : '[box-shadow:0_0_0_1px_var(--color-control-line)]'}`}
              />
            ))}
            <span className="ml-2 font-mono text-body text-muted">{p.color}</span>
          </div>
        </fieldset>
        <div className="mt-2 flex justify-end">{p.action}</div>
      </div>
      <div className="origin-top-left max-lg:hidden" style={{ width: 300, height: 560 }}>
        <div style={{ transform: 'scale(0.77)', transformOrigin: 'top left', width: 390 }}>{p.preview}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// First product
// ---------------------------------------------------------------------------

function ProductStep({ storeId, industry, onDone }: { storeId: string; industry: string | null; onDone: () => void }): ReactNode {
  const what = whatFor(industry);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement | null>(null);

  const add = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      let categoryIds: string[] = [];
      const label = category.trim() === '' ? what.category : category.trim();
      const made = await categoriesApi.create(storeId, label);
      const row = made.categories.find((c) => c.name === label);
      if (row !== undefined) categoryIds = [row.id];
      const doc: ProductDoc = { name: name.trim(), description: description.trim(), price, compareAtPrice: null, status: 'active', categoryIds, images: photo === null ? [] : [photo], trackStock: false, sku: null, stock: null, groups: [], variants: [] };
      await productsApi.create(storeId, doc);
      onDone();
    } catch (cause) {
      setError(reason(cause, 'That product could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex max-w-[640px] flex-col gap-4">
      <div>
        <h1 className="m-0 font-display text-[34px] leading-tight">Add your first product</h1>
        <p className="m-0 mt-1.5 text-muted">Just the basics. Options like {what.hint} can be added right after.</p>
      </div>
      {error === null ? null : <Alert tone="danger" headline={error} />}
      <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f !== undefined) void productsApi.uploadPhoto(storeId, f).then((r) => setPhoto(r.url)).catch((c: unknown) => setError(reason(c, 'That photo could not be uploaded.'))); }} />
      <div className="flex gap-4">
        <button type="button" onClick={() => file.current?.click()} className="flex size-[140px] shrink-0 items-center justify-center overflow-hidden rounded-card border-2 border-dashed border-control-line bg-surface text-body font-semibold">
          {photo === null ? 'Add photo' : <img src={photo} alt="Product" className="size-full object-cover" />}
        </button>
        <div className="flex grow flex-col gap-3">
          <TextField label="Product name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`e.g. ${what.product}`} maxLength={120} />
          <div className="grid grid-cols-2 gap-3">
            <TextField label="Price (RWF)" inputMode="numeric" value={price} onChange={(e) => setPrice(cleanPrice(e.target.value))} placeholder="0" />
            <TextField label="Category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder={what.category} maxLength={60} />
          </div>
        </div>
      </div>
      <TextField label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line customers will see" maxLength={300} />
      <div className="mt-2 flex justify-end gap-2.5">
        <Button variant="text" onClick={onDone}>
          Skip for now
        </Button>
        <Button tone="brand" busy={busy} busyLabel="Adding…" disabled={name.trim() === '' || price === '' || Number(price) <= 0} onClick={() => void add()}>
          Add product
        </Button>
      </div>
    </div>
  );
}
