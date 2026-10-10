// server/src/repositories/adminTemplates.ts — milestone 27, part C: AdminIndustries. What a store gets when its owner picks a business
// type: the words it uses, the modules it starts with, the suggestions in Add product, the timeline of an order.
//
// A PUBLISHED VERSION IS IMMUTABLE (V002, enforced by trigger) BECAUSE STORES ARE PINNED TO IT. So there are only two things an admin
// does here, and the database's shape says both:
//   SAVE DRAFT   there is at most one draft per template. The first edit of a live template CREATES it — a copy of the live version
//                one number up — and every later edit changes the draft in place. Nothing a store reads moves.
//   PUBLISH      the draft becomes the next live version. New stores pin to it from then on. Existing stores keep the version they
//                are on UNLESS the admin ticks "also update", which repins them — and "only defaults change, anything a merchant
//                customised is kept" is true for free, because a merchant's overrides live in a different column from the pin (M12).
//
// ORDER STEPS ARE SHOWN, NOT EDITED. A step's key is what orders and history refer to; renaming or reordering one is a data migration
// of every order, not a copy edit, so it is a migration here too. The words, the modules and the attribute suggestions — the things a
// merchant sees and may override — are the editable part. Product flags are carried across versions untouched (Pharmacy's
// prescription_required) because the board shows them and does not edit them.
//
// "+ New template" is not built: a template is a business type the platform has decided to support, with a name, an accent and a
// first version, and that is a product decision before it is a form.

import { badRequest, conflict, db, notFound, withTransaction } from '../db/index.ts';
import type { Queryable, Tx } from '../db/index.ts';

type Actor = { id: string; ip: string | null; userAgent: string | null };

export type TemplateSummary = { key: string; name: string; accent: string; stores: number; liveVersion: number | null; hasDraft: boolean };

export async function templates(on: Queryable = db): Promise<TemplateSummary[]> {
  const r = await on.query<{ key: string; name: string; accent_color: string; stores: string; live: number | null; draft: boolean }>(
    `SELECT t.key, t.name, t.accent_color,
            (SELECT count(*) FROM stores s WHERE s.industry_template_id = t.id)::text AS stores,
            (SELECT max(v.version) FROM industry_template_versions v WHERE v.template_id = t.id AND v.status = 'published') AS live,
            EXISTS (SELECT 1 FROM industry_template_versions v WHERE v.template_id = t.id AND v.status = 'draft') AS draft
       FROM industry_templates t ORDER BY (SELECT count(*) FROM stores s WHERE s.industry_template_id = t.id) DESC, t.name`,
  );
  return r.rows.map((x) => ({ key: x.key, name: x.name, accent: x.accent_color, stores: Number(x.stores), liveVersion: x.live, hasDraft: x.draft }));
}

export type Attribute = { name: string; pick: 'one' | 'several'; priced?: boolean };
export type Step = { key: string; label: string };
export type Words = { product: string; catalog: string; category: string; option: string };

export type TemplateDetail = TemplateSummary & {
  /** The version the editor is showing: the draft if there is one, otherwise the live one. */
  version: number;
  state: 'draft' | 'live';
  words: Words;
  modules: string[];
  attributes: Attribute[];
  steps: Step[];
  flags: { key: string; label: string; description: string }[];
  catalogue: { modules: { key: string; label: string }[] };
};

export const WORD_KEYS = ['product', 'catalog', 'category', 'option'] as const;

