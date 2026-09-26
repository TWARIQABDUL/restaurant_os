// client/src/auth/passwordRules.ts — milestone 15.
//
// Auth renders the rules as a LIVE CHECKLIST beside the field, ticking as you type. That needs the rules
// evaluated in the browser — a round trip per keystroke is not a checklist.
//
// SO THIS IS A SECOND IMPLEMENTATION, and that is a thing worth being uncomfortable about. The server's
// is authoritative (server/src/auth/password.ts) and refuses anything this misses; this one exists only
// to show progress. Two rules are kept identical by being trivial; the third is deliberately LOOSER here
// than on the server, so the checklist never shows three ticks for something the server will reject —
// the failure mode that makes a person press a button and be told no.
//
// The labels come from the server (GET /api/password/rules, and the invite payload) rather than being
// written here, so the wording cannot drift even though the evaluation is local.

export type LocalRule = { label: string; passed: boolean };

/** The three, in the board's order. Labels are supplied by the server. */
export function evaluateRules(
  labels: readonly string[],
  password: string,
  context: { email?: string | null; storeName?: string | null; phone?: string | null } = {},
): LocalRule[] {
  const lower = password.toLowerCase();
  const digits = password.replace(/[^0-9]/g, '');

  const forbidden: string[] = [];
  if (context.storeName != null) {
    for (const word of context.storeName.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length >= 3) forbidden.push(word);
    }
  }
  if (context.email != null) {
    const local = context.email.split('@')[0]?.toLowerCase() ?? '';
    if (local.length >= 3) forbidden.push(local);
  }
  const phoneDigits = context.phone == null ? '' : context.phone.replace(/[^0-9]/g, '');
  const looksLikePhone =
    phoneDigits.length >= 6 && digits.length >= 6 && (digits.includes(phoneDigits) || phoneDigits.includes(digits));

  const passed = [
    password.length >= 8,
    /\d/.test(password),
    password.length > 0 && !looksLikePhone && !forbidden.some((word) => lower.includes(word)),
  ];

  return labels.map((label, index) => ({ label, passed: passed[index] ?? false }));
}

export function allPassed(rules: readonly LocalRule[]): boolean {
  return rules.length > 0 && rules.every((rule) => rule.passed);
}
