// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Drive Intel — OAuth + connection management routes (Agent 1 of 3).
// Mount path: /api/drive
//
// MOUNT: app.use('/api/drive', driveAuthRoutes);
//
// Endpoints
//   GET    /connection             — current connection summary (any auth user)
//   GET    /auth/start             — returns { authUrl } (org admin/owner only)
//   GET    /auth/callback?code&state — Google's redirect target; UPSERTs the row
//                                    and 302s to FRONTEND_URL/settings#drive
//   DELETE /connection             — revoke + delete row (org admin/owner only)
//
// PER-ORG SCOPING
//   Every DB statement uses qs(req) so cross-org reads are structurally
//   impossible. The /auth/callback route is the one exception — it reads
//   org_id from the verified state token, not req.orgId, because at that
//   point Google has redirected the browser and we may or may not have a
//   session cookie attached (depends on SameSite + cross-domain config).
//   We still gate the write on the JWT signature being valid for our
//   JWT_SECRET, which means a forged callback can't target an arbitrary org.
//
// GRACEFUL DEGRADATION
//   When GOOGLE_DRIVE_CLIENT_ID is missing we return 503 with a clear
//   "Drive integration not configured" message. The frontend already knows
//   to render an "ask your admin to configure" empty state when this 503
//   comes back (mirror of services/email.js / services/quickbooks.js).
//
// FEATURE FLAG
//   The integrator (index.js) is expected to wrap the mount with
//   requireFeature('drive_intel_enabled') so disabling the flag on an org
//   404s the routes. Phase 1 leaves the requireFeature application to the
//   integrator step (see DRIVE_INTEL_SPEC.md § "Parallel agent split").

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const driveOAuth = require('../services/driveOAuth');
const driveTokens = require('../services/driveTokens');
const audit = require('../services/audit');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Returns [scopeField, scopeValue] for the current request's tenancy.
// Falls back to user_id when the user doesn't belong to an org. This is the
// canonical org-scoping helper documented in CLAUDE.md and API.md.
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Guard for the admin-only routes (start / disconnect). Mirrors
// customFieldsRoutes.requireOrgAdmin / aiRoutes apply-customization.
function isOrgAdmin(req) {
  return req.orgRole === 'owner' || req.orgRole === 'admin';
}

// Return a 503 response with the operator-facing detail. Centralised so the
// shape matches every caller without copy-paste drift.
function send503NotConfigured(res, detail) {
  return res.status(503).json({
    success: false,
    error: 'Drive integration not configured',
    detail: detail || 'Set GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DRIVE_REDIRECT_URI, and DRIVE_TOKEN_ENCRYPTION_KEY to enable.',
  });
}

// Quick check across BOTH services. We require token encryption to be
// configured before allowing the OAuth dance — otherwise we'd succeed in
// the redirect and then explode trying to persist the refresh token.
//
// driveOAuth.isConfigured() is async (PLATFORM_INTEGRATIONS_SPEC.md
// refactor — it now consults the platform_integrations DB row first,
// falling back to GOOGLE_DRIVE_* env vars). driveTokens.isConfigured() is
// still sync (the master key never moves out of env).
async function driveStackConfigured() {
  return (await driveOAuth.isConfigured()) && driveTokens.isConfigured();
}

async function driveStackConfigError() {
  if (!(await driveOAuth.isConfigured())) return driveOAuth.configError();
  if (!driveTokens.isConfigured()) return driveTokens.configError();
  return null;
}

// Build the post-callback redirect URL. FRONTEND_URL may be a comma-separated
// list (multi-origin CORS) — we always pick the first entry for the redirect
// target, matching what /auth/email-verify and friends do.
function frontendRedirect(suffix) {
  const raw = process.env.FRONTEND_URL || 'https://app.theopencrm.com';
  const first = raw.split(',')[0].trim();
  return `${first}${suffix}`;
}