export async function template(key: string, on: Queryable = db): Promise<TemplateDetail | null> {
  const s = (await templates(on)).find((t) => t.key === key);
  if (s === undefined) return null;
  const v = (await on.query<{ version: number; status: 'draft' | 'published'; words: Words; attributes: Attribute[]; order_steps: Step[] }>(
    `SELECT v.version, v.status, v.words, v.attributes, v.order_steps
       FROM industry_template_versions v JOIN industry_templates t ON t.id = v.template_id
      WHERE t.key = $1 ORDER BY (v.status = 'draft') DESC, v.version DESC LIMIT 1`,
    [key],
  )).rows[0];
  if (v === undefined) return null;
  const mods = (await on.query<{ module_key: string }>(
    `SELECT m.module_key FROM industry_template_version_modules m JOIN industry_templates t ON t.id = m.template_id WHERE t.key = $1 AND m.version = $2 ORDER BY m.module_key`,
    [key, v.version],
  )).rows.map((m) => m.module_key);
  const flags = await on.query<{ key: string; label: string; description: string }>(
    `SELECT f.key, f.label, f.description FROM industry_template_version_product_flags pf
       JOIN industry_templates t ON t.id = pf.template_id JOIN product_flags f ON f.key = pf.flag_key WHERE t.key = $1 AND pf.version = $2 ORDER BY f.key`,
    [key, v.version],
  );
  const catalogue = await on.query<{ key: string; label: string }>(`SELECT key, label FROM modules ORDER BY key`);
  return { ...s, version: v.version, state: v.status === 'draft' ? 'draft' : 'live', words: v.words, modules: mods, attributes: v.attributes, steps: v.order_steps, flags: flags.rows, catalogue: { modules: catalogue.rows } };
}

export type TemplateEdit = { words: Words; modules: string[]; attributes: Attribute[] };

function validate(e: TemplateEdit, registry: Set<string>): void {
  for (const k of WORD_KEYS) {
    const w = e.words[k];
    if (typeof w !== 'string' || w.trim() === '' || w.length > 40) throw badRequest('Each word is 1–40 characters.', 'INVALID_WORD');
  }
  if (!e.modules.every((m) => registry.has(m))) throw badRequest('One of those modules does not exist.', 'INVALID_MODULE');
  if (e.attributes.length > 12) throw badRequest('At most twelve suggested attributes.', 'TOO_MANY_ATTRIBUTES');
  const seen = new Set<string>();
  for (const a of e.attributes) {
    const name = a.name.trim();
    if (name === '' || name.length > 40) throw badRequest('An attribute’s name is 1–40 characters.', 'INVALID_ATTRIBUTE');
    if (a.pick !== 'one' && a.pick !== 'several') throw badRequest('An attribute is pick one or several.', 'INVALID_ATTRIBUTE');
    if (seen.has(name.toLowerCase())) throw badRequest(`“${name}” is listed twice.`, 'DUPLICATE_ATTRIBUTE');
    seen.add(name.toLowerCase());
  }
}

/** Finds the template's draft, creating it from the live version when there is none. Returns its id and version. */
async function ensureDraft(tx: Tx, key: string, actor: Actor): Promise<{ templateId: string; version: number; created: boolean }> {
  const t = (await tx.query<{ id: string }>(`SELECT id FROM industry_templates WHERE key = $1 FOR UPDATE`, [key])).rows[0];
  if (t === undefined) throw notFound('That template does not exist.', 'NO_SUCH_TEMPLATE');
  const draft = (await tx.query<{ version: number }>(`SELECT version FROM industry_template_versions WHERE template_id = $1 AND status = 'draft'`, [t.id])).rows[0];
  if (draft !== undefined) return { templateId: t.id, version: draft.version, created: false };

  const live = (await tx.query<{ version: number }>(`SELECT version FROM industry_template_versions WHERE template_id = $1 AND status = 'published' ORDER BY version DESC LIMIT 1`, [t.id])).rows[0];
  if (live === undefined) throw conflict('That template has no version to start from.', 'NO_VERSION');
  const next = live.version + 1;
  await tx.query(
    `INSERT INTO industry_template_versions (template_id, version, status, words, attributes, order_steps, created_by)
          SELECT template_id, $2, 'draft', words, attributes, order_steps, $3 FROM industry_template_versions WHERE template_id = $1 AND version = $4`,
    [t.id, next, actor.id, live.version],
  );
  await tx.query(`INSERT INTO industry_template_version_modules (template_id, version, module_key) SELECT template_id, $2, module_key FROM industry_template_version_modules WHERE template_id = $1 AND version = $3`, [t.id, next, live.version]);
  await tx.query(`INSERT INTO industry_template_version_product_flags (template_id, version, flag_key) SELECT template_id, $2, flag_key FROM industry_template_version_product_flags WHERE template_id = $1 AND version = $3`, [t.id, next, live.version]);
  return { templateId: t.id, version: next, created: true };
}

