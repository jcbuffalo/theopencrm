// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Express middleware that 403s if a named feature flag is not enabled for the
// caller's organization.
//
// Works in BOTH positions:
//   1. In-router, after authMiddleware (or scimAuth) has populated req.orgId:
//        router.use(authMiddleware);
//        router.use(requireFeature('phase2_entities'));
//   2. At the mount point in index.js, BEFORE the router's own authMiddleware
//      has run:
//        app.use('/api/quotes', requireFeature('quotes_enabled'), quoteRoutes);
//
// Position (2) used to be a silent no-op: req.orgId was never set that early,
// so the gate always fell through and /admin/feature-flags toggles didn't
// actually disable anything. The gate now resolves the session itself when it
// runs pre-auth, using the SAME authMiddleware the route files use.
// authMiddleware is idempotent (it early-returns when req.userId is already
// set), so the router's own call afterwards is a no-op — no doubled DB work.
//
// Fail-open cases (deliberate, matches the behavior of the gates that were
// already correctly positioned after auth):
//   - No session token at all → next(). The router's own authMiddleware 401s
//     authenticated surfaces; session-less-by-design surfaces (inbound
//     webhooks, OAuth redirect callbacks) are gated by signature/state
//     verification instead — the feature gate is not their auth layer.
//   - Authenticated but org-less (personal workspace, user_id-only scoping)
//     → next(). The feature-flag concept doesn't meaningfully apply; there is
//     no other tenant to gate against.
// Only an org whose effective flag value is OFF gets the 403.

const featureFlags = require('../services/featureFlags');
const { authMiddleware, extractToken } = require('../auth');

function requireFeature(name) {
  async function evaluate(req, res, next) {
    // No org context = personal workspace → fail-open (see header comment).
    if (!req.orgId) {
      return next();
    }
    try {
      // hasFeature is default-aware: explicit org setting wins; a missing key
      // means the flag's registered defaultValue (services/featureFlags.js).
      const enabled = await featureFlags.hasFeature(req.orgId, name);
      if (!enabled) {
        return res.status(403).json({
          success: false,
          error: `Feature "${name}" is not enabled for this organization. Contact your admin.`,
          code: 'FEATURE_DISABLED',
          feature: name,
        });
      }
      next();
    } catch (err) {
      if (req.log) req.log.error('feature_gate_check_failed', { error: err, feature: name });
      next(err);
    }
  }

  return function featureGateMiddleware(req, res, next) {
    // Org context already established — either by a session authMiddleware
    // earlier in the chain (e.g. the /api/ai mount) or by a token auth layer
    // that sets req.orgId without req.userId (scimAuth). Evaluate directly.
    if (req.orgId) {
      return evaluate(req, res, next);
    }

    // Authenticated but org-less (authMiddleware already ran and found no
    // org_id). Fail-open — don't re-derive anything.
    if (req.userId) {
      return next();
    }

    // Auth hasn't run yet (mount-point position). If a session token is
    // present, resolve it with the same authMiddleware the router uses so the
    // gate sees the real orgId (and the same 401/403 outcomes for invalid
    // tokens / suspended accounts the router would produce anyway). If there
    // is no token, fall through: downstream auth owns the 401, and
    // session-less-by-design endpoints keep working.
    const { token } = extractToken(req);
    if (!token) {
      return next();
    }
    return authMiddleware(req, res, (err) => {
      if (err) return next(err);
      evaluate(req, res, next);
    });
  };
}

// ANY-of variant: passes when AT LEAST ONE of the named flags is enabled for
// the caller's org. Same fail-open semantics as requireFeature (no session /
// org-less callers fall through — downstream auth or signed-state
// verification owns those surfaces). First consumer: the /api/msgraph mount,
// where ONE Microsoft consent powers both outlook_mail_enabled and
// outlook_calendar_enabled and connection management must be reachable when
// either surface is on (the per-surface /sync routes re-check their own flag
// inside the router).
function requireAnyFeature(...names) {
  if (names.length === 0) {
    throw new Error('requireAnyFeature: at least one flag name is required');
  }

  async function evaluate(req, res, next) {
    if (!req.orgId) {
      return next();
    }
    try {
      for (const name of names) {
        // eslint-disable-next-line no-await-in-loop
        if (await featureFlags.hasFeature(req.orgId, name)) {
          return next();
        }
      }
      return res.status(403).json({
        success: false,
        error: `None of the features [${names.join(', ')}] are enabled for this organization. Contact your admin.`,
        code: 'FEATURE_DISABLED',
        feature: names[0],
        features: names,
      });
    } catch (err) {
      if (req.log) req.log.error('feature_gate_check_failed', { error: err, features: names });
      next(err);
    }
  }

  return function featureGateAnyMiddleware(req, res, next) {
    if (req.orgId) {
      return evaluate(req, res, next);
    }
    if (req.userId) {
      return next();
    }
    const { token } = extractToken(req);
    if (!token) {
      return next();
    }
    return authMiddleware(req, res, (err) => {
      if (err) return next(err);
      evaluate(req, res, next);
    });
  };
}

module.exports = { requireFeature, requireAnyFeature };
