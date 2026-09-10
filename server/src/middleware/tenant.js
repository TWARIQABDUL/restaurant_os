const supabase = require('../config/supabase');
const { isUpstreamTimeout } = require('../config/supabase');

/**
 * Resolve tenant from request.
 * Checks (in order): X-Tenant-Slug header, :tenantSlug URL param, or falls back to default tenant.
 */
async function resolveTenant(req, res, next) {
  try {
    const slug = req.headers['x-tenant-slug'] || req.params.tenantSlug;

    // Did the caller actually name a store, or are we about to guess one?
    //
    // Login needs to tell these apart. A storefront login happens in the
    // context of one store and should only ever match accounts there. A login
    // from the global /login page has no store context at all — guessing one
    // and scoping to it looks up the wrong account entirely for anyone whose
    // store is not the guess.
    req.tenantExplicit = Boolean(slug);

    let query = supabase
      .from('tenants')
      .select('id, name, slug, logo_url, settings, active');

    if (slug) {
      query = query.eq('slug', slug);
    } else {
      // v1: fall back to the first active tenant (default)
      query = query.eq('active', true).limit(1);
    }

    const { data: tenant, error } = await query.single();

    // A timeout is not "no such store". supabase-js returns it as an ordinary
    // error, so without this check an outage reads as a 404 and sends people
    // hunting for a store that exists perfectly well.
    if (isUpstreamTimeout(error)) {
      console.error('Tenant resolution timed out — Supabase API unreachable');
      res.set('Retry-After', '30');
      return res.status(503).json({
        error: 'The store is temporarily unavailable. Please try again in a moment.',
        code: 'UPSTREAM_UNAVAILABLE',
      });
    }

    if (error || !tenant) {
      return res.status(404).json({ error: 'Store not found' });
    }

    if (!tenant.active) {
      return res.status(403).json({ error: 'This store is currently inactive' });
    }

    req.tenant = tenant;
    next();
  } catch (err) {
    // A timeout here means the Supabase API is not answering (it can be down
    // while Postgres itself is healthy). Say so with a 503 and a Retry-After
    // rather than a 500: it is upstream, it is transient, and the caller should
    // try again rather than treat the store as broken.
    if (err?.code === 'SUPABASE_TIMEOUT') {
      console.error('Tenant resolution timed out — Supabase API unreachable');
      res.set('Retry-After', '30');
      return res.status(503).json({
        error: 'The store is temporarily unavailable. Please try again in a moment.',
        code: 'UPSTREAM_UNAVAILABLE',
      });
    }
    console.error('Tenant resolution error:', err.message);
    return res.status(500).json({ error: 'Failed to resolve store' });
  }
}

module.exports = { resolveTenant };