// ---------------------------------------------------------------------------
// GET /connection — connection summary (any authenticated user)
// ---------------------------------------------------------------------------
router.get('/connection', authMiddleware, async (req, res) => {
  if (!(await driveStackConfigured())) {
    return send503NotConfigured(res, await driveStackConfigError());
  }
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `SELECT google_user_email, access_token_expires_at, status
         FROM org_drive_connections
        WHERE ${sf} = $1
        LIMIT 1`,
      [sv]
    );
    if (r.rows.length === 0) {
      return res.json({ connected: false });
    }
    const row = r.rows[0];
    return res.json({
      connected: true,
      email: row.google_user_email,
      expires_at: row.access_token_expires_at,
      status: row.status,
    });
  } catch (err) {
    if (req.log) req.log.error('drive_connection_get_failed', { error: err });
    return res.status(500).json({ success: false, error: 'Failed to fetch Drive connection', requestId: req.requestId });
  }
});

// ---------------------------------------------------------------------------
// GET /auth/start — admin-only. Returns { authUrl } to redirect to Google.
// ---------------------------------------------------------------------------
router.get('/auth/start', authMiddleware, async (req, res) => {
  if (!(await driveStackConfigured())) {
    return send503NotConfigured(res, await driveStackConfigError());
  }
  if (!req.orgId) {
    return res.status(400).json({ success: false, error: 'Org context required' });
  }
  if (!isOrgAdmin(req)) {
    return res.status(403).json({ success: false, error: 'Only org owners/admins can connect Google Drive' });
  }
  try {
    const authUrl = await driveOAuth.buildAuthUrl({ orgId: req.orgId, userId: req.userId });
    return res.json({ success: true, authUrl });
  } catch (err) {
    if (req.log) req.log.error('drive_auth_start_failed', { error: err });
    return res.status(500).json({ success: false, error: err.message, requestId: req.requestId });
  }
});

// ---------------------------------------------------------------------------
// GET /auth/callback — Google redirects here with ?code&state. NO authMiddleware
// (Google's redirect doesn't carry our auth cookie reliably; we trust the
// signed state JWT instead).
// ---------------------------------------------------------------------------
router.get('/auth/callback', async (req, res) => {
  if (!(await driveStackConfigured())) {
    // Operator-facing — surface as a clear page-level redirect rather than a
    // raw 503 since the browser has been bounced here from Google.
    return res.redirect(frontendRedirect(`/settings#drive=error&reason=${encodeURIComponent('not_configured')}`));
  }

  const { code, state, error: oauthError } = req.query;
  if (oauthError) {
    return res.redirect(frontendRedirect(`/settings#drive=error&reason=${encodeURIComponent(String(oauthError))}`));
  }
  if (!code || !state) {
    return res.redirect(frontendRedirect('/settings#drive=error&reason=missing_params'));
  }

  let stateCtx;
  try {
    stateCtx = driveOAuth.verifyStateToken(String(state));
  } catch (err) {
    if (req.log) req.log.warn('drive_callback_bad_state', { error: err.message });
    return res.redirect(frontendRedirect('/settings#drive=error&reason=invalid_state'));
  }

  try {
    const tokens = await driveOAuth.exchangeCodeForTokens(String(code));
    const userEmail = await driveOAuth.fetchUserEmail(tokens.access_token);

    const enc = driveTokens.encrypt(tokens.refresh_token);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // UPSERT — re-authorizing replaces the prior row in place. The UNIQUE
    // index on org_id makes ON CONFLICT (org_id) the correct conflict target.
    await pool.query(
      `INSERT INTO org_drive_connections
         (org_id, google_user_email,
          refresh_token_ciphertext, refresh_token_iv, refresh_token_tag,
          access_token, access_token_expires_at,
          scopes, status, last_error, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', NULL, NOW(), NOW())
       ON CONFLICT (org_id) DO UPDATE
         SET google_user_email        = EXCLUDED.google_user_email,
             refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
             refresh_token_iv         = EXCLUDED.refresh_token_iv,
             refresh_token_tag        = EXCLUDED.refresh_token_tag,
             access_token             = EXCLUDED.access_token,
             access_token_expires_at  = EXCLUDED.access_token_expires_at,
             scopes                   = EXCLUDED.scopes,
             status                   = 'active',
             last_error               = NULL,
             updated_at               = NOW()`,
      [
        stateCtx.org_id,
        userEmail || '',
        enc.ciphertext,
        enc.iv,
        enc.tag,
        tokens.access_token,
        expiresAt,
        tokens.scopes,
      ]
    );

    // Audit. We record on the connection event explicitly — the actor is the
    // user from the state token (not req.userId, which is null here because
    // there's no auth cookie on the callback).
    audit.record({
      event: audit.EVENTS.DRIVE_CONNECTED,
      actorUserId: stateCtx.user_id,
      orgId: stateCtx.org_id,
      targetType: 'org_drive_connection',
      ip: req.ip,
      userAgent: req.headers?.['user-agent'] || null,
      requestId: req.requestId || null,
      meta: { email: userEmail, scopes: tokens.scopes },
    }).catch(() => { /* audit failures never break the user flow */ });

    return res.redirect(frontendRedirect('/settings#drive=connected'));
  } catch (err) {
    if (req.log) req.log.error('drive_callback_failed', { error: err });
    return res.redirect(frontendRedirect(`/settings#drive=error&reason=${encodeURIComponent(err.message || 'token_exchange')}`));
  }
});

