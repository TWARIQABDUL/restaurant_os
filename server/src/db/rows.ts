// server/src/db/rows.ts — milestone 11.
//
// The ONE file that knows where the generated row types live. §2.1: "Row types are
// generated from the database schema and committed. A column rename then fails tsc
// instead of failing at runtime inside a repository method." Every repository reads
// its shapes from here.
//
// The import is a relative path into packages/core rather than '@vendlyfy/core'
// because npm workspaces are deferred to milestone 12 (§4.6) — nothing needed the
// package to be resolvable by name until the config resolver does. Milestone 12
// changes the one specifier below and nothing else.
//
// `import type` is not decoration: it is what makes this erasable. packages/core's
// generated module has one runtime export (TABLE_NAMES), so a value import would
// need real module resolution at run time, which without workspaces there is none
// of. verbatimModuleSyntax (tsconfig.base.json) makes the type-only form mandatory
// rather than remembered, so this cannot regress into a runtime dependency.

export type {
  PlatformMembersRole,
  PlatformMembersRow,
  RiderProfilesRow,
  RolePermissionsRow,
  RolePermissionsScope,
  StoreMembersRole,
  StoreMembersRow,
  StorePaymentMethodsRow,
  StorePayoutSettingsRow,
  StorePickupSettingsRow,
  StoresRow,
  StoresStatus,
  UsersRow,
  UsersScope,
  WalletsRow,
  WithdrawalsRow,
  WithdrawalsStatus,
} from '../../../packages/core/src/generated/database.ts';
