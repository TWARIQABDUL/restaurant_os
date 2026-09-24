#!/usr/bin/env node
/**
 * Generates row types from the live schema — milestone 5's `db:types`.
 *
 * §2.1: "Row types are generated from the database schema and committed. A column
 * rename then fails `tsc` instead of failing at runtime inside a repository
 * method." The committed file is what makes that true, and `--check` in CI is what
 * keeps the file honest: it regenerates and fails if the result differs, so a
 * migration that changes a column cannot merge with stale types beside it.
 *
 *   npm run db:types              write packages/core/src/generated/database.ts
 *   npm run db:types -- --check   fail if the committed file is out of date
 *
 * Two details that are easy to get wrong and expensive here:
 *
 *   * `numeric` becomes `string`, not `number`. node-postgres returns numerics as
 *     strings because a double cannot hold them exactly, and this is a system that
 *     moves money. A generated `number` would invite arithmetic that silently
 *     loses cents.
 *   * `bigint` becomes `string` for the same reason — it exceeds Number.MAX_SAFE_INTEGER.
 *
 * The output targets packages/core, which compiles with no DOM and no Node types,
 * so nothing here may emit `Buffer`.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(REPO, 'packages', 'core', 'src', 'generated', 'database.ts');

/** Owned by the migration runner, not by the application. */
const EXCLUDED_TABLES = new Set(['schema_migrations']);

/** Postgres udt_name → TypeScript. */
const TYPES: Readonly<Record<string, string>> = {
  uuid: 'string',
  text: 'string', varchar: 'string', bpchar: 'string', citext: 'string', name: 'string',
  int2: 'number', int4: 'number', float4: 'number', float8: 'number',
  int8: 'string',       // bigint exceeds Number.MAX_SAFE_INTEGER
  numeric: 'string',    // money: node-postgres returns these as strings, exactly
  bool: 'boolean',
  timestamptz: 'Date', timestamp: 'Date', date: 'Date',
  time: 'string', timetz: 'string', interval: 'string',
  json: 'unknown', jsonb: 'unknown',
  bytea: 'Uint8Array',
  inet: 'string', cidr: 'string', macaddr: 'string',
};

type Column = {
  name: string;
  udt: string;
  nullable: boolean;
  isArray: boolean;
  comment: string | null;
};

const pascal = (s: string) => s.split('_').filter(Boolean).map((p) => p[0]?.toUpperCase() + p.slice(1)).join('');

/**
 * Pull the allowed values out of a CHECK constraint, so a column constrained to a
 * list becomes a union type rather than `string`.
 *
 * Postgres rewrites what you wrote, and it does not always rewrite it the same
 * way: `IN ('a','b')` on a text column normalises to `= ANY (ARRAY['a'::text, …])`,
 * a single-value `IN ('a')` collapses to `= 'a'::text`, and a varchar column picks
 * up casts around the whole array. All three are matched here.
 */
