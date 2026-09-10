const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');

/**
 * Verify JWT and attach user to request.
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Fetch user from DB to ensure they still exist and role hasn't changed
    const { data: user, error } = await supabase
      .from('users')
      .select('id, tenant_id, name, email, role, phone, plate_number')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // The tenant comes from a client-controlled header (X-Tenant-Slug), so a
    // valid token for store A must not be usable against store B. Without this,
    // any admin could read or write another store's data by changing one header
    // — routes scope on req.tenant.id, which the caller chooses.
    //
    // super_admin is exempt: it legitimately acts across tenants (e.g. escalated
    // complaints in routes/complaints.js).
    if (req.tenant && user.role !== 'super_admin' && user.tenant_id !== req.tenant.id) {
      return res.status(403).json({ error: 'Not authorized for this store' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Role-based authorization guard.
 * Usage: authorize('admin', 'manager')
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/**
 * Super admin only — bypasses tenant scoping.
 */
function superAdminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

/**
 * Optional authentication — attaches user if token is present, but doesn't fail.
 * Useful for routes that work for both guests and registered users.
 */
async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      return next();
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { data: user } = await supabase
      .from('users')
      .select('id, tenant_id, name, email, role, phone, plate_number')
      .eq('id', decoded.userId)
      .single();

    // Same cross-tenant rule as authenticate(), but these routes are open to
    // guests, so a token belonging to another store is downgraded to "guest"
    // rather than rejected. That keeps guest checkout working for someone who
    // has an account at a different store, without letting their identity —
    // and their customer_id — leak onto this store's orders.
    if (user && req.tenant && user.role !== 'super_admin' && user.tenant_id !== req.tenant.id) {
      req.user = null;
      return next();
    }

    req.user = user || null;
    next();
  } catch {
    req.user = null;
    next();
  }
}

module.exports = { authenticate, authorize, superAdminOnly, optionalAuth };