// ---------------------------------------------------------------------------
// DELETE /connection — admin-only. Revokes the token at Google + deletes row.
// ---------------------------------------------------------------------------
router.delete('/connection', authMiddleware, async (req, res) => {
  if (!(await driveStackConfigured())) {
    return send503NotConfigured(res, await driveStackConfigError());
  }
  if (!req.orgId) {
    return res.status(400).json({ success: false, error: 'Org context required' });
  }
  if (!isOrgAdmin(req)) {
    return res.status(403).json({ success: false, error: 'Only org owners/admins can disconnect Google Drive' });
  }
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `SELECT id, access_token,
              refresh_token_ciphertext, refresh_token_iv, refresh_token_tag
         FROM org_drive_connections
        WHERE ${sf} = $1
        LIMIT 1`,
      [sv]
    );
    if (r.rows.length === 0) {
      return res.json({ success: true, disconnected: false, message: 'No Drive connection to disconnect.' });
    }
    const row = r.rows[0];

    // Best-effort revoke. Per the spec we hit Google's revoke endpoint with
    // the access token; if it's already expired we fall through to the
    // refresh token. We tolerate revoke failure (already-revoked / network
    // hiccup) — the row is being deleted regardless, and surfacing a
    // revoke failure to the user would block disconnect on transient
    // upstream errors.
    let revokeAttempted = null;
    if (row.access_token) {
      try {
        const result = await driveOAuth.revokeToken(row.access_token);
        revokeAttempted = { token: 'access', ...result };
      } catch (err) {
        if (req.log) req.log.warn('drive_revoke_access_failed', { error: err.message });
      }
    }
    if (!revokeAttempted) {
      try {
        const refreshToken = driveTokens.decrypt({
          ciphertext: row.refresh_token_ciphertext,
          iv: row.refresh_token_iv,
          tag: row.refresh_token_tag,
        });
        const result = await driveOAuth.revokeToken(refreshToken);
        revokeAttempted = { token: 'refresh', ...result };
      } catch (err) {
        if (req.log) req.log.warn('drive_revoke_refresh_failed', { error: err.message });
      }
    }

    await pool.query(
      `DELETE FROM org_drive_connections WHERE id = $1`,
      [row.id]
    );

    audit.fromReq(req, {
      event: audit.EVENTS.DRIVE_DISCONNECTED,
      targetType: 'org_drive_connection',
      targetId: row.id,
      meta: { revoked: revokeAttempted },
    });

    return res.json({ success: true, disconnected: true });
  } catch (err) {
    if (req.log) req.log.error('drive_disconnect_failed', { error: err });
    return res.status(500).json({ success: false, error: 'Failed to disconnect Drive', requestId: req.requestId });
  }
});

module.exports = router;
