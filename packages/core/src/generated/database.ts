// GENERATED FILE — DO NOT EDIT.
//
// Written by `npm run db:types` from the live schema. CI regenerates it and
// fails if the result differs, so this cannot drift from the migrations.
//
// Two conversions worth knowing, both deliberate:
//   * numeric  -> string   node-postgres returns these as strings, exactly. A
//                          `number` here would invite arithmetic that loses cents.
//   * bigint   -> string   it exceeds Number.MAX_SAFE_INTEGER.

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
  platform_members: PlatformMembersRow;
  role_permissions: RolePermissionsRow;
  store_members: StoreMembersRow;
  stores: StoresRow;
  users: UsersRow;
}

/** Table names as a value, so a runtime check can be exhaustive. */
export const TABLE_NAMES = [
  'platform_members',
  'role_permissions',
  'store_members',
  'stores',
  'users',
] as const;

export type TableName = (typeof TABLE_NAMES)[number];
