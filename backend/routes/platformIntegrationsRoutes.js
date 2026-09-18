// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Platform Integrations admin REST surface.
//
// Mount path: /api/admin/platform-integrations (mounted by the integrator
// in backend/index.js — this file does not self-mount).
//
// AUTHORIZATION
//   Every route requires:
//     1. authMiddleware       — valid JWT cookie
//     2. adminMiddleware      — caller is in admin_users
//     3. roleMiddleware('super_admin') — caller's admin role is super_admin
//
//   The spec says "super-admin only" — that's stricter than `admin` and
//   stricter than the permission system. Holding platform OAuth client
//   secrets is operator-level work, not delegated admin work.
//
// SHAPES (NEVER returns the decrypted secret on GET)
//   { integration, configured, has_secret, config, updated_at, updated_by_user_id }
//
// VALIDATION
//   :integration must match /^[a-z][a-z0-9_]{1,30}$/ AND be a registered
//   integration in services/platformIntegrations.js. We reject unknown
//   slugs explicitly rather than silently 404 so the operator gets a clear
//   "Phase 1 only knows about drive" message.
//
// PUT BODY
//   { config: {...}, secret?: string | null }
//     secret omitted → leave the existing encrypted secret untouched
//     secret = null  → clear the encrypted secret
//     secret = "..." → encrypt + store
//
// AUDIT
//   Every successful PUT writes PLATFORM_INTEGRATION_UPDATED with
//     meta = { integration, has_secret: bool, config_keys: [...] }
//   Every successful DELETE writes PLATFORM_INTEGRATION_CLEARED with
//     meta = { integration }
//   The secret VALUE is never logged.
//
// 503 PATH
//   When DRIVE_TOKEN_ENCRYPTION_KEY is unset and the caller tries to PUT a
//   secret, we 503 with operator-facing copy. The integration row itself
//   could still be inspected without the master key (GET works), so reads
//   are not affected.

const express = require('express');
const { authMiddleware } = require('../auth');
const { adminMiddleware, roleMiddleware } = require('../middleware/adminAuth');
const platformIntegrations = require('../services/platformIntegrations');
const audit = require('../services/audit');

const router = express.Router();

// All routes super-admin only. Order matters: authMiddleware sets req.userId,
// adminMiddleware sets req.adminRole, roleMiddleware compares.
router.use(authMiddleware, adminMiddleware, roleMiddleware('super_admin'));

// --- Helpers ---------------------------------------------------------------

function publicShape(integration, view) {
  // `view` is what platformIntegrations.getConfig returns (or null).
  if (!view) {
    return {
      integration,
      configured: false,
      has_secret: false,
      config: {},
      updated_at: null,
      updated_by_user_id: null,
    };
  }
  return {
    integration:        view.integration,
    configured:         view.configured,
    has_secret:         view.hasSecret,
    config:             view.config || {},
    updated_at:         view.updatedAt,
    updated_by_user_id: view.updatedByUserId,
  };
}

function validateSlug(integration) {
  if (typeof integration !== 'string' || !platformIntegrations.INTEGRATION_SLUG_RE.test(integration)) {
    return 'integration slug must match ^[a-z][a-z0-9_]{1,30}$';
  }
  if (!platformIntegrations.isKnownIntegration(integration)) {
    // Explicit Phase-1 message: only `drive` is wired. Future integrations
    // add themselves to INTEGRATIONS in the service.
    return `integration "${integration}" is not recognized (known: ${Object.keys(platformIntegrations.INTEGRATIONS).join(', ')})`;
  }
  return null;
}

// --- Routes ----------------------------------------------------------------

