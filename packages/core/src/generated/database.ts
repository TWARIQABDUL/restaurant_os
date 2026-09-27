// GENERATED FILE — DO NOT EDIT.
//
// Written by `npm run db:types` from the live schema. CI regenerates it and
// fails if the result differs, so this cannot drift from the migrations.
//
// Two conversions worth knowing, both deliberate:
//   * numeric  -> string   node-postgres returns these as strings, exactly. A
//                          `number` here would invite arithmetic that loses cents.
//   * bigint   -> string   it exceeds Number.MAX_SAFE_INTEGER.

/** `audit_log.category`, from its CHECK constraint. */
export type AuditLogCategory =
  | 'sensitive'
  | 'money'
  | 'store'
  | 'config'
  | 'access';

/**
 * Every admin action and every sensitive view, chained by hash so that editing or removing an entry is detectable even by somebody who can turn the triggers off.
 */
export interface AuditLogRow {
  id: string;
  sequence: string;
  category: AuditLogCategory;
  /** A stable code for querying, open by design: the log never refuses an entry because nobody declared its kind yet. */
  action: string;
  summary: string;
  detail: string | null;
  actor_id: string | null;
  actor_label: string;
  actor_role: string | null;
  store_id: string | null;
  store_label: string | null;
  /** What the entry is about, as loose text and an id rather than a foreign key — the one place in this schema where that is correct. Evidence must outlive its subject. */
  subject_type: string | null;
  subject_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  session_verified_at: Date | null;
  context: unknown;
  previous_hash: string | null;
  /** sha256 over the previous hash and this entry's own fields. Recomputed and checked by verify_audit_chain(). */
  entry_hash: string;
  created_at: Date;
}

/** `auth_codes.purpose`, from its CHECK constraint. */
export type AuthCodesPurpose =
  | 'platform_two_step'
  | 'password_reset';

/**
 * A short code sent out of band: the Vendlyfy team's 2-step code, and a password reset. Hashed at rest and good once, with attempts bounded at the column so no endpoint can forget to bound them.
 */
