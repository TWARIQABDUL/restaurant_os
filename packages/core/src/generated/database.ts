// GENERATED FILE — DO NOT EDIT.
//
// Written by `npm run db:types` from the live schema. CI regenerates it and
// fails if the result differs, so this cannot drift from the migrations.
//
// Two conversions worth knowing, both deliberate:
//   * numeric  -> string   node-postgres returns these as strings, exactly. A
//                          `number` here would invite arithmetic that loses cents.
//   * bigint   -> string   it exceeds Number.MAX_SAFE_INTEGER.

/**
 * The "pick several" choices on one line — Cheese and Extra sauce. The single-select choices are already the variant, so they are not repeated here.
 */
export interface CartItemOptionValuesRow {
  cart_item_id: string;
  option_value_id: string;
  cart_id: string;
}

/**
 * One line. A variant, a quantity, and any "pick several" option values chosen for this line — two lines of the same burger with different extras are two lines.
 */
export interface CartItemsRow {
  id: string;
  cart_id: string;
  variant_id: string;
  store_id: string;
  quantity: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * A cart, server-side. One per customer per store, or one per anonymous session per store. Survives a browser with storage disabled, which is the point.
 */
export interface CartsRow {
  id: string;
  store_id: string;
  user_id: string | null;
  anonymous_session_id: string | null;
  /** Seven days, as States.dc.html promises. A sweep deletes past this; nothing reads an expired cart. */
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

/**
 * A grouping on the storefront. The word for it comes from the industry template: Sections, Collections, Aisles, Rooms.
 */
export interface CategoriesRow {
  id: string;
  store_id: string;
  name: string;
  description: string;
  image_url: string | null;
  is_visible: boolean;
  position: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * Modules a version turns on by default. Absence means off. Merchants can still change these in Settings, which is what stores.config_overrides carries.
 */
export interface IndustryTemplateVersionModulesRow {
  template_id: string;
  version: number;
  module_key: string;
}

/**
 * Product flags available to stores on this version. Pharmacy carries prescription_required.
 */
export interface IndustryTemplateVersionProductFlagsRow {
  template_id: string;
  version: number;
  flag_key: string;
}

/** `industry_template_versions.status`, from its CHECK constraint. */
export type IndustryTemplateVersionsStatus =
  | 'draft'
  | 'published';

/**
 * One version of a template. A published version is IMMUTABLE, because stores pin to it — changing it would silently reconfigure every store on it.
 */
export interface IndustryTemplateVersionsRow {
  template_id: string;
  version: number;
  /** draft | published. Publishing is one-way: a new change is a new version, which is what makes a pinned version trustworthy. */
  status: IndustryTemplateVersionsStatus;
  words: unknown;
  attributes: unknown;
  order_steps: unknown;
  created_by: string | null;
  created_at: Date;
  published_at: Date | null;
}

/**
 * A business type a merchant can pick at sign-up. The configuration itself lives on its versions.
 */
export interface IndustryTemplatesRow {
  id: string;
  key: string;
  name: string;
  accent_color: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Feature gates a template can switch on. has(module) reads these. Adding one is a migration because a module without code behind it does nothing.
 */
export interface ModulesRow {
  key: string;
  label: string;
  description: string;
  created_at: Date;
}

/** `option_groups.select_mode`, from its CHECK constraint. */
export type OptionGroupsSelectMode =
  | 'one'
  | 'several';

/**
 * A choice offered on a product: Size, Colour, Spice level, Extras. select_mode = one makes it a variant dimension; several makes it priced add-ons on the line.
 */
export interface OptionGroupsRow {
  id: string;
  store_id: string;
  name: string;
  select_mode: OptionGroupsSelectMode;
  is_required: boolean;
  position: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * One choice within a group: M, Black, Hot, Cheese. price_delta is what choosing it adds.
 */
export interface OptionValuesRow {
  id: string;
  option_group_id: string;
  store_id: string;
  label: string;
  price_delta: string;
  is_available: boolean;
  position: number;
  created_at: Date;
  updated_at: Date;
}

/** `platform_members.role`, from its CHECK constraint. */
export type PlatformMembersRole =
  | 'super_admin';

/** `platform_members.user_scope`, from its CHECK constraint. */
export type PlatformMembersUserScope =
  | 'platform';

/**
 * The Vendlyfy team. A separate table from store_members so that granting a platform role is a different write, not a different string.
 */
export interface PlatformMembersRow {
  user_id: string;
  user_scope: PlatformMembersUserScope;
  role: PlatformMembersRole;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Which sections a product appears in. Deleting a section removes these rows and keeps the products — Categories.dc.html: "Its 6 products stay in your catalog."
 */
export interface ProductCategoriesRow {
  product_id: string;
  category_id: string;
  store_id: string;
  position: number;
}

/**
 * Flags a product can carry that components already know how to render — a badge on the card, an extra step at checkout, a note on the order.
 */
export interface ProductFlagsRow {
  key: string;
  label: string;
  description: string;
  created_at: Date;
}

/**
 * Which option groups a product offers. A store-wide group attached here to two products is what "shared option group" means — there is no copy.
 */
export interface ProductOptionGroupsRow {
  product_id: string;
  option_group_id: string;
  store_id: string;
  position: number;
}

/**
 * Flags on one product. Constrained to the flags the store's pinned industry template offers — see product_flag_offered_by_template.
 */
export interface ProductProductFlagsRow {
  product_id: string;
  store_id: string;
  flag_key: string;
}

/**
 * The combination a variant is: one option value per single-select group. Integrity of the whole matrix is checked at commit by product_variant_matrix_check.
 */
export interface ProductVariantValuesRow {
  variant_id: string;
  option_group_id: string;
  option_value_id: string;
  product_id: string;
}

/**
 * One purchasable combination. Every product has at least one — a product with no single-select options has exactly one default variant, so stock and SKU always live here and reserve_stock has one code path.
 */
export interface ProductVariantsRow {
  id: string;
  product_id: string;
  store_id: string;
  sku: string | null;
  /** NULL when the product does not track stock. Never both NULL and tracked: see product_variants_stock_matches_tracking. */
  stock_quantity: number | null;
  is_available: boolean;
  is_default: boolean;
  position: number;
  created_at: Date;
  updated_at: Date;
}

/** `products.status`, from its CHECK constraint. */
export type ProductsStatus =
  | 'draft'
  | 'active';

/**
 * What a store sells. Called menu items, products, medicines or services depending on the store's industry template — one table, read differently.
 */
export interface ProductsRow {
  id: string;
  store_id: string;
  name: string;
  description: string;
  /** The price a variant starts from. A variant price is this plus its option value deltas, computed at read time. */
  base_price: string;
  compare_at_price: string | null;
  cover_image_url: string | null;
  track_stock: boolean;
  status: ProductsStatus;
  position: number;
  created_at: Date;
  updated_at: Date;
}

/** `role_permissions.scope`, from its CHECK constraint. */
export type RolePermissionsScope =
  | 'platform'
  | 'store';

/**
 * What each role may do. Read by the authorization guard and rendered by Auth's invite screen and AdminTeam.
 */
export interface RolePermissionsRow {
  scope: RolePermissionsScope;
  /** Spans both scopes, so it is not a foreign key to either membership table. The scope/role pair is kept coherent by a CHECK. */
  role: string;
  permission: string;
}

/** `store_members.role`, from its CHECK constraint. */
export type StoreMembersRole =
  | 'owner'
  | 'admin'
  | 'manager'
  | 'rider';

/** `store_members.user_scope`, from its CHECK constraint. */
export type StoreMembersUserScope =
  | 'platform';

/**
 * Staff membership: one role for one person in one store. Many stores per person — that is the case Auth's store picker draws.
 */
export interface StoreMembersRow {
  user_id: string;
  /** Always platform. Carries the composite FK to users (id, scope) so a store-scoped customer cannot be given staff privileges. */
  user_scope: StoreMembersUserScope;
  store_id: string;
  role: StoreMembersRole;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** `stores.status`, from its CHECK constraint. */
export type StoresStatus =
  | 'pending'
  | 'active'
  | 'suspended';

/**
 * One merchant storefront. The unit that owns a catalogue, a wallet, staff and customers.
 */
export interface StoresRow {
  id: string;
  slug: string;
  name: string;
  custom_domain: string | null;
  country: string;
  selling_currency: string;
  /** pending | active | suspended. Verification state is separate: a store can be active with KYC outstanding. */
  status: StoresStatus;
  created_at: Date;
  updated_at: Date;
  industry_template_id: string | null;
  /** Pinned, not floating. Publishing a new template version does not move a store to it — AdminIndustries makes that an explicit rollout choice. */
  industry_template_version: number | null;
  /** What this merchant changed in Settings. Merged over the pinned version by the config resolver; the template is never edited per store. */
  config_overrides: unknown;
}

/** `users.scope`, from its CHECK constraint. */
export type UsersScope =
  | 'platform'
  | 'store';

/**
 * Identity only: email, phone, password. Roles live on store_members and platform_members.
 */
export interface UsersRow {
  id: string;
  /** platform = can hold memberships (staff, Vendlyfy team). store = a customer of one store. One email may have one platform row and one store row per store, each with its own password. */
  scope: UsersScope;
  store_id: string | null;
  email: string;
  phone: string | null;
  password_hash: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

/** Every table, for a repository layer that is generic over one. */
export interface Database {
  cart_item_option_values: CartItemOptionValuesRow;
  cart_items: CartItemsRow;
  carts: CartsRow;
  categories: CategoriesRow;
  industry_template_version_modules: IndustryTemplateVersionModulesRow;
  industry_template_version_product_flags: IndustryTemplateVersionProductFlagsRow;
  industry_template_versions: IndustryTemplateVersionsRow;
  industry_templates: IndustryTemplatesRow;
  modules: ModulesRow;
  option_groups: OptionGroupsRow;
  option_values: OptionValuesRow;
  platform_members: PlatformMembersRow;
  product_categories: ProductCategoriesRow;
  product_flags: ProductFlagsRow;
  product_option_groups: ProductOptionGroupsRow;
  product_product_flags: ProductProductFlagsRow;
  product_variant_values: ProductVariantValuesRow;
  product_variants: ProductVariantsRow;
  products: ProductsRow;
  role_permissions: RolePermissionsRow;
  store_members: StoreMembersRow;
  stores: StoresRow;
  users: UsersRow;
}

/** Table names as a value, so a runtime check can be exhaustive. */
export const TABLE_NAMES = [
  'cart_item_option_values',
  'cart_items',
  'carts',
  'categories',
  'industry_template_version_modules',
  'industry_template_version_product_flags',
  'industry_template_versions',
  'industry_templates',
  'modules',
  'option_groups',
  'option_values',
  'platform_members',
  'product_categories',
  'product_flags',
  'product_option_groups',
  'product_product_flags',
  'product_variant_values',
  'product_variants',
  'products',
  'role_permissions',
  'store_members',
  'stores',
  'users',
] as const;

export type TableName = (typeof TABLE_NAMES)[number];
