const rateLimit = require('express-rate-limit');

// Render terminates TLS upstream, so req.ip is the proxy's address unless
// `trust proxy` is set (see app.js). These limiters key on req.ip, so that
// setting is what makes them per-client rather than per-deployment.

const message = (retryAfterHint) => ({
  error: `Too many requests. Please wait ${retryAfterHint} and try again.`,
});

/** Credential endpoints: brute force and account-creation spam. */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: message('a few minutes'),
  // Only failed attempts count, so a legitimately busy shared IP (an office,
  // a mobile carrier NAT) isn't locked out by its own successful logins.
  skipSuccessfulRequests: true,
});

/** Tenant provisioning: one signup per IP per hour is generous for real use. */
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: message('an hour'),
});

/** Order placement — unauthenticated, and each order costs DB writes + a MoMo call. */
const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: message('a few minutes'),
});

/** Order tracking: the enumeration surface (see readOrderByTrackingCode). */
const trackingLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: message('a few minutes'),
});

/**
 * MoMo's callback. Unauthenticated by design (MTN calls it directly), and each
 * hit costs us an outbound authenticated status call to MoMo — so an unlimited
 * endpoint here burns our MoMo API quota, not just our CPU.
 */
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: message('a moment'),
});

/** Backstop for everything else. Loose enough that normal browsing never sees it. */
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: message('a moment'),
});

module.exports = {
  authLimiter,
  signupLimiter,
  orderLimiter,
  trackingLimiter,
  webhookLimiter,
  globalLimiter,
};