export interface AuthCodesRow {
  id: string;
  user_id: string;
  purpose: AuthCodesPurpose;
  code_hash: Uint8Array;
  attempts: number;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

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
  /** The line's "pick several" option value ids, sorted and comma-joined; empty for a line with none. Denormalised from cart_item_option_values so that "same product, same options" is a unique key the database can enforce, and held to it by cart_items_signature_agrees. */
  option_signature: string;
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
  /** A code the customer typed and the cart is holding. What it is WORTH is decided by apply_promo_code() at placement, against the order — never stored here. */
  promo_code: string | null;
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

/** `complaint_events.actor_side`, from its CHECK constraint. */
export type ComplaintEventsActorSide =
  | 'customer'
  | 'store'
  | 'rider'
  | 'platform'
  | 'system';

/** `complaint_events.event_type`, from its CHECK constraint. */
export type ComplaintEventsEventType =
  | 'filed'
  | 'resolved'
  | 'rejected'
  | 'escalated'
  | 'reopened'
  | 'refund_requested'
  | 'platform_refunded'
  | 'platform_rejected'
  | 'note';

/** `complaint_events.to_status`, from its CHECK constraint. */
export type ComplaintEventsToStatus =
  | 'open'
  | 'escalated'
  | 'resolved'
  | 'rejected'
  | 'open'
  | 'escalated'
  | 'resolved'
  | 'rejected';

/**
 * The complaint thread: append-only, totally ordered per complaint, and chained so the status and the timeline cannot disagree. The CASCADE above is unreachable — the append-only trigger refuses the delete — which is deliberate: a complaint, once filed, stays.
 */
export interface ComplaintEventsRow {
  id: string;
  complaint_id: string;
  store_id: string;
  sequence: number;
  event_type: ComplaintEventsEventType;
  from_status: string | null;
  to_status: ComplaintEventsToStatus;
  /** The four groups the boards colour separately, plus system. Not the role: actor_id and the memberships hold that. */
  actor_side: ComplaintEventsActorSide;
  actor_id: string | null;
  actor_scope: string | null;
  note: string | null;
  created_at: Date;
}

/** `complaint_evidence.kind`, from its CHECK constraint. */
export type ComplaintEvidenceKind =
  | 'photo'
  | 'document'
  | 'location_log'
  | 'other';

/** `complaint_evidence.side`, from its CHECK constraint. */
export type ComplaintEvidenceSide =
  | 'customer'
  | 'store'
  | 'rider'
  | 'platform';

/**
 * Photos, documents and logs attached to a complaint, labelled by the side that produced them. Insert-only: evidence that can be withdrawn after the fact is not evidence.
 */
export interface ComplaintEvidenceRow {
  id: string;
  complaint_id: string;
  store_id: string;
  side: ComplaintEvidenceSide;
  kind: ComplaintEvidenceKind;
  label: string;
  storage_key: string | null;
  content_type: string | null;
  byte_size: string | null;
  uploaded_by: string | null;
  created_at: Date;
}

/**
 * Every move a complaint may make. Enforced by a trigger, so an illegal jump is refused by the database rather than prevented by whichever code path remembered.
 */
export interface ComplaintStatusTransitionsRow {
  from_status: string;
  to_status: string;
  description: string;
}

/** `complaints.reason_code`, from its CHECK constraint. */
export type ComplaintsReasonCode =
  | 'item_missing'
  | 'wrong_item'
  | 'quality_problem'
  | 'arrived_late'
  | 'other';

/** `complaints.status`, from its CHECK constraint. */
export type ComplaintsStatus =
  | 'open'
  | 'escalated'
  | 'resolved'
  | 'rejected';

/**
 * A customer's complaint about one order. Current state only: the thread is in complaint_events, and the timeline there is the record a dispute is argued from.
 */
export interface ComplaintsRow {
  id: string;
  /** Platform-wide, gaps allowed. Shown as C-nnn to the merchant and D-nnn to Vendlyfy once escalated — one complaint, two prefixes. */
  reference_number: string;
  store_id: string;
  order_id: string;
  customer_user_id: string | null;
  reason_code: ComplaintsReasonCode;
  detail: string;
  status: ComplaintsStatus;
  closed_by: string | null;
  /** When the MERCHANT last closed it, by resolving or rejecting — not proof that it is closed now. A reopened complaint keeps this and returns to open. */
  closed_at: Date | null;
  escalated_by: string | null;
  escalated_at: Date | null;
  decided_by: string | null;
  decided_at: Date | null;
  decision: string | null;
  reopened_count: number;
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
  /** The IANA zone a new store in this country starts with. A default, not a constraint: a country can span zones and a merchant may correct it. */
  default_time_zone: string;
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
 * A customer's saved delivery addresses. No store_id: V001 makes a customer belong to exactly one store, so an address's store is its owner's.
 */
export interface CustomerAddressesRow {
  id: string;
  user_id: string;
  label: string;
  address: string;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * The areas a zone covers. An area belongs to exactly ONE zone per store, or checkout cannot say which fee applies.
 */
export interface DeliveryZoneAreasRow {
  zone_id: string;
  store_id: string;
  area_name: string;
  created_at: Date;
}

/**
 * Where a store delivers, for how much, and how long it takes. A zone covers named areas — see delivery_zone_areas.
 */
export interface DeliveryZonesRow {
  id: string;
  store_id: string;
  name: string;
  fee_amount: string;
  eta_min_minutes: number;
  eta_max_minutes: number;
  is_active: boolean;
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

/** `kyc_checks.check_code`, from its CHECK constraint. */
export type KycChecksCheckCode =
  | 'document_genuine'
  | 'face_in_view'
  | 'liveness'
  | 'face_matches_document'
  | 'name_matches_registration'
  | 'not_used_by_another_store';

/** `kyc_checks.outcome`, from its CHECK constraint. */
export type KycChecksOutcome =
  | 'pass'
  | 'warn'
  | 'fail';

/**
 * The six automatic checks AdminKYC lists, one row each, with the vendor's own result kept whole beside our summary of it.
 */
export interface KycChecksRow {
  id: string;
  submission_id: string;
  store_id: string;
  check_code: KycChecksCheckCode;
  outcome: KycChecksOutcome;
  note: string | null;
  vendor_name: string | null;
  vendor_result: unknown;
  ran_at: Date;
}

/** `kyc_documents.part`, from its CHECK constraint. */
export type KycDocumentsPart =
  | 'id_front'
  | 'id_back'
  | 'face_video';

/**
 * The three parts of a submission, with a per-part review outcome so that a redo can ask for one photo and leave the other two accepted. Superseded rows stay: what was sent first is part of the record.
 */
export interface KycDocumentsRow {
  id: string;
  submission_id: string;
  store_id: string;
  part: KycDocumentsPart;
  storage_key: string;
  content_type: string;
  byte_size: string | null;
  quality: string | null;
  quality_note: string | null;
  review_outcome: string | null;
  /** When the bytes may be deleted. NULL because the retention period is a placeholder in the design — one of the two things Part 8 says to answer before this phase ships. */
  retain_until: Date | null;
  purged_at: Date | null;
  superseded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** `kyc_extracted_fields.field_key`, from its CHECK constraint. */
export type KycExtractedFieldsFieldKey =
  | 'full_name'
  | 'id_number'
  | 'date_of_birth'
  | 'document_expires_on'
  | 'typed_name';

/** `kyc_extracted_fields.verdict`, from its CHECK constraint. */
export type KycExtractedFieldsVerdict =
  | 'match'
  | 'differs'
  | 'unread';

/**
 * What was read off the document and whether it agrees with what the merchant typed. Display-safe throughout: the ID number appears here masked, so reading this table is not a sensitive view.
 */
export interface KycExtractedFieldsRow {
  submission_id: string;
  store_id: string;
  field_key: KycExtractedFieldsFieldKey;
  display_value: string;
  verdict: KycExtractedFieldsVerdict;
  created_at: Date;
}

/**
 * Every move a submission may make. approved and rejected are terminal — "Start again" is a NEW submission, because a rejection is part of the record.
 */
export interface KycStatusTransitionsRow {
  from_status: string;
  to_status: string;
  description: string;
}

/** `kyc_submissions.document_type`, from its CHECK constraint. */
export type KycSubmissionsDocumentType =
  | 'national_id'
  | 'passport';

/** `kyc_submissions.status`, from its CHECK constraint. */
export type KycSubmissionsStatus =
  | 'submitted'
  | 'in_review'
  | 'redo_requested'
  | 'approved'
  | 'rejected';

/**
 * One identity check. Holds the masked number, the encrypted number and a keyed fingerprint — never the number itself in readable form.
 */
export interface KycSubmissionsRow {
  id: string;
  reference_number: string;
  store_id: string;
  subject_user_id: string;
  document_type: KycSubmissionsDocumentType;
  status: KycSubmissionsStatus;
  id_number_masked: string | null;
  /** Encrypted outside the database, with a key that is not in it. Readable only through reveal_kyc_id_number(), which writes an audit entry first. */
  id_number_encrypted: Uint8Array | null;
  encryption_key_id: string | null;
  /** A keyed hash for duplicate detection, computed outside the database with a pepper. Deliberately NOT unique: one person may own two stores. */
  id_number_fingerprint: string | null;
  full_name: string | null;
  date_of_birth: Date | null;
  document_expires_on: Date | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  decision_note: string | null;
  submitted_at: Date;
  checks_completed_at: Date | null;
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

/**
 * One row per device a person uses, identified by a server-issued cookie. Holds the per-device sound preference the design asks for, because there is no browser storage to hold it in.
 */
export interface NotificationDevicesRow {
  id: string;
  user_id: string;
  device_token: string;
  label: string | null;
  sound_enabled: boolean;
  last_seen_at: Date;
  created_at: Date;
  updated_at: Date;
}

/**
 * Per person, per store: the "mark all as read" watermark and when they last had the inbox open.
 */
export interface NotificationInboxStateRow {
  user_id: string;
  store_id: string;
  all_read_before: Date | null;
  last_seen_at: Date | null;
  updated_at: Date;
}

/**
 * One row per person per notification they opened. A broadcast read by one manager stays unread for the others, which is what the per-person dot means.
 */
export interface NotificationReadsRow {
  notification_id: string;
  user_id: string;
  read_at: Date;
}

/** `notification_types.audience`, from its CHECK constraint. */
export type NotificationTypesAudience =
  | 'store_staff'
  | 'customer';

/** `notification_types.subject`, from its CHECK constraint. */
export type NotificationTypesSubject =
  | 'order'
  | 'complaint'
  | 'review'
  | 'withdrawal'
  | 'store';

/** `notification_types.tone`, from its CHECK constraint. */
export type NotificationTypesTone =
  | 'info'
  | 'good'
  | 'bad'
  | 'attention'
  | 'progress';

/**
 * The kinds of notification, seeded. A type says who may see it, which values the client needs and where it leads — so none of that is repeated on every row.
 */
export interface NotificationTypesRow {
  code: string;
  audience: NotificationTypesAudience;
  /** Whose inbox a store broadcast reaches. Payouts do not reach a manager, per Auth's own description of the role. */
  visible_to_roles: string[];
  tone: NotificationTypesTone;
  subject: NotificationTypesSubject;
  route: string;
  required_payload_keys: string[];
  is_alert: boolean;
  description: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

/** `notifications.audience`, from its CHECK constraint. */
export type NotificationsAudience =
  | 'store_staff'
  | 'customer';

/**
 * One row per event, not per reader. A store broadcast has no user_id and is filtered by the type's roles; a customer's own notification names them. The words are composed at read time from the type and the payload.
 */
export interface NotificationsRow {
  id: string;
  store_id: string;
  type_code: string;
  audience: NotificationsAudience;
  user_id: string | null;
  /** The values the sentence needs — order number, amount, a name. Never the sentence: that is the industry template's, and it changes when a store changes template. */
  payload: unknown;
  order_id: string | null;
  complaint_id: string | null;
  review_id: string | null;
  withdrawal_id: string | null;
  idempotency_key: string;
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

/** `order_discounts.source`, from its CHECK constraint. */
export type OrderDiscountsSource =
  | 'promotion'
  | 'manual';

/**
 * Every reduction of an order, with where it came from. orders.discount_amount must equal their sum, which is what stops a discount being a number a client sent.
 */
export interface OrderDiscountsRow {
  id: string;
  order_id: string;
  store_id: string;
  source: OrderDiscountsSource;
  promotion_id: string | null;
  code: string | null;
  amount: string;
  reason: string | null;
  created_by: string | null;
  created_at: Date;
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
  /** Derived, never passed in: rider when there is a rider, NULL otherwise. It exists only to carry the composite FK that makes assigning a manager or a customer as the rider unrepresentable. */
  rider_member_role: string | null;
  /** What the rider collects for a cash order: total_amount rounded to the currency's cash step. NULL for anything not paid in cash. MAINTAINED BY orders_cash_due_derive — no writer sets it. rider_cash_settlements reconciles against THIS, never against total_amount. */
  cash_due_amount: string | null;
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
  /** At or below this many in stock, the storefront badges the product "Few left". Zero means never. Only meaningful when track_stock is true. */
  low_stock_threshold: number;
}

/** `promotions.discount_type`, from its CHECK constraint. */
export type PromotionsDiscountType =
  | 'percentage'
  | 'fixed_amount'
  | 'free_item';

/** `promotions.kind`, from its CHECK constraint. */
export type PromotionsKind =
  | 'code'
  | 'automatic';

/**
 * Promo codes and automatic promotions. The discount is one of three shapes, the window is a date range plus an optional day-and-hour rule, and the banner's words live here because Customize treats the banner as content.
 */
export interface PromotionsRow {
  id: string;
  store_id: string;
  kind: PromotionsKind;
  code: string | null;
  discount_type: PromotionsDiscountType;
  percent_off: string | null;
  amount_off: string | null;
  free_product_id: string | null;
  required_product_id: string | null;
  min_quantity: number | null;
  min_subtotal_amount: string | null;
  banner_title: string | null;
  banner_subtitle: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  /** ISO day numbers, 1 = Monday. Empty means every day. ISO rather than 0-6 because a weekend is {6,7} — contiguous — where Sunday-first splits it. */
  days_of_week: number[];
  time_from: string | null;
  time_to: string | null;
  /** No board draws a cap. It exists because a code with no cap is an unbounded claim on the merchant's own balance. NULL means no limit, so the default matches the boards exactly. */
  max_redemptions: number | null;
  max_redemptions_per_customer: number | null;
  is_active: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** `refunds.initiated_by`, from its CHECK constraint. */
export type RefundsInitiatedBy =
  | 'merchant'
  | 'platform';

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
  | 'queued'
  | 'approved'
  | 'rejected';

/**
 * A merchant's request, reviewed by the platform. Partial refunds are supported; the approved ones must sum to orders.refunded_amount.
 */
export interface RefundsRow {
  id: string;
  store_id: string;
  order_id: string;
  /** What the merchant asked for. Never changed afterwards, because it is what they argue from. */
  amount: string;
  reason_code: RefundsReasonCode;
  reason_note: string | null;
  status: RefundsStatus;
  requested_by: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  rejection_reason: string | null;
  created_at: Date;
  reference_number: string;
  /** What Vendlyfy granted, which the decision panel lets them lower or raise up to the order total. NULL until decided. */
  approved_amount: string | null;
  /** When the money left the wallet. A refund is approved exactly when this is set; queued is decided but unpaid. */
  settled_at: Date | null;
  complaint_id: string | null;
  initiated_by: RefundsInitiatedBy;
}

/**
 * The merchant's public reply, shown under the review. One per review, editable — which is why it is a table of its own rather than a column on an insert-only one.
 */
export interface ReviewRepliesRow {
  review_id: string;
  store_id: string;
  body: string;
  author_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** `review_reports.reason_code`, from its CHECK constraint. */
export type ReviewReportsReasonCode =
  | 'abusive'
  | 'personal_info'
  | 'not_a_customer'
  | 'spam';

/** `review_reports.status`, from its CHECK constraint. */
export type ReviewReportsStatus =
  | 'open'
  | 'upheld'
  | 'dismissed';

/**
 * A report against a review, decided by Vendlyfy. Upholding one hides the review; dismissing leaves it visible, which is what it was throughout.
 */
export interface ReviewReportsRow {
  id: string;
  review_id: string;
  store_id: string;
  reason_code: ReviewReportsReasonCode;
  note: string | null;
  reported_by: string | null;
  status: ReviewReportsStatus;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * A customer's rating of a product they bought, tied to the order line that proves it. Insert-only: a merchant can reply but cannot edit or remove a review, and only Vendlyfy can hide one.
 */
export interface ReviewsRow {
  id: string;
  store_id: string;
  /** Derived from the order line's variant and pinned to it by a trigger. It exists because every read of this table is by product. */
  product_id: string;
  order_id: string;
  order_item_id: string;
  customer_user_id: string;
  rating: number;
  body: string | null;
  /** Set only by moderate_review(), only by a Vendlyfy team member, and only after a report. A hidden review leaves the averages and the product page; it is not deleted. */
  hidden_at: Date | null;
  hidden_by: string | null;
  hidden_reason: string | null;
  created_at: Date;
}

/** `rider_cash_handovers.member_role`, from its CHECK constraint. */
export type RiderCashHandoversMemberRole =
  | 'rider';

/**
 * Each time a rider hands cash over, including part-way through a day — "Handed in at 12:00 − 6,000". A day is a running account, not one payment.
 */
export interface RiderCashHandoversRow {
  id: string;
  store_id: string;
  rider_user_id: string;
  member_role: RiderCashHandoversMemberRole;
  amount: string;
  handed_at: Date;
  received_by: string | null;
  note: string | null;
  created_at: Date;
}

/** `rider_cash_settlements.member_role`, from its CHECK constraint. */
export type RiderCashSettlementsMemberRole =
  | 'rider';

/**
 * Closing one rider's day. Figures are captured, not recomputed, so a settled record does not change when an order is later amended.
 */
export interface RiderCashSettlementsRow {
  id: string;
  store_id: string;
  rider_user_id: string;
  member_role: RiderCashSettlementsMemberRole;
  business_date: Date;
  expected_amount: string;
  handed_over_amount: string;
  counted_amount: string;
  /** Positive is short, negative is over. GENERATED from the three captured figures so it cannot be set independently of them. */
  gap_amount: string;
  gap_resolution: string | null;
  gap_order_id: string | null;
  gap_note: string | null;
  carried_over_settled_at: Date | null;
  carried_over_settled_by: string | null;
  closed_by: string | null;
  closed_at: Date;
}

/** `rider_profiles.availability`, from its CHECK constraint. */
export type RiderProfilesAvailability =
  | 'available'
  | 'off_duty';

/** `rider_profiles.member_role`, from its CHECK constraint. */
export type RiderProfilesMemberRole =
  | 'rider';

/**
 * A rider of one store. availability is what the rider sets; "on a delivery" is derived from their orders so the two can never disagree.
 */
export interface RiderProfilesRow {
  user_id: string;
  store_id: string;
  member_role: RiderProfilesMemberRole;
  plate_number: string;
  availability: RiderProfilesAvailability;
  availability_changed_at: Date;
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

/** `staff_invites.role`, from its CHECK constraint. */
export type StaffInvitesRole =
  | 'admin'
  | 'manager'
  | 'rider';

/**
 * An offer of a store membership, accepted by the invitee. The consent that makes adding somebody to a store safe — see milestone 11's POST /members, which refuses to do it without one.
 */
export interface StaffInvitesRow {
  id: string;
  store_id: string;
  /** Not a foreign key to users: the ordinary case is inviting somebody with no account yet. */
  email: string;
  role: StaffInvitesRole;
  invitee_name: string;
  token_hash: Uint8Array;
  invited_by: string | null;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  accepted_user_id: string | null;
  revoked_at: Date | null;
}

/**
 * When a store is open, one row per open day. A day with no row is closed. closes_at <= opens_at means it closes after midnight — see store_open_state().
 */
export interface StoreHoursRow {
  store_id: string;
  day_of_week: number;
  opens_at: string;
  /** Earlier than or equal to opens_at means the next day: 18:00-01:00 is a Monday row that closes on Tuesday. */
  closes_at: string;
  created_at: Date;
  updated_at: Date;
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

/**
 * Which methods a store offers. NO CREDENTIALS HERE: provider keys are secrets and do not belong in a table every repository method can read. Where they live is an open decision — see the foot of this file.
 */
export interface StorePaymentMethodsRow {
  store_id: string;
  payment_method_key: string;
  is_connected: boolean;
  connected_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** `store_payout_settings.settlement_mode`, from its CHECK constraint. */
export type StorePayoutSettingsSettlementMode =
  | 'manual'
  | 'automatic';

/**
 * Where a merchant's money goes and on what schedule. A payout is never converted — the merchant is paid in the store's own currency.
 */
export interface StorePayoutSettingsRow {
  store_id: string;
  payout_method_key: string;
  payout_phone: string;
  settlement_mode: StorePayoutSettingsSettlementMode;
  automatic_at: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Where and how soon a customer can collect. "Free · ready in 15 min". Absent when the store does not offer pickup.
 */
export interface StorePickupSettingsRow {
  store_id: string;
  address: string;
  ready_minutes: number;
  instructions: string | null;
  created_at: Date;
  updated_at: Date;
}

/** `store_themes.input_card_treatment`, from its CHECK constraint. */
export type StoreThemesInputCardTreatment =
  | 'flat'
  | 'outlined'
  | 'shadow';

/** `store_themes.input_harmony`, from its CHECK constraint. */
export type StoreThemesInputHarmony =
  | 'complementary'
  | 'analogous'
  | 'split'
  | 'mono';

/** `store_themes.input_heading_font`, from its CHECK constraint. */
export type StoreThemesInputHeadingFont =
  | 'modern'
  | 'editorial'
  | 'sport'
  | 'classic';

/** `store_themes.input_hero`, from its CHECK constraint. */
export type StoreThemesInputHero =
  | 'soft'
  | 'fill';

/** `store_themes.input_mood`, from its CHECK constraint. */
export type StoreThemesInputMood =
  | 'light'
  | 'warm'
  | 'dark';

/** `store_themes.input_shape`, from its CHECK constraint. */
export type StoreThemesInputShape =
  | 'sharp'
  | 'soft'
  | 'round';

/** `store_themes.status`, from its CHECK constraint. */
export type StoreThemesStatus =
  | 'draft'
  | 'published';

/**
 * A store's look. One draft and one published row. A published row is refused unless every text pair reaches 4.5:1 — the database's own half of ThemeStudio's promise, independent of the compiler that produced the colours.
 */
export interface StoreThemesRow {
  store_id: string;
  status: StoreThemesStatus;
  input_brand: string;
  /** NULL means "let Vendlyfy pick": the harmony decides. A value means the merchant chose it and the harmony is irrelevant. */
  input_accent: string | null;
  input_harmony: StoreThemesInputHarmony;
  input_mood: StoreThemesInputMood;
  input_shape: StoreThemesInputShape;
  input_heading_font: StoreThemesInputHeadingFont;
  input_card_treatment: StoreThemesInputCardTreatment;
  input_hero: StoreThemesInputHero;
  color_bg: string;
  color_surface: string;
  color_text: string;
  color_muted: string;
  color_border: string;
  color_primary: string;
  color_on_primary: string;
  color_accent: string;
  color_on_accent: string;
  color_tint: string;
  color_hero_bg: string;
  color_hero_text: string;
  is_dark: boolean;
  /** Derived, and checked: true exactly when the button colour is within 3:1 of the page. Components read it rather than re-measuring. */
  needs_outline: boolean;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
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
  /** The number shown on the storefront, as a tel: link. The shop's, not a person's — users.phone is that. */
  public_phone: string | null;
  /** The store's own clock, as an IANA name. Every "today", every opening hour and every closing time is read in it. Filled from the store's country when a writer does not give one. */
  time_zone: string;
  /** False while a merchant has paused new orders from the dashboard. Distinct from status, which is the platform's: pausing is a busy kitchen, suspension is a compliance decision. */
  accepting_orders: boolean;
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
  /** Bumped to sign out every device. A session token carries the version it was issued at and the guard compares; a password change therefore invalidates every other session, which is what Auth promises. */
  session_version: number;
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
  audit_log: AuditLogRow;
  auth_codes: AuthCodesRow;
  cart_item_option_values: CartItemOptionValuesRow;
  cart_items: CartItemsRow;
  carts: CartsRow;
  categories: CategoriesRow;
  complaint_events: ComplaintEventsRow;
  complaint_evidence: ComplaintEvidenceRow;
  complaint_status_transitions: ComplaintStatusTransitionsRow;
  complaints: ComplaintsRow;
  countries: CountriesRow;
  currencies: CurrenciesRow;
  customer_addresses: CustomerAddressesRow;
  delivery_zone_areas: DeliveryZoneAreasRow;
  delivery_zones: DeliveryZonesRow;
  industry_template_version_modules: IndustryTemplateVersionModulesRow;
  industry_template_version_product_flags: IndustryTemplateVersionProductFlagsRow;
  industry_template_versions: IndustryTemplateVersionsRow;
  industry_templates: IndustryTemplatesRow;
  kyc_checks: KycChecksRow;
  kyc_documents: KycDocumentsRow;
  kyc_extracted_fields: KycExtractedFieldsRow;
  kyc_status_transitions: KycStatusTransitionsRow;
  kyc_submissions: KycSubmissionsRow;
  modules: ModulesRow;
  momo_transactions: MomoTransactionsRow;
  notification_devices: NotificationDevicesRow;
  notification_inbox_state: NotificationInboxStateRow;
  notification_reads: NotificationReadsRow;
  notification_types: NotificationTypesRow;
  notifications: NotificationsRow;
  option_groups: OptionGroupsRow;
  option_values: OptionValuesRow;
  order_discounts: OrderDiscountsRow;
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
  promotions: PromotionsRow;
  refunds: RefundsRow;
  review_replies: ReviewRepliesRow;
  review_reports: ReviewReportsRow;
  reviews: ReviewsRow;
  rider_cash_handovers: RiderCashHandoversRow;
  rider_cash_settlements: RiderCashSettlementsRow;
  rider_profiles: RiderProfilesRow;
  role_permissions: RolePermissionsRow;
  staff_invites: StaffInvitesRow;
  store_hours: StoreHoursRow;
  store_members: StoreMembersRow;
  store_order_counters: StoreOrderCountersRow;
  store_payment_methods: StorePaymentMethodsRow;
  store_payout_settings: StorePayoutSettingsRow;
  store_pickup_settings: StorePickupSettingsRow;
  store_themes: StoreThemesRow;
  stores: StoresRow;
  users: UsersRow;
  wallet_ledger: WalletLedgerRow;
  wallets: WalletsRow;
  withdrawals: WithdrawalsRow;
}

/** Table names as a value, so a runtime check can be exhaustive. */
export const TABLE_NAMES = [
  'audit_log',
  'auth_codes',
  'cart_item_option_values',
  'cart_items',
  'carts',
  'categories',
  'complaint_events',
  'complaint_evidence',
  'complaint_status_transitions',
  'complaints',
  'countries',
  'currencies',
  'customer_addresses',
  'delivery_zone_areas',
  'delivery_zones',
  'industry_template_version_modules',
  'industry_template_version_product_flags',
  'industry_template_versions',
  'industry_templates',
  'kyc_checks',
  'kyc_documents',
  'kyc_extracted_fields',
  'kyc_status_transitions',
  'kyc_submissions',
  'modules',
  'momo_transactions',
  'notification_devices',
  'notification_inbox_state',
  'notification_reads',
  'notification_types',
  'notifications',
  'option_groups',
  'option_values',
  'order_discounts',
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
  'promotions',
  'refunds',
  'review_replies',
  'review_reports',
  'reviews',
  'rider_cash_handovers',
  'rider_cash_settlements',
  'rider_profiles',
  'role_permissions',
  'staff_invites',
  'store_hours',
  'store_members',
  'store_order_counters',
  'store_payment_methods',
  'store_payout_settings',
  'store_pickup_settings',
  'store_themes',
  'stores',
  'users',
  'wallet_ledger',
  'wallets',
  'withdrawals',
] as const;

export type TableName = (typeof TABLE_NAMES)[number];
