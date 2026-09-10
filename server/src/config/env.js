/**
 * Boot-time environment assertions.
 *
 * config/supabase.js already refuses to start on a missing or wrong-role
 * service key. This does the same for the other settings where a wrong value
 * fails silently and expensively rather than loudly:
 *
 *   - JWT_SECRET was read straight into jwt.sign with no check at all. A
 *     missing one throws at first login; a weak or placeholder one is worse,
 *     because everything works — including forged tokens for any role on any
 *     tenant.
 *
 *   - MOMO_ENVIRONMENT defaults to 'sandbox', and render.yaml hardcoded it.
 *     Deployed as-is, real customers get sandbox prompts, no money moves, and
 *     it looks like it worked, because the sandbox answers SUCCESSFUL.
 */

const PLACEHOLDER_SECRETS = new Set([
  'your_jwt_secret',
  'your_jwt_secret_here',
  'changeme',
  'secret',
]);

function fail(lines) {
  console.error(`\n${lines.join('\n')}\n`);
  process.exit(1);
}

function assertEnv() {
  const isProduction = process.env.NODE_ENV === 'production';
  const problems = [];

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    problems.push('  JWT_SECRET is not set. Generate one: openssl rand -base64 48');
  } else {
    const normalized = secret.trim().toLowerCase();
    if (PLACEHOLDER_SECRETS.has(normalized) || normalized.startsWith('your_')) {
      problems.push('  JWT_SECRET is still the template placeholder. Generate a real one: openssl rand -base64 48');
    } else if (secret.length < 32) {
      problems.push(`  JWT_SECRET is only ${secret.length} characters. Use at least 32: openssl rand -base64 48`);
    }
  }

  if (isProduction) {
    const momoEnv = process.env.MOMO_ENVIRONMENT || 'sandbox';
    const momoUrl = process.env.MOMO_BASE_URL || '';
    const collectionConfigured = Boolean(process.env.MOMO_COLLECTION_API_KEY);

    // Deliberate escape hatch: a staging or soak-test deployment legitimately
    // runs NODE_ENV=production against the MoMo sandbox. Requiring it to be
    // named explicitly means that choice is visible in the dashboard, rather
    // than being the accident this check exists to catch.
    const sandboxAllowed = process.env.MOMO_ALLOW_SANDBOX === 'true';

    // Only an actual payments deployment needs to care — a build without MoMo
    // credentials is not collecting money and shouldn't be blocked.
    if (collectionConfigured && !sandboxAllowed && (momoEnv === 'sandbox' || momoUrl.includes('sandbox'))) {
      problems.push(
        '  MOMO_ENVIRONMENT is "sandbox" but NODE_ENV is "production". Sandbox answers\n' +
        '  SUCCESSFUL without moving any money, so this would look like it worked while\n' +
        '  every order went uncollected.\n' +
        '\n' +
        '  For a live deployment, set:\n' +
        '    MOMO_ENVIRONMENT=production\n' +
        '    MOMO_BASE_URL=https://proxy.momoapi.mtn.com\n' +
        '    MOMO_TARGET_ENVIRONMENT=mtnrwanda\n' +
        '    MOMO_CURRENCY=RWF\n' +
        '\n' +
        '  If this deployment is MEANT to run against the sandbox (staging, soak test),\n' +
        '  set MOMO_ALLOW_SANDBOX=true to say so explicitly.'
      );
    }

    if (!process.env.CLIENT_URL) {
      problems.push('  CLIENT_URL is not set. Socket.io CORS would fall back to localhost.');
    }
  }

  if (problems.length > 0) {
    fail(['Refusing to start — environment is not safe to run:', '', ...problems]);
  }
}

module.exports = { assertEnv };