export async function saveDraft(key: string, edit: TemplateEdit, actor: Actor): Promise<TemplateDetail> {
  await withTransaction(
    async (tx) => {
      const registry = new Set((await tx.query<{ key: string }>(`SELECT key FROM modules`)).rows.map((m) => m.key));
      validate(edit, registry);
      const d = await ensureDraft(tx, key, actor);
      const attributes = edit.attributes.map((a) => ({ name: a.name.trim(), pick: a.pick, ...(a.priced === true ? { priced: true } : {}) }));
      await tx.query(`UPDATE industry_template_versions SET words = $3::jsonb, attributes = $4::jsonb WHERE template_id = $1 AND version = $2`, [d.templateId, d.version, JSON.stringify(Object.fromEntries(WORD_KEYS.map((k) => [k, edit.words[k].trim()]))), JSON.stringify(attributes)]);
      await tx.query(`DELETE FROM industry_template_version_modules WHERE template_id = $1 AND version = $2`, [d.templateId, d.version]);
      for (const m of edit.modules) await tx.query(`INSERT INTO industry_template_version_modules (template_id, version, module_key) VALUES ($1, $2, $3)`, [d.templateId, d.version, m]);
      await tx.query(`SELECT audit('config', 'save_template_draft', $1, $2, NULL, NULL, NULL, NULL, $3::inet, $4, NULL, $5::jsonb)`, [`Saved the ${key} template draft (v${d.version})`, actor.id, actor.ip, actor.userAgent, JSON.stringify({ template: key, version: d.version })]);
    },
    { label: 'PUT /admin/templates', retries: 0 },
  );
  return (await template(key))!;
}

export async function publish(key: string, rollout: 'new' | 'all', actor: Actor): Promise<{ template: TemplateDetail; updated: number }> {
  const updated = await withTransaction(
    async (tx) => {
      const t = (await tx.query<{ id: string; name: string }>(`SELECT id, name FROM industry_templates WHERE key = $1 FOR UPDATE`, [key])).rows[0];
      if (t === undefined) throw notFound('That template does not exist.', 'NO_SUCH_TEMPLATE');
      const draft = (await tx.query<{ version: number }>(`SELECT version FROM industry_template_versions WHERE template_id = $1 AND status = 'draft'`, [t.id])).rows[0];
      if (draft === undefined) throw conflict('There’s nothing to publish. Make a change and save a draft first.', 'NO_DRAFT');
      await tx.query(`UPDATE industry_template_versions SET status = 'published', published_at = now() WHERE template_id = $1 AND version = $2`, [t.id, draft.version]);
      let n = 0;
      if (rollout === 'all') {
        n = (await tx.query(`UPDATE stores SET industry_template_version = $2 WHERE industry_template_id = $1 AND industry_template_version < $2`, [t.id, draft.version])).rowCount ?? 0;
      }
      await tx.query(`SELECT audit('config', 'publish_template', $1, $2, NULL, NULL, NULL, NULL, $3::inet, $4, NULL, $5::jsonb)`, [
        `Published ${t.name} template v${draft.version} · ${rollout === 'all' ? `updated ${n} existing ${n === 1 ? 'store' : 'stores'}` : 'new stores only'}`, actor.id, actor.ip, actor.userAgent, JSON.stringify({ template: key, version: draft.version, rollout, updated: n }),
      ]);
      return n;
    },
    { label: 'POST /admin/templates/publish', retries: 0 },
  );
  return { template: (await template(key))!, updated };
}
