// client/src/console/lookDraft.ts — milestone 25.
//
// ONE DRAFT, TWO SCREENS. ThemeStudio edits the palette's eight inputs and Customize edits layout, sections and logo, but
// both are views of the same thing — "the look" — saved as one draft and published by one button. This hook is that
// thing: it loads the draft (falling back to what is live, then to the defaults), keeps it in state, saves it a moment
// after each change, and publishes it.
//
// EVERY SAVE CARRIES BOTH HALVES. The server treats an absent `design` as "leave it as it is" (storeTheme.ts), which
// would be enough — but a screen that sends what it is showing can never overwrite the other's change with a stale
// copy of something it did not load.
//
// THE PREVIEW IS COMPILED HERE, NOT FETCHED. compileTheme() is isomorphic and the same function the server publishes
// with, so what the studio shows is what publishing will produce — the point of putting the compiler in packages/core.
// A save is therefore not on the preview's critical path: the picture moves the instant a swatch is tapped.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiFailure } from '../app/api.ts';
import { DEFAULT_DESIGN, compileTheme } from '../app/core.ts';
import type { CompiledTheme, Design, ThemeInputs } from '../app/core.ts';
import { lookApi } from './api.ts';
import type { LookPayload } from './api.ts';

/** What a store that has never opened the studio starts from: ThemeStudio's own defaults, in the platform's green. */
export const DEFAULT_INPUTS: ThemeInputs = {
  brand: '#1D6B47',
  accent: null,
  harmony: 'complementary',
  mood: 'light',
  shape: 'soft',
  headingFont: 'modern',
  cardTreatment: 'outlined',
  hero: 'soft',
};

export type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export type LookDraft = {
  ready: boolean;
  loadError: string | null;
  inputs: ThemeInputs;
  design: Design;
  setInputs: (next: ThemeInputs | ((prev: ThemeInputs) => ThemeInputs)) => void;
  setDesign: (next: Design | ((prev: Design) => Design)) => void;
  /** The palette the inputs compile to, right now. */
  theme: CompiledTheme;
  save: SaveState;
  /** True when the draft differs from what is live — "you have changes to publish". */
  unpublished: boolean;
  /** Everything is live and nothing has ever been published: the platform default is showing. */
  neverPublished: boolean;
  publish: () => Promise<{ ok: true } | { ok: false; message: string }>;
  /** Discards the draft and goes back to what is live (or the defaults). */
  reset: () => void;
  reload: () => void;
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function useLookDraft(storeId: string, initial?: { inputs: ThemeInputs; design: Design }): LookDraft {
  const [loaded, setLoaded] = useState<LookPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inputs, setInputsState] = useState<ThemeInputs>(initial?.inputs ?? DEFAULT_INPUTS);
  const [design, setDesignState] = useState<Design>(initial?.design ?? DEFAULT_DESIGN);
  const [ready, setReady] = useState(initial !== undefined);
  const [save, setSave] = useState<SaveState>('idle');
  const [attempt, setAttempt] = useState(0);
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (initial !== undefined) return;
    let live = true;
    void lookApi
      .load(storeId)
      .then((payload) => {
        if (!live) return;
        setLoaded(payload);
        setInputsState((payload.draft ?? payload.published)?.inputs ?? DEFAULT_INPUTS);
        setDesignState(pickDesign(payload));
        setReady(true);
        setLoadError(null);
      })
      .catch((cause: unknown) => {
        if (live) setLoadError(cause instanceof ApiFailure ? cause.message : 'Your store’s look could not be loaded.');
      });
    return () => {
      live = false;
    };
    // `initial` is a testing seam read once; the store and an explicit reload are what re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, attempt]);

  // Save a moment after the last change — not on every keystroke of a hex field, and not on first paint.
  useEffect(() => {
    if (!dirty.current) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    setSave('saving');
    timer.current = window.setTimeout(() => {
      lookApi
        .saveDraft(storeId, inputs, design)
        .then(() => setSave('saved'))
        .catch(() => setSave('failed'));
    }, 700);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [inputs, design, storeId]);

  const setInputs = useCallback((next: ThemeInputs | ((prev: ThemeInputs) => ThemeInputs)) => {
    dirty.current = true;
    setInputsState(next);
  }, []);
  const setDesign = useCallback((next: Design | ((prev: Design) => Design)) => {
    dirty.current = true;
    setDesignState(next);
  }, []);

  const theme = useMemo(() => compileTheme(inputs), [inputs]);

  const publish = useCallback(async (): Promise<{ ok: true } | { ok: false; message: string }> => {
    try {
      if (timer.current !== null) window.clearTimeout(timer.current);
      await lookApi.publish(storeId, inputs, design);
      dirty.current = false;
      setSave('saved');
      setAttempt((n) => n + 1);
      return { ok: true };
    } catch (cause) {
      return { ok: false, message: cause instanceof ApiFailure ? cause.message : 'That could not be published.' };
    }
  }, [storeId, inputs, design]);

  const reset = useCallback(() => {
    dirty.current = true;
    setInputsState(loaded?.published?.inputs ?? DEFAULT_INPUTS);
    setDesignState(loaded?.design.published ?? DEFAULT_DESIGN);
  }, [loaded]);

  const live = loaded?.published ?? null;
  const liveDesign = loaded?.design.published ?? null;
  const unpublished = live === null ? true : !same(live.inputs, inputs) || !same(stripDesign(liveDesign ?? DEFAULT_DESIGN), stripDesign(design));

  return {
    ready,
    loadError,
    inputs,
    design,
    setInputs,
    setDesign,
    theme,
    save,
    unpublished,
    neverPublished: live === null,
    publish,
    reset,
    reload: () => setAttempt((n) => n + 1),
  };
}

const stripDesign = (d: Design): Design => ({ productLayout: d.productLayout, sections: d.sections, logoUrl: d.logoUrl });

function pickDesign(p: LookPayload): Design {
  const d = p.design.draft ?? p.design.published ?? p.design.defaults;
  return stripDesign(d);
}