function allowedValues(def: string): { column: string; values: string[] } | null {
  const any = /^CHECK \(\(+\(?([a-z_][a-z0-9_]*)\)?(?:::text)? = ANY \(\(?ARRAY\[(.+?)\]\)?(?:::text\[\])?\)\)+$/.exec(def);
  if (any?.[1] !== undefined && any[2] !== undefined) {
    const values = [...any[2].matchAll(/'((?:[^']|'')*)'/g)].map((m) => (m[1] ?? '').replace(/''/g, "'"));
    return values.length > 0 ? { column: any[1], values } : null;
  }
  const one = /^CHECK \(\(+\(?([a-z_][a-z0-9_]*)\)?(?:::text)? = '((?:[^']|'')*)'::(?:text|character varying)\)+$/.exec(def);
  if (one?.[1] !== undefined && one[2] !== undefined) {
    return { column: one[1], values: [one[2].replace(/''/g, "'")] };
  }
  return null;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL is not set. Run through db/scripts/gen-types.sh.');
  }

  const client = new Client({ connectionString: url, application_name: 'vendlyfy-gen-types' });
  await client.connect();

  const warnings: string[] = [];
  let body = '';

  try {
    const { rows: tables } = await client.query<{ name: string; comment: string | null }>(
      `SELECT c.relname AS name, obj_description(c.oid) AS comment
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`,
    );

    const { rows: cols } = await client.query<{
      table_name: string; column_name: string; udt_name: string; is_nullable: string;
      data_type: string; comment: string | null;
    }>(
      `SELECT c.table_name, c.column_name, c.udt_name, c.is_nullable, c.data_type,
              col_description(format('public.%I', c.table_name)::regclass, c.ordinal_position) AS comment
         FROM information_schema.columns c
        WHERE c.table_schema = 'public'
        ORDER BY c.table_name, c.ordinal_position`,
    );

    const { rows: checks } = await client.query<{ table_name: string; def: string }>(
      `SELECT t.relname AS table_name, pg_get_constraintdef(k.oid) AS def
         FROM pg_constraint k JOIN pg_class t ON t.oid = k.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public' AND k.contype = 'c'
        ORDER BY t.relname, pg_get_constraintdef(k.oid)`,
    );

    // table -> column -> union members
    const unions = new Map<string, Map<string, string[]>>();
    for (const row of checks) {
      const parsed = allowedValues(row.def);
      if (parsed === null) continue;
      const forTable = unions.get(row.table_name) ?? new Map<string, string[]>();
      // A column with two value CHECKs would be the intersection; that has not
      // happened, and guessing would be worse than saying so.
      if (forTable.has(parsed.column)) {
        warnings.push(`${row.table_name}.${parsed.column} has more than one value CHECK; left as the first`);
      } else {
        forTable.set(parsed.column, parsed.values);
      }
      unions.set(row.table_name, forTable);
    }

    const byTable = new Map<string, Column[]>();
    for (const c of cols) {
      if (EXCLUDED_TABLES.has(c.table_name)) continue;
      const list = byTable.get(c.table_name) ?? [];
      list.push({
        name: c.column_name,
        udt: c.udt_name,
        nullable: c.is_nullable === 'YES',
        isArray: c.data_type === 'ARRAY',
        comment: c.comment,
      });
      byTable.set(c.table_name, list);
    }

    const emitted: string[] = [];
    for (const t of tables) {
      if (EXCLUDED_TABLES.has(t.name)) continue;
      const columns = byTable.get(t.name) ?? [];
      const tableUnions = unions.get(t.name) ?? new Map<string, string[]>();
      const iface = `${pascal(t.name)}Row`;

      // Union types first, so the interface below reads as a summary.
      for (const [column, values] of [...tableUnions].sort(([a], [b]) => a.localeCompare(b))) {
        if (!columns.some((c) => c.name === column)) continue;
        emitted.push(
          `/** \`${t.name}.${column}\`, from its CHECK constraint. */\n` +
          `export type ${pascal(t.name)}${pascal(column)} =\n` +
          values.map((v) => `  | '${v.replace(/'/g, "\\'")}'`).join('\n') + ';\n',
        );
      }

      const lines: string[] = [];
      if (t.comment !== null) lines.push(`/**\n * ${t.comment.replace(/\n/g, '\n * ')}\n */`);
      lines.push(`export interface ${iface} {`);
      for (const c of columns) {
        const union = tableUnions.get(c.name);
        let type = union !== undefined
          ? `${pascal(t.name)}${pascal(c.name)}`
          : TYPES[c.udt.replace(/^_/, '')];
        if (type === undefined) {
          warnings.push(`no TypeScript mapping for ${t.name}.${c.name} (${c.udt}) — emitted as unknown`);
          type = 'unknown';
        }
        if (c.isArray) type = `${type}[]`;
        if (c.comment !== null) lines.push(`  /** ${c.comment.replace(/\n/g, ' ')} */`);
        lines.push(`  ${c.name}: ${type}${c.nullable ? ' | null' : ''};`);
      }
      lines.push('}\n');
      emitted.push(lines.join('\n'));
    }

    const names = tables.filter((t) => !EXCLUDED_TABLES.has(t.name)).map((t) => t.name);
    const map = [
      '/** Every table, for a repository layer that is generic over one. */',
      'export interface Database {',
      ...names.map((n) => `  ${n}: ${pascal(n)}Row;`),
      '}\n',
      '/** Table names as a value, so a runtime check can be exhaustive. */',
      `export const TABLE_NAMES = [\n${names.map((n) => `  '${n}',`).join('\n')}\n] as const;\n`,
      'export type TableName = (typeof TABLE_NAMES)[number];',
    ].join('\n');

    body = [
      '// GENERATED FILE — DO NOT EDIT.',
      '//',
      '// Written by `npm run db:types` from the live schema. CI regenerates it and',
      '// fails if the result differs, so this cannot drift from the migrations.',
      '//',
      '// Two conversions worth knowing, both deliberate:',
      '//   * numeric  -> string   node-postgres returns these as strings, exactly. A',
      '//                          `number` here would invite arithmetic that loses cents.',
      '//   * bigint   -> string   it exceeds Number.MAX_SAFE_INTEGER.',
      '',
      ...emitted,
      map,
      '',
    ].join('\n');
  } finally {
    await client.end().catch(() => {});
  }

  for (const w of warnings) console.log(`  [warn] ${w}`);

  if (check) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (current === body) {
      console.log(`  [ok]   ${path.relative(REPO, OUT)} matches the schema`);
      return;
    }
    throw new Error(
      `${path.relative(REPO, OUT)} is out of date with the schema.\n` +
      `      Run \`npm run db:types\` and commit the result.`,
    );
  }

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, body);
  console.log(`  [ok]   wrote ${path.relative(REPO, OUT)} (${body.split('\n').length} lines)`);
}

main().then(
  () => { process.exitCode = 0; },
  (error: unknown) => {
    console.error(`\nFAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
