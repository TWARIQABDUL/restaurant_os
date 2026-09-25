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
 * Where the platform operates. A country's default currency is what a store signing up there sells in.
 */
export interface CountriesRow {
  code: string;
  name: string;
  default_currency_code: string;
  is_enabled: boolean;
  created_at: Date;
}

/** `currencies.rate_source`, from its CHECK constraint. */
export type CurrenciesRateSource =
  | 'feed'
  | 'manual';

/** `currencies.symbol_position`, from its CHECK constraint. */
export type CurrenciesSymbolPosition =
  | 'before'
  | 'after';

/** `currencies.thousands_separator`, from its CHECK constraint. */
export type CurrenciesThousandsSeparator =
  | ','
  | ' '
  | '.';

/**
 * How money is written, rounded and converted. The formatter in packages/core reads only these columns, so there is one implementation of "what does 3500 look like".
 */
export interface CurrenciesRow {
  code: string;
  name: string;
  symbol: string;
  symbol_position: CurrenciesSymbolPosition;
  decimals: number;
  thousands_separator: CurrenciesThousandsSeparator;
  /** Applied only to cash-on-delivery totals. A card or momo total is never rounded — that difference is exactly the kind that goes unnoticed for a month. */
  cash_rounding: string;
  is_enabled: boolean;
  is_default: boolean;
  rate_source: CurrenciesRateSource;
  /** Display conversion only: "≈ $2.40" beside the real price. The charge is always in the store's own currency. */
  usd_rate: string | null;
  rate_updated_at: Date | null;
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

/** `momo_transactions.direction`, from its CHECK constraint. */
export type MomoTransactionsDirection =
  | 'collection'
  | 'disbursement';

/** `momo_transactions.status`, from its CHECK constraint. */
export type MomoTransactionsStatus =
  | 'pending'
  | 'successful'
  | 'failed';

/**
 * One attempt at moving money through MTN MoMo. reference_id is the provider idempotency key and is reused on retry, never regenerated.
 */
export interface MomoTransactionsRow {
  id: string;
  store_id: string;
  order_id: string | null;
  direction: MomoTransactionsDirection;
  reference_id: string;
  phone: string;
  amount: string;
  currency: string;
  status: MomoTransactionsStatus;
  provider_status: string | null;
  provider_message: string | null;
  created_at: Date;
  resolved_at: Date | null;
  withdrawal_id: string | null;
  /** Which provider this attempt went through. The old schema assumed MTN; with Airtel and M-Pesa in the same table, reconciliation needs to know. */
  payment_method_key: string | null;
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

/**
 * Append-only record of every status change, with who and why. The audit a refund or a short cash payment is argued from.
 */
export interface OrderEventsRow {
  id: string;
  order_id: string;
  store_id: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  note: string | null;
  actor_id: string | null;
  actor_role: string | null;
  created_at: Date;
}

/**
 * The options chosen on one line, captured. Their deltas must sum to the line's options_amount — checked at commit.
 */
export interface OrderItemOptionValuesRow {
  order_item_id: string;
  option_value_id: string;
  order_id: string;
  group_name: string;
  value_label: string;
  price_delta: string;
}

/**
 * One line, with the name, price and options CAPTURED as they were. line_total_amount is GENERATED, so a line total cannot disagree with its own parts.
 */
export interface OrderItemsRow {
  id: string;
  order_id: string;
  store_id: string;
  variant_id: string;
  product_name: string;
  variant_label: string;
  sku: string | null;
  unit_price_amount: string;
  options_amount: string;
  quantity: number;
  line_total_amount: string;
  created_at: Date;
}

/**
 * Every move an order may make. Enforced by a trigger, so an illegal jump is refused by the database rather than prevented by whichever code path remembered.
 */
export interface OrderStatusTransitionsRow {
  from_status: string;
  to_status: string;
  description: string;
}

/** `orders.fulfilment_type`, from its CHECK constraint. */
export type OrdersFulfilmentType =
  | 'delivery'
  | 'pickup';

/** `orders.payment_status`, from its CHECK constraint. */
export type OrdersPaymentStatus =
  | 'unpaid'
  | 'paid'
  | 'refunded';

/** `orders.settlement_status`, from its CHECK constraint. */
export type OrdersSettlementStatus =
  | 'not_applicable'
  | 'pending'
  | 'released'
  | 'refunded';

/** `orders.status`, from its CHECK constraint. */
export type OrdersStatus =
  | 'pending'
  | 'approved'
  | 'preparing'
  | 'ready'
  | 'assigned'
  | 'out'
  | 'delivered'
  | 'collected'
  | 'returned'
  | 'closed_return'
  | 'rejected'
  | 'cancelled';

/**
 * One order. total_amount is GENERATED and the subtotal is checked against the lines at commit, so an order's total can never be a number someone chose.
 */
export interface OrdersRow {
  id: string;
  store_id: string;
  order_number: number;
  tracking_code: string;
  /** One per checkout attempt, from the client. A retried request carries the same key and collides here instead of placing a second order. */
  idempotency_key: string;
  customer_user_id: string | null;
  guest_name: string | null;
  guest_phone: string | null;
  guest_email: string | null;
  delivery_address: string | null;
  fulfilment_type: OrdersFulfilmentType;
  status: OrdersStatus;
  payment_method: string;
  payment_status: OrdersPaymentStatus;
  settlement_status: OrdersSettlementStatus;
  currency: string;
  subtotal_amount: string;
  delivery_fee_amount: string;
  discount_amount: string;
  total_amount: string;
  refunded_amount: string;
  /** What the rider says they collected. May be less than the total — Rider.dc.html: "Short by 2,000 RWF. Your manager will see the difference." */
  cash_reported_amount: string | null;
  cash_confirmed_at: Date | null;
  rider_user_id: string | null;
  placed_at: Date;
  paid_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Where an online method can be offered. MTN covers Rwanda and Uganda; M-Pesa is Kenya only.
 */
export interface PaymentMethodCountriesRow {
  payment_method_key: string;
  country_code: string;
}

/**
 * Which currencies a method can charge in, and the provider's limits in each.
 */
export interface PaymentMethodCurrenciesRow {
  payment_method_key: string;
  currency_code: string;
  min_amount: string;
  max_amount: string;
}

/** `payment_methods.kind`, from its CHECK constraint. */
export type PaymentMethodsKind =
  | 'online'
  | 'offline';

/** `payment_methods.status`, from its CHECK constraint. */
export type PaymentMethodsStatus =
  | 'draft'
  | 'live'
  | 'paused';

/**
 * How a customer can pay. Online methods carry a provider and a webhook; cash is offline and needs neither, which is why AdminPayments does not list it.
 */
export interface PaymentMethodsRow {
  key: string;
  name: string;
  short_name: string;
  kind: PaymentMethodsKind;
  customer_label: string;
  customer_hint: string;
  provider: string | null;
  webhook_url: string | null;
  /** draft | live | paused. Only a live method may be named on a new order — enforced by orders_payment_method_usable. */
  status: PaymentMethodsStatus;
  incident_note: string | null;
  position: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * Which features a plan includes. Absence is exclusion, so a new feature is off everywhere until granted deliberately.
 */
export interface PlanFeatureGrantsRow {
  plan_key: string;
  feature_key: string;
}

/**
 * Commercial entitlements, which are NOT the same axis as industry modules. A module is what a business type does; a feature is what a plan permits. See the note at the foot of this file.
 */
export interface PlanFeaturesRow {
  key: string;
  label: string;
  description: string;
  position: number;
  created_at: Date;
}

/**
 * What a store pays and what it gets. Prices are NULL until finance confirms them — see Part 9.
 */
export interface PlansRow {
  key: string;
  name: string;
  monthly_price: string | null;
  payment_fee_percent: string | null;
  withdrawal_fee: string | null;
  currency_code: string | null;
  /** NULL is unlimited. Enforced when a store admin creates a member, at milestone 11. */
  staff_account_limit: number | null;
  is_default: boolean;
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

/** `refunds.reason_code`, from its CHECK constraint. */
export type RefundsReasonCode =
  | 'item_missing'
  | 'wrong_item'
  | 'quality_problem'
  | 'arrived_late'
  | 'other';

/** `refunds.status`, from its CHECK constraint. */
export type RefundsStatus =
  | 'pending'
  | 'approved'
  | 'rejected';

/**
 * A merchant's request, reviewed by the platform. Partial refunds are supported; the approved ones must sum to orders.refunded_amount.
 */
export interface RefundsRow {
  id: string;
  store_id: string;
  order_id: string;
  amount: string;
  reason_code: RefundsReasonCode;
  reason_note: string | null;
  status: RefundsStatus;
  requested_by: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  rejection_reason: string | null;
  created_at: Date;
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

/**
 * Allocates order numbers per store. Starts at 1000 so the first order is not #1, which reads as a store with no customers.
 */
export interface StoreOrderCountersRow {
  store_id: string;
  next_order_number: number;
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
  /** Every store is on a plan. Defaults to the Starter plan rather than being nullable, because "no plan" is not a state the billing or entitlement code can read. */
  plan_key: string;
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

/** `wallet_ledger.entry_type`, from its CHECK constraint. */
export type WalletLedgerEntryType =
  | 'order_payment_received'
  | 'escrow_released_out'
  | 'escrow_released_in'
  | 'refund_paid'
  | 'withdrawal_reserved'
  | 'withdrawal_reversed'
  | 'adjustment';

/** `wallet_ledger.pot`, from its CHECK constraint. */
export type WalletLedgerPot =
  | 'pending'
  | 'available';

/**
 * Append-only. sum(amount) per pot IS that pot's balance, because every internal movement writes both sides. balance_after chains, so a missing row is detectable.
 */
export interface WalletLedgerRow {
  id: string;
  store_id: string;
  pot: WalletLedgerPot;
  sequence: string;
  entry_type: WalletLedgerEntryType;
  amount: string;
  balance_after: string;
  transfer_id: string | null;
  counterparty: string | null;
  order_id: string | null;
  momo_transaction_id: string | null;
  refund_id: string | null;
  withdrawal_id: string | null;
  /** Unique per store. A replayed webhook or a retried sweep posts the same key and gets the existing entry back instead of moving money twice. */
  idempotency_key: string;
  note: string | null;
  created_by: string | null;
  created_at: Date;
}

/**
 * A store's two pots. The balances are derived from wallet_ledger and maintained only by its trigger; a direct update is refused.
 */
export interface WalletsRow {
  store_id: string;
  currency: string;
  pending_balance: string;
  available_balance: string;
  updated_at: Date;
}

/** `withdrawals.initiated_by`, from its CHECK constraint. */
export type WithdrawalsInitiatedBy =
  | 'manual'
  | 'automatic';

/** `withdrawals.status`, from its CHECK constraint. */
export type WithdrawalsStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'rejected';

/**
 * A payout request. Funds leave available the moment it is requested, so the same money cannot be withdrawn twice while the first transfer is in flight.
 */
export interface WithdrawalsRow {
  id: string;
  store_id: string;
  amount: string;
  phone: string;
  status: WithdrawalsStatus;
  failure_reason: string | null;
  initiated_by: WithdrawalsInitiatedBy;
  idempotency_key: string;
  requested_by: string | null;
  reviewed_by: string | null;
  requested_at: Date;
  completed_at: Date | null;
}

/** Every table, for a repository layer that is generic over one. */
export interface Database {
  cart_item_option_values: CartItemOptionValuesRow;
  cart_items: CartItemsRow;
  carts: CartsRow;
  categories: CategoriesRow;
  countries: CountriesRow;
  currencies: CurrenciesRow;
  industry_template_version_modules: IndustryTemplateVersionModulesRow;
  industry_template_version_product_flags: IndustryTemplateVersionProductFlagsRow;
  industry_template_versions: IndustryTemplateVersionsRow;
  industry_templates: IndustryTemplatesRow;
  modules: ModulesRow;
  momo_transactions: MomoTransactionsRow;
  option_groups: OptionGroupsRow;
  option_values: OptionValuesRow;
  order_events: OrderEventsRow;
  order_item_option_values: OrderItemOptionValuesRow;
  order_items: OrderItemsRow;
  order_status_transitions: OrderStatusTransitionsRow;
  orders: OrdersRow;
  payment_method_countries: PaymentMethodCountriesRow;
  payment_method_currencies: PaymentMethodCurrenciesRow;
  payment_methods: PaymentMethodsRow;
  plan_feature_grants: PlanFeatureGrantsRow;
  plan_features: PlanFeaturesRow;
  plans: PlansRow;
  platform_members: PlatformMembersRow;
  product_categories: ProductCategoriesRow;
  product_flags: ProductFlagsRow;
  product_option_groups: ProductOptionGroupsRow;
  product_product_flags: ProductProductFlagsRow;
  product_variant_values: ProductVariantValuesRow;
  product_variants: ProductVariantsRow;
  products: ProductsRow;
  refunds: RefundsRow;
  role_permissions: RolePermissionsRow;
  store_members: StoreMembersRow;
  store_order_counters: StoreOrderCountersRow;
  stores: StoresRow;
  users: UsersRow;
  wallet_ledger: WalletLedgerRow;
  wallets: WalletsRow;
  withdrawals: WithdrawalsRow;
}

/** Table names as a value, so a runtime check can be exhaustive. */
export const TABLE_NAMES = [
  'cart_item_option_values',
  'cart_items',
  'carts',
  'categories',
  'countries',
  'currencies',
  'industry_template_version_modules',
  'industry_template_version_product_flags',
  'industry_template_versions',
  'industry_templates',
  'modules',
  'momo_transactions',
  'option_groups',
  'option_values',
  'order_events',
  'order_item_option_values',
  'order_items',
  'order_status_transitions',
  'orders',
  'payment_method_countries',
  'payment_method_currencies',
  'payment_methods',
  'plan_feature_grants',
  'plan_features',
  'plans',
  'platform_members',
  'product_categories',
  'product_flags',
  'product_option_groups',
  'product_product_flags',
  'product_variant_values',
  'product_variants',
  'products',
  'refunds',
  'role_permissions',
  'store_members',
  'store_order_counters',
  'stores',
  'users',
  'wallet_ledger',
  'wallets',
  'withdrawals',
] as const;

export type TableName = (typeof TABLE_NAMES)[number];
