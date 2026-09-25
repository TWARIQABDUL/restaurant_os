// packages/core/test/config.test.ts — milestone 12.
//
// The resolver and the two primitives, as pure functions. No database and no server: this is
// the layer the browser also runs, so it is tested where it lives.
//
//   npm run core:test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PLATFORM_WORDS,
  WORD_KEYS,
  bindConfig,
  isAlreadySingular,
  resolveConfig,
  singularize,
} from '../src/index.ts';
import type { ConfigInputs, ModuleDefinition } from '../src/index.ts';

// The registry as V002 seeds it. Copied rather than imported because this package has no
// database access — and if the two ever disagree, the server tests catch it.
const REGISTRY: ModuleDefinition[] = [
  { key: 'modifiers', label: 'Priced extras (modifiers)', description: '' },
  { key: 'delivery', label: 'Delivery', description: '' },
  { key: 'pickup', label: 'Pickup', description: '' },
  { key: 'table', label: 'Table ordering (QR)', description: '' },
  { key: 'scheduled', label: 'Scheduled orders', description: '' },
  { key: 'stock', label: 'Stock tracking', description: '' },
  { key: 'appointments', label: 'Appointments', description: '' },
  { key: 'rx', label: 'Prescription flag', description: '' },
];

/** Food, as V002 ships it. */
const FOOD: NonNullable<ConfigInputs['template']> = {
  key: 'food',
  name: 'Food & drinks',
  accentColor: '#1D6B47',
  version: 1,
  words: { product: 'Menu items', catalog: 'Menu', category: 'Sections', option: 'Extras' },
  attributes: [
    { name: 'Size', pick: 'one' },
    { name: 'Extras', pick: 'several', priced: true },
    { name: 'Spice level', pick: 'one' },
  ],
  orderSteps: [
    { key: 'new', label: 'New' },
    { key: 'preparing', label: 'Preparing' },
    { key: 'ready', label: 'Ready' },
    { key: 'delivered', label: 'Delivered' },
  ],
  modules: ['modifiers', 'delivery', 'pickup', 'table'],
  productFlags: [],
};

const SERVICES: NonNullable<ConfigInputs['template']> = {
  key: 'services',
  name: 'Services',
  accentColor: '#4B3A83',
  version: 1,
  words: { product: 'Services', catalog: 'Services', category: 'Categories', option: 'Add-ons' },
  attributes: [{ name: 'Duration', pick: 'one' }],
  orderSteps: [
    { key: 'booked', label: 'Booked' },
    { key: 'confirmed', label: 'Confirmed' },
    { key: 'in_progress', label: 'In progress' },
    { key: 'done', label: 'Done' },
  ],
  modules: ['modifiers', 'scheduled', 'appointments'],
  productFlags: [],
};

function inputs(
  template: ConfigInputs['template'],
  overrides: ConfigInputs['overrides'] = {},
): ConfigInputs {
  return { registry: REGISTRY, template, overrides };
}

