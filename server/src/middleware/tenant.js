const supabase = require('../config/supabase');

/**
 * Resolve tenant from request.
 * Checks (in order): X-Tenant-Slug header, :tenantSlug URL param, or falls back to default tenant.
 */
async function resolveTenant(req, res, next) {
  try {
    const slug = req.headers['x-tenant-slug'] || req.params.tenantSlug;

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

    if (error || !tenant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    if (!tenant.active) {
      return res.status(403).json({ error: 'This restaurant is currently inactive' });
    }

    req.tenant = tenant;
    next();
  } catch (err) {
    console.error('Tenant resolution error:', err.message);
    return res.status(500).json({ error: 'Failed to resolve restaurant' });
  }
}

module.exports = { resolveTenant };
