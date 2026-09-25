// server/src/routes/storeConfig.ts — milestone 12.
//
// The two things a merchant may change about their configuration, and nothing else.
//
//   GET   /api/stores/:storeId/config/templates   the business types on offer
//   PUT   /api/stores/:storeId/config/template    switch business type
//   PATCH /api/stores/:storeId/config/overrides   rename a word, switch a module
//
// Both writes are `settings.write`, which is the permission Auth's invite screen describes a
// manager as not having: "can't see payouts, the wallet or store settings". Reading the
// resolved config needs no permission at all and lives in storefrontConfig.ts.
//
// V002 ALREADY REFUSES EVERY INVALID SHAPE at the column — stores_assert_valid_overrides
// checks the sections, the word keys, the boolean types and that a module exists; the pin
// trigger refuses an unpublished version. This file validates the same things first, for the
// reason api/validate.ts gives: the database's message is written for whoever broke an
// invariant, and a merchant renaming a word deserves a sentence about the word. The database
// stays the authority; these are better errors, not the real check.

import { Router } from 'express';
import { badRequest, notFound, withTransaction } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { bodyOf, requiredString } from '../api/validate.ts';
import { requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import { WORD_KEYS, resolveConfig } from '../core.ts';
import type { ConfigOverrides, WordKey } from '../core.ts';
import * as configRepo from '../repositories/config.ts';

const router = Router({ mergeParams: true });

/**
 * GET …/config/templates — the business types on offer, for Onboarding and Settings.
 *
 * A draft is absent by definition: the query joins only published versions, which is the same
 * fact stores_assert_published_pin enforces from the other side. So Pharmacy does not appear
 * here and cannot be pinned there.
 *
 * The ANSWER is platform-wide, but the ROUTE is store-scoped on purpose: it is mounted under
 * the store whose settings are being edited, so seeing the list requires settings.write
 * somewhere rather than being open to anyone with a session.
 */
router.get(
  '/templates',
  requireStorePermission('settings.write'),
  asyncHandler(async (_req, res) => {
    res.json({ templates: await configRepo.offeredTemplates() });
  }),
);

/**
 * PUT …/config/template — switch business type.
 *
 * Takes a KEY, not an id and version. The merchant is choosing "Fashion", and which version of
 * Fashion they get is the platform's decision — the highest published one. Letting a caller
 * name a version would let them pin an old one, which is AdminIndustries' rollout decision to
 * make, not a merchant's.
 *
 * IDEMPOTENT: repinning to the version already pinned reports `changed: false` and writes
 * nothing, so a double-submitted Settings form is not a second audit-worthy change.
 *
 * OVERRIDES SURVIVE. A merchant who renamed their categories to "Aisles" and then switched
 * from Grocery to Fashion still calls them Aisles. That is the same promise AdminIndustries
 * makes about a rollout — "Anything a merchant customized is kept" — and it holds here for
 * free, because the pin and the overrides are different columns.
 */
router.put(
  '/template',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const body = bodyOf(req.body);
    const templateKey = requiredString(body, 'templateKey', { max: 60 });

    const result = await withTransaction(async (tx) => {
      const choice = await configRepo.latestPublishedVersion(templateKey, tx);

      if (choice === null) {
        // Either no such template, or one with nothing published — Pharmacy is the second
        // case, and V002 ships it as a draft on purpose. Answered the same way, because
        // "Pharmacy exists but you cannot have it" and "there is no Pharmacy" are the same
        // thing to a merchant choosing a business type.
        throw notFound(
          'That business type is not available. Ask support if you expected it.',
          'TEMPLATE_NOT_OFFERED',
        );
      }

      const before = await configRepo.inputsByStoreId(storeId, tx);
      if (before === null) throw notFound('That store no longer exists.');

      if (
        before.inputs.template !== null &&
        before.inputs.template.key === choice.templateKey &&
        before.inputs.template.version === choice.version
      ) {
        return { changed: false as const, choice };
      }

      await configRepo.setTemplate(storeId, { templateId: choice.templateId, version: choice.version }, tx);
      return { changed: true as const, choice };
    }, { label: 'PUT /api/stores/:storeId/config/template' });

    res.json({
      changed: result.changed,
      template: {
        key: result.choice.templateKey,
        name: result.choice.templateName,
        version: result.choice.version,
      },
    });
  }),
);