// ===========================================================================
describe('singularize', () => {
  // Every word the eight templates ship, one by one. If the editor ever stores a word this
  // gets wrong, that is what this table is for.
  const SHIPPED: [string, string][] = [
    ['Menu items', 'Menu item'],
    ['Menu', 'Menu'],
    ['Sections', 'Section'],
    ['Extras', 'Extra'],
    ['Products', 'Product'],
    ['Shop', 'Shop'],
    ['Collections', 'Collection'],
    ['Variants', 'Variant'],
    ['Brands', 'Brand'],
    ['Shades', 'Shade'],
    ['Configurations', 'Configuration'],
    ['Aisles', 'Aisle'],
    ['Pack sizes', 'Pack size'],
    ['Medicines', 'Medicine'],
    ['Showroom', 'Showroom'],
    ['Rooms', 'Room'],
    ['Finishes', 'Finish'],
    ['Services', 'Service'],
    ['Categories', 'Category'],
    ['Add-ons', 'Add-on'],
  ];

  it('is exact for every word the eight templates ship', () => {
    for (const [plural, singular] of SHIPPED) {
      assert.equal(singularize(plural), singular, plural);
    }
  });

  it('does not turn "Pack sizes" into "Pack siz"', () => {
    // The reason the -es rule is restricted to five clusters. "sizes" ends in a sibilant + es
    // exactly as "boxes" does; the difference is a silent e that spelling cannot see.
    assert.equal(singularize('Pack sizes'), 'Pack size');
    assert.equal(singularize('Boxes'), 'Box');
    assert.equal(singularize('Classes'), 'Class');
    assert.equal(singularize('Finishes'), 'Finish');
    assert.equal(singularize('Churches'), 'Church');
  });

  it('leaves a singular that already ends in s alone', () => {
    // Without this "Dress" becomes "Dres" — and the function has to be safe on a word that
    // was never plural, because that is what makes it safe to apply twice.
    for (const word of ['Dress', 'Status', 'Analysis', 'Glass']) {
      assert.equal(singularize(word), word, word);
    }
  });

  it('is idempotent on everything it ships for', () => {
    // The property, not an example: applying it to its own output must change nothing.
    for (const [plural] of SHIPPED) {
      const once = singularize(plural);
      assert.equal(singularize(once), once, plural);
    }
  });

  it('is idempotent on generated words too', () => {
    // A rough property sweep over shapes a merchant might type.
    const stems = ['Item', 'Box', 'Class', 'Category', 'Size', 'Service', 'Dish', 'Church', 'Menu', 'Kit'];
    const suffixes = ['', 's', 'es', 'ies'];
    for (const stem of stems) {
      for (const suffix of suffixes) {
        const word = stem + suffix;
        const once = singularize(word);
        assert.equal(singularize(once), once, `${word} → ${once}`);
      }
    }
  });

  it('says when it changed nothing', () => {
    assert.equal(isAlreadySingular('Menu'), true);
    assert.equal(isAlreadySingular('Sections'), false);
  });

  it('is honest about what it cannot do', () => {
    // Recorded, not hidden. The fix is for the editor to collect both forms — a designer
    // change, in Part 9 of the plan — and ResolvedWord.derived is what surfaces the guess in
    // the meantime.
    assert.equal(singularize('Clothes'), 'Clothe');
    assert.equal(singularize('Children'), 'Children');
  });
});

// ===========================================================================
describe('resolveConfig', () => {
  it('resolves a template with no overrides', () => {
    const config = resolveConfig(inputs(FOOD));

    assert.equal(config.template?.key, 'food');
    assert.equal(config.template?.name, 'Food & drinks');
    assert.equal(config.words.product.many, 'Menu items');
    assert.equal(config.words.product.one, 'Menu item');
    assert.equal(config.words.product.source, 'template');
    assert.equal(config.words.category.derived, true, 'Sections → Section is a guess');
    assert.equal(config.words.catalog.derived, false, 'Menu → Menu is not');
  });

  it('gives every module in the registry a boolean, not just the ones the template names', () => {
    const config = resolveConfig(inputs(FOOD));

    assert.deepEqual(Object.keys(config.modules).sort(), REGISTRY.map((m) => m.key).sort());
    assert.equal(config.modules['modifiers']?.enabled, true);
    assert.equal(config.modules['stock']?.enabled, false, 'absence in the template is off');
    assert.equal(config.modules['modifiers']?.source, 'template');
    assert.equal(config.modules['stock']?.source, 'platform');
  });

  it('lets a store override a word, and records that it did', () => {
    const config = resolveConfig(inputs(FOOD, { words: { category: 'Aisles' } }));

    assert.equal(config.words.category.many, 'Aisles');
    assert.equal(config.words.category.one, 'Aisle');
    assert.equal(config.words.category.source, 'store');
    // Everything else still comes from the template.
    assert.equal(config.words.product.source, 'template');
  });

  it('lets a store switch a module on AND off', () => {
    // Both directions, because "the merchant can change any of it later in Settings"
    // (Industries.dc.html) is not only about turning things on.
    const config = resolveConfig(inputs(FOOD, { modules: { stock: true, table: false } }));

    assert.equal(config.modules['stock']?.enabled, true);
    assert.equal(config.modules['stock']?.source, 'store');
    assert.equal(config.modules['table']?.enabled, false);
    assert.equal(config.modules['table']?.source, 'store');
  });

  it('falls back to the platform word for a key the template does not rename', () => {
    // config_is_words permits a SUBSET of the four keys, so this is a real state.
    const partial = { ...FOOD, words: { product: 'Menu items' } };
    const config = resolveConfig(inputs(partial));

    assert.equal(config.words.product.many, 'Menu items');
    assert.equal(config.words.catalog.many, PLATFORM_WORDS.catalog);
    assert.equal(config.words.catalog.source, 'platform');
  });

  it('resolves a store with no template at all', () => {
    // A half-onboarded store: Onboarding's first question is the business type, and the store
    // has to render before it is answered.
    const config = resolveConfig(inputs(null));

    assert.equal(config.template, null);
    for (const key of WORD_KEYS) {
      assert.equal(config.words[key].many, PLATFORM_WORDS[key]);
      assert.equal(config.words[key].source, 'platform');
    }
    assert.equal(Object.values(config.modules).every((m) => !m.enabled), true);
    assert.deepEqual(config.attributes, []);
    assert.deepEqual(config.orderSteps, []);
  });

  it('ignores a blank override rather than blanking the word', () => {
    const config = resolveConfig(inputs(FOOD, { words: { category: '   ' } }));
    assert.equal(config.words.category.many, 'Sections');
    assert.equal(config.words.category.source, 'template');
  });

  it('is pure — the result cannot mutate the inputs', () => {
    // The server caches the inputs, so a caller that edited the result would poison them.
    const source = inputs(FOOD);
    const config = resolveConfig(source);

    const step = config.orderSteps[0];
    assert.ok(step);
    step.label = 'Tampered';
    const attribute = config.attributes[0];
    assert.ok(attribute);
    attribute.name = 'Tampered';
    config.productFlags.push('tampered');

    assert.equal(FOOD.orderSteps[0]?.label, 'New');
    assert.equal(FOOD.attributes[0]?.name, 'Size');
    assert.deepEqual(FOOD.productFlags, []);
  });

  it('is deterministic — same inputs, same output, which is what lets the server hash it', () => {
    const a = JSON.stringify(resolveConfig(inputs(FOOD, { words: { product: 'Dishes' } })));
    const b = JSON.stringify(resolveConfig(inputs(FOOD, { words: { product: 'Dishes' } })));
    assert.equal(a, b);
  });
});

