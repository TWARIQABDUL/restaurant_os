// server/src/repositories/config.ts — milestone 12.
//
// Reads what the resolver needs, and writes the two things a merchant may change.
//
// The read is TWO round trips inside one repeatable-read transaction, not four:
//
//   1. the store, its pin, its overrides, the pinned version's jsonb, the template's
//      metadata, AND the whole module registry — one row, one statement
//   2. the version's module and flag keys — one row, two subqueries, skipped entirely when
//      the store has no pin
//
// One transaction because a store's pin and the version it points at must be read at the same
// moment: a rollout (AdminIndustries, milestone 27) repins stores while this is running, and
// two plain reads a millisecond apart could see version 4's words with version 5's modules.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import type {
  Attribute,
  ConfigInputs,
  ConfigOverrides,
  ModuleDefinition,
  OrderStep,
} from '../core.ts';

/** What a store is, apart from its configuration. The config routes answer with it. */
export type ConfigStore = {
  id: string;
  slug: string;
  name: string;
};

type HeadRow = {
  id: string;
  slug: string;
  name: string;
  config_overrides: ConfigOverrides;
  template_id: string | null;
  template_version: number | null;
  template_key: string | null;
  template_name: string | null;
  template_accent: string | null;
  words: Record<string, string> | null;
  attributes: Attribute[] | null;
  order_steps: OrderStep[] | null;
  registry: ModuleDefinition[];
};

// LEFT JOINs, all of them, because a store with no template pinned is a real state and not an
// error: Onboarding's first question is the business type, and the store row exists before it
// is answered. An inner join here would 404 a half-onboarded store.
//
// The registry comes along as jsonb rather than as its own round trip. It is eight rows that
// change only by migration, and folding it in costs one sequential scan of one page against
// the latency of a second statement.
const HEAD = `
    SELECT s.id,
           s.slug,
           s.name,
           s.config_overrides,
           s.industry_template_id      AS template_id,
           s.industry_template_version AS template_version,
           t.key                       AS template_key,
           t.name                      AS template_name,
           t.accent_color              AS template_accent,
           v.words,
           v.attributes,
           v.order_steps,
           COALESCE((
               SELECT jsonb_agg(jsonb_build_object('key', m.key, 'label', m.label, 'description', m.description)
                                ORDER BY m.key)
                 FROM modules m
           ), '[]'::jsonb) AS registry
      FROM stores s
      LEFT JOIN industry_templates t
             ON t.id = s.industry_template_id
      LEFT JOIN industry_template_versions v
             ON v.template_id = s.industry_template_id
            AND v.version     = s.industry_template_version
     WHERE s.slug = lower($1)
`;

const HEAD_BY_ID = HEAD.replace('WHERE s.slug = lower($1)', 'WHERE s.id = $1');

const VERSION_SETS = `
    SELECT COALESCE((
               SELECT array_agg(module_key ORDER BY module_key)
                 FROM industry_template_version_modules
                WHERE template_id = $1 AND version = $2
           ), '{}'::text[]) AS modules,
           COALESCE((
               SELECT array_agg(flag_key ORDER BY flag_key)
                 FROM industry_template_version_product_flags
                WHERE template_id = $1 AND version = $2
           ), '{}'::text[]) AS flags
`;

async function build(row: HeadRow, on: Queryable): Promise<{ store: ConfigStore; inputs: ConfigInputs }> {
  const store: ConfigStore = { id: row.id, slug: row.slug, name: row.name };

  // A half-written pin is impossible — stores_template_pin_complete is a CHECK — so testing
  // one column is testing both. The version's jsonb is non-null whenever the pin is, because
  // stores_template_pin_fkey requires the row to exist.
  if (
    row.template_id === null ||
    row.template_version === null ||
    row.template_key === null ||
    row.template_name === null ||
    row.template_accent === null ||
    row.words === null ||
    row.order_steps === null
  ) {
    return { store, inputs: { registry: row.registry, template: null, overrides: row.config_overrides } };
  }

  const sets = await on.query<{ modules: string[]; flags: string[] }>(VERSION_SETS, [
    row.template_id,
    row.template_version,
  ]);
  const found = sets.rows[0];

  return {
    store,
    inputs: {
      registry: row.registry,
      template: {
        key: row.template_key,
        name: row.template_name,
        accentColor: row.template_accent,
        version: row.template_version,
        words: row.words,
        attributes: row.attributes ?? [],
        orderSteps: row.order_steps,
        modules: found?.modules ?? [],
        productFlags: found?.flags ?? [],
      },
      overrides: row.config_overrides,
    },
  };
}