/**
 * PATCH …/config/overrides — rename a word, or switch a module for this store.
 *
 * MERGE-PATCH SEMANTICS, per section: a key you send is set, a key you send as `null` is
 * REMOVED so the value falls back to the template, and a key you leave out is untouched. There
 * has to be a way to undo an override — Settings needs "reset to the template's default" — and
 * a null is the ordinary way to say it.
 *
 * A section that ends up empty is dropped rather than stored as `{}`, so `config_overrides`
 * says what was actually customised and the resolver's `source` field stays truthful.
 *
 * ATOMIC AND LOST-UPDATE SAFE: the row is read FOR UPDATE and written in one transaction, so
 * two Settings saves in flight cannot end with one silently discarded.
 */
router.patch(
  '/overrides',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const body = bodyOf(req.body);

    if (!('words' in body) && !('modules' in body)) {
      throw badRequest('Send "words", "modules", or both.', 'NOTHING_TO_CHANGE');
    }

    const wordPatch = readWordPatch(body['words']);
    const modulePatch = readModulePatch(body['modules']);

    const payload = await withTransaction(async (tx) => {
      // Validated against the live registry rather than a list in this file, so a module added
      // by a later migration is accepted the moment it exists.
      if (Object.keys(modulePatch).length > 0) {
        const known = new Set((await configRepo.moduleRegistry(tx)).map((m) => m.key));
        const unknown = Object.keys(modulePatch).filter((k) => !known.has(k));
        if (unknown.length > 0) {
          throw badRequest(
            `No such feature: ${unknown.join(', ')}. Known features: ${[...known].sort().join(', ')}.`,
            'UNKNOWN_MODULE',
          );
        }
      }

      const current = await configRepo.lockOverrides(storeId, tx);
      if (current === null) throw notFound('That store no longer exists.');

      const next = merge(current, wordPatch, modulePatch);
      await configRepo.writeOverrides(storeId, next, tx);

      // Read back through the same path the storefront uses, so the caller sees the resolved
      // result of their change rather than being told to fetch it and guess.
      const after = await configRepo.inputsByStoreId(storeId, tx);
      if (after === null) throw notFound('That store no longer exists.');

      return { store: after.store, config: resolveConfig(after.inputs), overrides: next };
    }, { label: 'PATCH /api/stores/:storeId/config/overrides' });

    res.json(payload);
  }),
);

// ---------------------------------------------------------------------------

function readWordPatch(raw: unknown): Record<string, string | null> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw badRequest('"words" must be an object.', 'INVALID');
  }

  const patch: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(WORD_KEYS as readonly string[]).includes(key)) {
      throw badRequest(
        `"${key}" is not a word this platform renames. The four are: ${WORD_KEYS.join(', ')}.`,
        'UNKNOWN_WORD',
      );
    }
    if (value === null) {
      patch[key] = null;
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw badRequest(`"${key}" must be some text, or null to use the template's word.`, 'INVALID');
    }
    if (value.trim().length > 40) {
      throw badRequest(`"${key}" must be at most 40 characters.`, 'TOO_LONG');
    }
    patch[key] = value.trim();
  }
  return patch;
}

function readModulePatch(raw: unknown): Record<string, boolean | null> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw badRequest('"modules" must be an object.', 'INVALID');
  }

  const patch: Record<string, boolean | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null) {
      patch[key] = null;
      continue;
    }
    if (typeof value !== 'boolean') {
      throw badRequest(`"${key}" must be true, false, or null to use the template's default.`, 'INVALID');
    }
    patch[key] = value;
  }
  return patch;
}

function merge(
  current: ConfigOverrides,
  words: Record<string, string | null>,
  modules: Record<string, boolean | null>,
): ConfigOverrides {
  const nextWords: Record<string, string> = { ...(current.words ?? {}) };
  for (const [key, value] of Object.entries(words)) {
    if (value === null) delete nextWords[key];
    else nextWords[key] = value;
  }

  const nextModules: Record<string, boolean> = { ...(current.modules ?? {}) };
  for (const [key, value] of Object.entries(modules)) {
    if (value === null) delete nextModules[key];
    else nextModules[key] = value;
  }

  const result: ConfigOverrides = {};
  // An empty section is omitted, not stored as {}. config_overrides is meant to answer "what
  // did this merchant change"; `{"words":{}}` answers it misleadingly.
  if (Object.keys(nextWords).length > 0) result.words = nextWords as Partial<Record<WordKey, string>>;
  if (Object.keys(nextModules).length > 0) result.modules = nextModules;
  return result;
}

export default router;
