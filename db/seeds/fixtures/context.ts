// db/seeds/fixtures/context.ts
//
// What every fixture module shares: the connection, and the identifiers.
//
// THE IDS ARE FIXED, not generated. A developer who bookmarks
// /app/orders/5555.../ while building the Orders board should still be looking at
// the same order after the next `db:seed`. Generated uuids would make every
// re-seed invalidate every bookmark, every screenshot and every hand-written curl.
//
// The prefix says what kind of thing it is, so an id in a log line is readable
// without a lookup:
//
//   1111…  stores            5555…  orders
//   2222…  people            6666…  money (momo, refunds, withdrawals)
//   3333…  catalogue         7777…  support (complaints, reviews, notifications)
//   4444…  variants          8888…  KYC
//   9999…  promotions        aaaa…  generated volume

import type { Client, QueryResult, QueryResultRow } from 'pg';

export type Ctx = {
  client: Client;
  /** Generic so a caller that reads rows back can say what shape it expects. */
  sql: <R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => Promise<QueryResult<R>>;
  passwordHash: string;
  volume: number;
  step: (s: string) => void;
  info: (s: string) => void;
  ok: (s: string) => void;
};

/** A readable, stable uuid: `<prefix>-0000-4000-8000-<12 hex digits>`. */
export function id(prefix: string, n: number): string {
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

// ---------------------------------------------------------------------------
// Stores — §4.5's list, and the state each one is in exists to cover a screen.
// ---------------------------------------------------------------------------
export const STORE = {
  nyama: id('11111111', 1),
  inzu: id('11111111', 2),
  kicks: id('11111111', 3),
  ubwiza: id('11111111', 4),
  techhub: id('11111111', 5),
  deals4u: id('11111111', 6),
} as const;

// ThemeStudio and ShoeStores are milestone 13, and `store_themes` does not exist
// yet — so these are recorded here rather than inserted anywhere. They are the
// exact inputs ShoeStores.dc.html generates its three palettes from, which is what
// milestone 13's done-when has to reproduce.
export const THEME_INPUTS = {
  kicks: { brand: '#E4572E', accent: '#F4D35E', mood: 'light', shape: 'round', font: 'sport', card: 'shadow' },
  nyama: { brand: '#1D6B47', mood: 'light', shape: 'soft', font: 'modern', card: 'flat' },
  inzu: { brand: '#6B3E26', harmony: 'analogous', mood: 'warm', shape: 'sharp', font: 'classic', card: 'outlined' },
} as const;

// ---------------------------------------------------------------------------
// People. Staff and the Vendlyfy team are users.scope = 'platform'; customers are
// scope = 'store' and belong to one store (§5.4).
//
// NOTE, and it is the design's rather than mine: there are two Patricks on the
// boards — a Vendlyfy reviewer (AdminAudit, "Patrick Nsengimana") and a Nyama
// manager who declines an order (Notifications, "declined by Patrick"). Both are
// kept, with full names, so a developer reading a screen knows which one they are
// looking at.
// ---------------------------------------------------------------------------
export const STAFF = {
  aline: id('22222222', 1), //   owner, Nyama & Co.        — Dashboard greets her
  patrick: id('22222222', 2), // manager, Nyama & Co.      — declines an order
  eric: id('22222222', 3), //    rider, Nyama & Co.        — RAD 482 K
  claude: id('22222222', 4), //  rider, Nyama & Co.        — RAE 115 C
  olivier: id('22222222', 5), // rider, Nyama & Co.        — carries a cash debt
  kevin: id('22222222', 6), //   owner, Inzu Threads
  yves: id('22222222', 7), //    owner, Kigali Kicks
  claudine: id('22222222', 8), //owner, Ubwiza Beauty      — KYC in review
  habimana: id('22222222', 9), //owner, Kigali Tech Hub    — KYC redo asked for
  bosco: id('22222222', 10), //  owner, Deals4U            — suspended store
  fabrice: id('22222222', 11), //rider, Inzu Threads      — RAG 318 D
} as const;

export const TEAM = {
  grace: id('22222222', 21), //  Grace Kamanzi    — publishes templates, suspends stores
  olive: id('22222222', 22), //  Olive Mukeshimana — reveals an ID number
  diane: id('22222222', 23), //  Diane Uwimana    — decides refunds
  samuel: id('22222222', 24), // Samuel Rugamba   — invited, has not signed in
} as const;

export const CUSTOMER = {
  sandrine: id('22222222', 41), //  Nyama  — files the missing-item complaint
  pacifique: id('22222222', 42), // Nyama  — cold food, 2-star review
  jeanpaul: id('22222222', 43), //  Nyama  — wrong item, escalated to Vendlyfy
  grace: id('22222222', 44), //     Nyama  — late delivery, resolved
  aimable: id('22222222', 45), //   Nyama  — the new-order alert's customer
  alice: id('22222222', 46), //     Inzu   — wrong size, refunded
  hirwa: id('22222222', 47), //     Tech Hub — never arrived, disputed
} as const;

// ---------------------------------------------------------------------------
// Catalogue. Nyama's menu is Shop.dc.html's and Customize.dc.html's, to the
// franc — a developer building the storefront sees the artboard's own prices.
// ---------------------------------------------------------------------------
export const PRODUCT = {
  // Nyama & Co. — food
  chickenBurger: id('33333333', 1),
  beefBurger: id('33333333', 2),
  brochettePlate: id('33333333', 3),
  fries: id('33333333', 4),
  passionJuice: id('33333333', 5),
  veggieWrap: id('33333333', 6),
  mangoJuice: id('33333333', 7),
  chapati: id('33333333', 8),
  grilledChicken: id('33333333', 9),
  salad: id('33333333', 10),

  // Inzu Threads — fashion, and the one that carries the variant matrix
  linenTee: id('33333333', 21),
  denimJacket: id('33333333', 22),
  canvasTote: id('33333333', 23),
  kitengeShirt: id('33333333', 24),

  // Kigali Kicks — sneakers
  roadRunner: id('33333333', 41),
  courtLow: id('33333333', 42),

  // Kigali Tech Hub — the disputed earbuds
  earbuds: id('33333333', 61),
} as const;

export const CATEGORY = {
  burgers: id('33333333', 101),
  sides: id('33333333', 102),
  drinks: id('33333333', 103),
  grills: id('33333333', 104),
  tops: id('33333333', 121),
  outerwear: id('33333333', 122),
  bags: id('33333333', 123),
  sneakers: id('33333333', 141),
  audio: id('33333333', 161),
} as const;

export const GROUP = {
  size: id('33333333', 201), //    Inzu — pick one, a variant dimension
  colour: id('33333333', 202), //  Inzu — pick one, a variant dimension
  extras: id('33333333', 203), //  Nyama — pick several, priced per line
  sideChoice: id('33333333', 204), // Nyama — pick one, no price
  shoeSize: id('33333333', 205), // Kicks — pick one
} as const;

export const ORDER = {
  // One per status, so every column of the Orders board has a card in it.
  pending: id('55555555', 1),
  approved: id('55555555', 2),
  preparing: id('55555555', 3),
  ready: id('55555555', 4),
  assigned: id('55555555', 5),
  out: id('55555555', 6),
  delivered: id('55555555', 7),
  collected: id('55555555', 8),
  returned: id('55555555', 9),
  closedReturn: id('55555555', 10),
  rejected: id('55555555', 11),
  cancelled: id('55555555', 12),

  // The ones the money and support fixtures argue from.
  paidEscrow: id('55555555', 21), //   paid, still in escrow
  paidReleased: id('55555555', 22), // paid, released, partly refunded
  cashShort: id('55555555', 23), //    cash, rider handed in less than the total
  inzuRefunded: id('55555555', 24), // Inzu — wrong size, fully refunded
  techDisputed: id('55555555', 25), // Tech Hub — never arrived, escalated
  discounted: id('55555555', 26), //   a promo code applied
  lunchOffer: id('55555555', 27), //   the automatic two-burgers offer
} as const;

export const MOMO = {
  escrow: id('66666666', 1),
  released: id('66666666', 2),
  inzu: id('66666666', 3),
  tech: id('66666666', 4),
  inzuSecond: id('66666666', 5),
  failedPayout: id('66666666', 11),
} as const;

export const REFUND = {
  partial: id('66666666', 21), //  approved, paid — 3,000 of 12,500
  queued: id('66666666', 22), //   approved, waiting for funds — holds payouts
  rejected: id('66666666', 23), // rejected, with a reason
  inzuFull: id('66666666', 24), // approved, paid in full
} as const;

export const WITHDRAWAL = {
  paid: id('66666666', 41),
  failed: id('66666666', 42), // reversed, "account name mismatch"
} as const;

export const COMPLAINT = {
  open: id('77777777', 1), //       missing item, needs a reply
  escalated: id('77777777', 2), //  wrong item, with Vendlyfy
  resolved: id('77777777', 3), //   late delivery, resolved
  rejected: id('77777777', 4), //   rejected, reopenable
} as const;

export const REVIEW = {
  fiveStar: id('77777777', 21),
  fourStarReplied: id('77777777', 22),
  twoStarReplied: id('77777777', 23),
  oneStarReported: id('77777777', 24), // hidden by Vendlyfy after a report
  ratingOnly: id('77777777', 25), //     no words, just stars
  inzu: id('77777777', 26),
} as const;

export const KYC = {
  nyama: id('88888888', 1), //   approved
  inzu: id('88888888', 2), //    approved
  kicks: id('88888888', 3), //   approved
  ubwiza: id('88888888', 4), //  submitted — "we're checking your ID"
  techhub: id('88888888', 5), // redo requested — blurry ID back
} as const;

export const PROMO = {
  welcome10: id('99999999', 1), //  10% off, no cap
  soko100: id('99999999', 2), //    100 RWF off
  friday20: id('99999999', 3), //   expired yesterday
  onlyone: id('99999999', 4), //    one redemption, already used
  lunch: id('99999999', 11), //     automatic: two burgers, free fries
  newSeason: id('99999999', 12), // automatic: Inzu's banner
} as const;

export const ZONE = {
  centre: id('11111111', 101),
  suburbs: id('11111111', 102),
  inzuCity: id('11111111', 103),
} as const;

/** Rwandan mobile numbers, in the shape the boards print them. */
export const PHONE = {
  aline: '078 111 4412',
  patrick: '078 222 7781',
  eric: '078 333 1020',
  claude: '078 333 2041',
  olivier: '078 333 3062',
  kevin: '078 444 5503',
  sandrine: '078 543 6671',
  pacifique: '078 771 2290',
  jeanpaul: '078 118 0922',
  grace: '078 455 1209',
  aimable: '078 330 1180',
  alice: '078 662 4417',
  hirwa: '078 990 7723',
} as const;
