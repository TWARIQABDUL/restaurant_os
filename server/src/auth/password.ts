// server/src/auth/password.ts — milestone 15.
//
// The password rules, which are Auth's own three and not a policy invented here. The board renders them
// as a live checklist beside the field:
//
//   At least 8 characters
//   Includes a number
//   Not your phone number or store name
//
// MILESTONE 11 USED TEN CHARACTERS, as a floor chosen in the absence of a stated rule. The board states
// one, so eight it is — and the board's third rule is the interesting one, because it is worth more than
// two characters of length: a password that is the store's name is the first thing anybody guesses.
//
// THE RULES ARE RETURNED, NOT JUST CHECKED, so the client can render the same checklist from the same
// source. A client with its own copy of the list is a client that disagrees with the server about what
// is acceptable, and the person finds out after pressing the button.

export type PasswordRule = {
  /** The board's wording, verbatim. */
  label: string;
  passed: boolean;
};

export type PasswordContext = {
  /** The person's own phone, if known — the third rule compares against it. */
  phone?: string | null;
  /** Their store's name, if known. */
  storeName?: string | null;
  /** Their email, whose local part is as guessable as a phone. */
  email?: string | null;
};

function digitsOf(value: string): string {
  return value.replace(/[^0-9]/g, '');
}

/**
 * Evaluates the three rules.
 *
 * The third is deliberately generous about what "your store name" means: it is checked
 * case-insensitively, as a substring in either direction, and against the email's local part as well.
 * "Nyama & Co." should reject "nyama2024", and `aline@nyama.rw` should reject "aline123".
 */
export function checkPassword(password: string, context: PasswordContext = {}): PasswordRule[] {
  const lower = password.toLowerCase();
  const digits = digitsOf(password);

  const forbidden: string[] = [];
  if (context.storeName !== undefined && context.storeName !== null) {
    // "Nyama & Co." → "nyama", "co" — the words, not the punctuation.
    for (const word of context.storeName.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length >= 3) forbidden.push(word);
    }
  }
  if (context.email !== undefined && context.email !== null) {
    const local = context.email.split('@')[0]?.toLowerCase() ?? '';
    if (local.length >= 3) forbidden.push(local);
  }

  const phoneDigits = context.phone === undefined || context.phone === null ? '' : digitsOf(context.phone);
  const looksLikePhone =
    phoneDigits.length >= 6 && digits.length >= 6 && (digits.includes(phoneDigits) || phoneDigits.includes(digits));

  return [
    { label: 'At least 8 characters', passed: password.length >= 8 },
    { label: 'Includes a number', passed: /\d/.test(password) },
    {
      label: 'Not your phone number or store name',
      passed: password.length > 0 && !looksLikePhone && !forbidden.some((word) => lower.includes(word)),
    },
  ];
}

export function passwordIsStrong(password: string, context: PasswordContext = {}): boolean {
  return checkPassword(password, context).every((rule) => rule.passed);
}

/** The first rule that failed, for an error message that names one thing rather than three. */
export function firstPasswordProblem(password: string, context: PasswordContext = {}): string | null {
  return checkPassword(password, context).find((rule) => !rule.passed)?.label ?? null;
}