/** The resolver's inputs for the store with this slug, or null if there is no such store. */
export async function inputsBySlug(
  slug: string,
  on: Queryable = db,
): Promise<{ store: ConfigStore; inputs: ConfigInputs } | null> {
  const { rows } = await on.query<HeadRow>(HEAD, [slug]);
  const row = rows[0];
  return row === undefined ? null : build(row, on);
}

/** The same, by store id — for the console, which knows the uuid rather than the slug. */
export async function inputsByStoreId(
  storeId: string,
  on: Queryable = db,
): Promise<{ store: ConfigStore; inputs: ConfigInputs } | null> {
  const { rows } = await on.query<HeadRow>(HEAD_BY_ID, [storeId]);
  const row = rows[0];
  return row === undefined ? null : build(row, on);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Every module the platform offers. The config routes validate an override against this. */
export async function moduleRegistry(on: Queryable = db): Promise<ModuleDefinition[]> {
  const { rows } = await on.query<ModuleDefinition>(
    `SELECT key, label, description FROM modules ORDER BY key`,
  );
  return rows;
}

export type TemplateChoice = {
  templateId: string;
  templateKey: string;
  templateName: string;
  version: number;
};

/**
 * The highest PUBLISHED version of a template, by key.
 *
 * Null when the template exists but has nothing published — Pharmacy ships as a draft, which
 * V002 describes as "no store can pin it". The route turns that into a message rather than
 * letting the trigger raise one, so a merchant is told the business type is not offered yet
 * instead of being shown a constraint.
 *
 * MEASURED, not assumed: at eight templates with one version each the planner scans
 * industry_template_versions (8 rows, 1 buffer, 0.01 ms) rather than using
 * itv_published_lookup, and it is right to. That partial index — (template_id, version DESC)
 * WHERE status = 'published', which V002 added "for the config resolver on a cache miss" — is
 * for when a template has accumulated versions, which AdminIndustries' own fictional history
 * (food at v4, fashion at v5) says it will.
 */
export async function latestPublishedVersion(
  templateKey: string,
  on: Queryable = db,
): Promise<TemplateChoice | null> {
  const { rows } = await on.query<TemplateChoice>(
    `SELECT t.id AS "templateId", t.key AS "templateKey", t.name AS "templateName", v.version
       FROM industry_templates t
       JOIN industry_template_versions v ON v.template_id = t.id AND v.status = 'published'
      WHERE t.key = $1
      ORDER BY v.version DESC
      LIMIT 1`,
    [templateKey],
  );
  return rows[0] ?? null;
}

/** Business types a merchant may choose: every template with something published. */
export async function offeredTemplates(on: Queryable = db): Promise<
  { key: string; name: string; accentColor: string; version: number }[]
> {
  const { rows } = await on.query<{ key: string; name: string; accentColor: string; version: number }>(
    `SELECT DISTINCT ON (t.key)
            t.key, t.name, t.accent_color AS "accentColor", v.version
       FROM industry_templates t
       JOIN industry_template_versions v ON v.template_id = t.id AND v.status = 'published'
      ORDER BY t.key, v.version DESC`,
  );
  return rows;
}

/**
 * Repins a store to a template version.
 *
 * OVERRIDES ARE NOT TOUCHED, which is the behaviour AdminIndustries promises about a rollout:
 * "Only defaults change. Anything a merchant customized is kept." The same holds when the
 * merchant themself switches business type — their renamed words survive the switch, because
 * overrides live in a different column from the pin.
 */
export async function setTemplate(
  storeId: string,
  choice: { templateId: string; version: number },
  tx: Queryable,
): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE stores
        SET industry_template_id = $2, industry_template_version = $3
      WHERE id = $1`,
    [storeId, choice.templateId, choice.version],
  );
  if (rowCount === 0) throw new Error(`store ${storeId} disappeared while setting its template`);
}

/**
 * Reads the current overrides and locks the row, so two Settings saves cannot lose one
 * another's change. The merge itself is the route's, because removing a key is a decision
 * about intent rather than about SQL.
 */
export async function lockOverrides(storeId: string, tx: Queryable): Promise<ConfigOverrides | null> {
  const { rows } = await tx.query<{ config_overrides: ConfigOverrides }>(
    `SELECT config_overrides FROM stores WHERE id = $1 FOR UPDATE`,
    [storeId],
  );
  return rows[0]?.config_overrides ?? null;
}

export async function writeOverrides(
  storeId: string,
  overrides: ConfigOverrides,
  tx: Queryable,
): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE stores SET config_overrides = $2::jsonb WHERE id = $1`,
    [storeId, JSON.stringify(overrides)],
  );
  if (rowCount === 0) throw new Error(`store ${storeId} disappeared while writing its overrides`);
}