// ===========================================================================
describe('t() and has()', () => {
  it('t returns the plural by default and the singular on request', () => {
    const { t } = bindConfig(resolveConfig(inputs(FOOD)));

    // What Categories.dc.html needs: the heading composes the catalog word with the category
    // word — "Menu sections" — and the button is singular: "Add section".
    assert.equal(t('catalog'), 'Menu');
    assert.equal(t('category'), 'Sections');
    assert.equal(t('category', 'one'), 'Section');
    assert.equal(`${t('catalog')} ${t('category').toLowerCase()}`, 'Menu sections');
    assert.equal(`Add ${t('category', 'one').toLowerCase()}`, 'Add section');
  });

  it('the same component text reads differently for a different industry', () => {
    // The spine, in one assertion: no branch on industry name anywhere.
    const food = bindConfig(resolveConfig(inputs(FOOD)));
    const services = bindConfig(resolveConfig(inputs(SERVICES)));

    const heading = (c: { t: (k: 'catalog' | 'category') => string }) => `${c.t('catalog')} ${c.t('category').toLowerCase()}`;

    assert.equal(heading(food), 'Menu sections');
    assert.equal(heading(services), 'Services categories');
  });

  it('has reads the resolved module', () => {
    const { has } = bindConfig(resolveConfig(inputs(FOOD)));
    assert.equal(has('modifiers'), true);
    assert.equal(has('stock'), false);
  });

  it('has THROWS on a module that does not exist', () => {
    // The whole reason: `has('stok')` returning false would hide stock tracking from every
    // store while looking exactly like stock tracking switched off. V002 refuses the same
    // typo at the column with a foreign key; a component's typo is invisible to the database.
    const { has } = bindConfig(resolveConfig(inputs(FOOD)));
    assert.throws(() => has('stok'), /no such module/);
    assert.throws(() => has('stok'), /modifiers/, 'and it names the ones that do exist');
  });

  it('t throws on a key that is not one of the four', () => {
    const { t } = bindConfig(resolveConfig(inputs(FOOD)));
    // Unreachable in TypeScript; reachable from the JavaScript still being replaced.
    assert.throws(() => t('prodcut' as 'product'), /not a word this platform renames/);
  });
});