// List every known integration with current state. Always returns one entry
// per registered integration, even when there's no DB row yet (so the UI
// can render an "empty" card without a separate "what are the supported
// integrations" endpoint).
router.get('/', async (req, res, next) => {
  try {
    const all = await platformIntegrations.listAll();
    // Email transport status (env-configured, not a platform_integrations
    // row) rides along so the admin UI can render operator guidance — most
    // importantly the Gmail-limits warning card: Gmail app-password SMTP is
    // fine for getting started but has a ~500 sends/day account cap, weaker
    // deliverability at customer-facing volume, and account-suspension risk;
    // SendGrid (SENDGRID_API_KEY) with a domain sender is the production path.
    const emailSvc = require('../services/email');
    const transport = emailSvc.transportKind();
    res.json({
      success: true,
      data: all.map(({ integration, value }) => publicShape(integration, value)),
      email_transport: {
        transport, // 'sendgrid' | 'gmail' | 'console'
        configured: transport !== 'console',
      },
    });
  } catch (err) {
    next(err);
  }
});

// Single integration.
router.get('/:integration', async (req, res, next) => {
  try {
    const slug = req.params.integration;
    const err = validateSlug(slug);
    if (err) return res.status(400).json({ success: false, error: err });
    const view = await platformIntegrations.getConfig(slug);
    if (!view) return res.status(404).json({ success: false, error: `no integration row for "${slug}"` });
    res.json({ success: true, data: publicShape(slug, view) });
  } catch (err) {
    next(err);
  }
});

// Upsert.
router.put('/:integration', async (req, res, next) => {
  const slug = req.params.integration;
  const slugErr = validateSlug(slug);
  if (slugErr) return res.status(400).json({ success: false, error: slugErr });

  const body = req.body || {};
  if (!body.config || typeof body.config !== 'object') {
    return res.status(400).json({ success: false, error: 'body.config must be an object' });
  }
  // body.secret may be: missing (preserve), null (clear), or a non-empty
  // string (replace). Anything else is a 400.
  if (Object.prototype.hasOwnProperty.call(body, 'secret')
      && body.secret !== null
      && !(typeof body.secret === 'string' && body.secret.length > 0)) {
    return res.status(400).json({ success: false, error: 'body.secret must be a non-empty string, null (to clear), or omitted' });
  }

  try {
    const value = await platformIntegrations.set(slug, {
      config: body.config,
      // Preserve the distinction between "omitted" and "explicit null". `set`
      // treats them differently (preserve vs. clear).
      secret: Object.prototype.hasOwnProperty.call(body, 'secret') ? body.secret : undefined,
      userId: req.userId,
    });

    audit.fromReq(req, {
      event: audit.EVENTS.PLATFORM_INTEGRATION_UPDATED,
      targetType: 'platform_integration',
      targetId: null,
      meta: {
        integration: slug,
        has_secret: value.hasSecret,
        config_keys: Object.keys(value.config || {}),
      },
    });

    res.json({ success: true, data: publicShape(slug, value) });
  } catch (err) {
    // Master-key missing → 503 with operator-facing copy. Validation errors
    // → 400. Everything else → 500 via next(err).
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes('Master encryption key not configured')) {
      return res.status(503).json({
        success: false,
        error: 'Master encryption key not configured — set DRIVE_TOKEN_ENCRYPTION_KEY before storing platform credentials in-app.',
      });
    }
    // service-level validation messages all start with "platformIntegrations.set:"
    if (msg.startsWith('platformIntegrations.set:')) {
      return res.status(400).json({ success: false, error: msg.replace(/^platformIntegrations\.set:\s*/, '') });
    }
    next(err);
  }
});

// Clear the entire row.
router.delete('/:integration', async (req, res, next) => {
  const slug = req.params.integration;
  const slugErr = validateSlug(slug);
  if (slugErr) return res.status(400).json({ success: false, error: slugErr });

  try {
    const deleted = await platformIntegrations.clear(slug, { userId: req.userId });
    if (!deleted) {
      return res.status(404).json({ success: false, error: `no integration row for "${slug}"` });
    }

    audit.fromReq(req, {
      event: audit.EVENTS.PLATFORM_INTEGRATION_CLEARED,
      targetType: 'platform_integration',
      targetId: null,
      meta: { integration: slug },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
