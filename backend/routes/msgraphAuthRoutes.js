// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Microsoft (Outlook / Microsoft 365) integration — OAuth + connection
// management routes. Mount path: /api/msgraph (set by index.js).
//
// Endpoints
//   GET    /connection             — current connection summary (any auth user)
//   GET    /auth/start             — returns { authUrl } (org admin/owner only)
//   GET    /auth/callback?code&state — Microsoft's redirect target; UPSERTs the
//                                    row and 302s to FRONTEND_URL/settings#outlook=connected
//   DELETE /connection             — delete row (org admin/owner only; Microsoft
//                                    has no public revoke endpoint — see msgraphOAuth REVOCATION)
//   POST   /mail/sync              — org-wide inbound-mail sync (outlook_mail_enabled)
//   POST   /calendar/sync          — org-wide calendar sync (outlook_calendar_enabled)
//
// MIRRORS routes/calendarAuthRoutes.js / gmailAuthRoutes.js. Same per-org
// scoping, same state-token verification model, same graceful-degradation
// 503 shape. The integrator (index.js) wraps this mount with an ANY-of gate
// over (outlook_mail_enabled, outlook_calendar_enabled) — ONE Microsoft
// consent powers both surfaces, so connection management is reachable when
// either flag is on. The two /sync routes then re-check their own specific
// flag (a mail-only org must not sync calendar and vice versa).

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const msgraphOAuth = require('../services/msgraphOAuth');
const msgraphTokens = require('../services/msgraphTokens');
const msgraphSync = require('../services/msgraphSync');
const featureFlags = require('../services/featureFlags');
const audit = require('../services/audit');

const router = express.Router();

// Rate limiter for the org-wide syncs — keyed on (org, ip). A background
// worker does the routine pulls; this manual trigger is for "sync now"
// impatience. Shared across mail + calendar sync (they hit the same Graph
// quota bucket).
const orgSyncLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const ip = ipKeyGenerator(req, res);
    const scope = req.orgId ? `org:${req.orgId}` : `user:${req.userId || 'anon'}`;
    return `msgraph-org-sync:${scope}:${ip}`;
  },
  message: { error: 'Too many Outlook sync requests. Try again in 15 minutes.', code: 'MSGRAPH_SYNC_RATE_LIMIT' },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

function isOrgAdmin(req) {
  return req.orgRole === 'owner' || req.orgRole === 'admin';
}

function send503NotConfigured(res, detail) {
  return res.status(503).json({
    success: false,
    error: 'Microsoft 365 integration not configured',
    detail: detail || 'Save the Microsoft app registration at /admin/platform-integrations (and set DRIVE_TOKEN_ENCRYPTION_KEY) to enable.',
  });
}

// Quick check across BOTH services. We require token encryption to be
// configured before allowing the OAuth dance — otherwise we'd succeed in the
// redirect and then explode trying to persist the refresh token.
async function msgraphStackConfigured() {
  return (await msgraphOAuth.isConfigured()) && msgraphTokens.isConfigured();
}

async function msgraphStackConfigError() {
  if (!(await msgraphOAuth.isConfigured())) return msgraphOAuth.configError();
  if (!msgraphTokens.isConfigured()) return msgraphTokens.configError();
  return null;
}

function frontendRedirect(suffix) {
  const raw = process.env.FRONTEND_URL || 'https://app.theopencrm.com';
  const first = raw.split(',')[0].trim();
  return `${first}${suffix}`;
}

// Per-surface flag re-check for the /sync routes (the mount-level gate only
// guarantees "at least one Outlook flag is on"). Fail-open for org-less
// users, matching middleware/featureGate.js semantics.
function requireOrgFlag(flag) {
  return async (req, res, next) => {
    if (!req.orgId) return next();
    try {
      const on = await featureFlags.hasFeature(req.orgId, flag);
      if (!on) {
        return res.status(403).json({
          success: false,
          error: `Feature "${flag}" is not enabled for this organization. Contact your admin.`,
          code: 'FEATURE_DISABLED',
          feature: flag,
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// GET /connection — connection summary (any authenticated user)
// ---------------------------------------------------------------------------
router.get('/connection', authMiddleware, async (req, res) => {
  if (!(await msgraphStackConfigured())) {
    return send503NotConfigured(res, await msgraphStackConfigError());
  }
  // M365 connections are org-level (org_msgraph_connections has no user_id
  // column), so the qs(req) user_id fallback would be invalid SQL here.
  if (!req.orgId) {
    return res.json({ connected: false });
  }
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `SELECT ms_user_email, access_token_expires_at, status, last_error,
              last_mail_sync_at, mail_sync_status,
              last_calendar_sync_at, calendar_sync_status
         FROM org_msgraph_connections
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
      email: row.ms_user_email,
      expires_at: row.access_token_expires_at,
      status: row.status,
      last_error: row.last_error,
      last_mail_sync_at: row.last_mail_sync_at,
      mail_sync_status: row.mail_sync_status,
      last_calendar_sync_at: row.last_calendar_sync_at,
      calendar_sync_status: row.calendar_sync_status,
    });
  } catch (err) {
    if (req.log) req.log.error('msgraph_connection_get_failed', { error: err });
    return res.status(500).json({ success: false, error: 'Failed to fetch Microsoft 365 connection', requestId: req.requestId });
  }
});

// ---------------------------------------------------------------------------
// GET /auth/start — admin-only. Returns { authUrl } to redirect to Microsoft.
// ---------------------------------------------------------------------------
router.get('/auth/start', authMiddleware, async (req, res) => {
  if (!(await msgraphStackConfigured())) {
    return send503NotConfigured(res, await msgraphStackConfigError());
  }
  if (!req.orgId) {
    return res.status(400).json({ success: false, error: 'Org context required' });
  }
  if (!isOrgAdmin(req)) {
    return res.status(403).json({ success: false, error: 'Only org owners/admins can connect Microsoft 365' });
  }
  try {
    const authUrl = await msgraphOAuth.buildAuthUrl({ orgId: req.orgId, userId: req.userId });
    return res.json({ success: true, authUrl });
  } catch (err) {
    if (req.log) req.log.error('msgraph_auth_start_failed', { error: err });
    return res.status(500).json({ success: false, error: err.message, requestId: req.requestId });
  }
});

// ---------------------------------------------------------------------------
// GET /auth/callback — Microsoft redirects here with ?code&state. NO
// authMiddleware (the redirect doesn't carry our auth cookie reliably; we
// trust the signed state JWT instead).
// ---------------------------------------------------------------------------
router.get('/auth/callback', async (req, res) => {
  if (!(await msgraphStackConfigured())) {
    return res.redirect(frontendRedirect(`/settings#outlook=error&reason=${encodeURIComponent('not_configured')}`));
  }

  const { code, state, error: oauthError } = req.query;
  if (oauthError) {
    return res.redirect(frontendRedirect(`/settings#outlook=error&reason=${encodeURIComponent(String(oauthError))}`));
  }
  if (!code || !state) {
    return res.redirect(frontendRedirect('/settings#outlook=error&reason=missing_params'));
  }

  let stateCtx;
  try {
    stateCtx = msgraphOAuth.verifyStateToken(String(state));
  } catch (err) {
    if (req.log) req.log.warn('msgraph_callback_bad_state', { error: err.message });
    return res.redirect(frontendRedirect('/settings#outlook=error&reason=invalid_state'));
  }

  try {
    const tokens = await msgraphOAuth.exchangeCodeForTokens(String(code));
    const userEmail = await msgraphOAuth.fetchUserEmail(tokens.access_token);

    const enc = msgraphTokens.encrypt(tokens.refresh_token);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // UPSERT — re-authorizing replaces the prior row in place.
    await pool.query(
      `INSERT INTO org_msgraph_connections
         (org_id, ms_user_email,
          refresh_token_ciphertext, refresh_token_iv, refresh_token_tag,
          access_token, access_token_expires_at,
          scopes, status, last_error, connected_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', NULL, $9, NOW(), NOW())
       ON CONFLICT (org_id) DO UPDATE
         SET ms_user_email            = EXCLUDED.ms_user_email,
             refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
             refresh_token_iv         = EXCLUDED.refresh_token_iv,
             refresh_token_tag        = EXCLUDED.refresh_token_tag,
             access_token             = EXCLUDED.access_token,
             access_token_expires_at  = EXCLUDED.access_token_expires_at,
             scopes                   = EXCLUDED.scopes,
             status                   = 'active',
             last_error               = NULL,
             connected_by             = EXCLUDED.connected_by,
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
        stateCtx.user_id,
      ]
    );

    // Audit — actor is the user from the state token, not req.userId (which
    // is null on the unauthed callback).
    audit.record({
      event: audit.EVENTS.MSGRAPH_CONNECTED,
      actorUserId: stateCtx.user_id,
      orgId: stateCtx.org_id,
      targetType: 'org_msgraph_connection',
      ip: req.ip,
      userAgent: req.headers?.['user-agent'] || null,
      requestId: req.requestId || null,
      meta: { ms_user_email: userEmail, scopes: tokens.scopes },
    }).catch(() => { /* audit failures never break the user flow */ });

    return res.redirect(frontendRedirect('/settings#outlook=connected'));
  } catch (err) {
    if (req.log) req.log.error('msgraph_callback_failed', { error: err });
    return res.redirect(frontendRedirect(`/settings#outlook=error&reason=${encodeURIComponent(err.message || 'token_exchange')}`));
  }
});

// ---------------------------------------------------------------------------
// DELETE /connection — admin-only. Deletes the row. Microsoft has no public
// token-revocation endpoint (see msgraphOAuth REVOCATION); deleting our
// stored tokens is the strongest action available, and the response points
// the operator at the Microsoft account portal for a true grant revoke.
// ---------------------------------------------------------------------------
router.delete('/connection', authMiddleware, async (req, res) => {
  if (!(await msgraphStackConfigured())) {
    return send503NotConfigured(res, await msgraphStackConfigError());
  }
  if (!req.orgId) {
    return res.status(400).json({ success: false, error: 'Org context required' });
  }
  if (!isOrgAdmin(req)) {
    return res.status(403).json({ success: false, error: 'Only org owners/admins can disconnect Microsoft 365' });
  }
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `SELECT id FROM org_msgraph_connections WHERE ${sf} = $1 LIMIT 1`,
      [sv]
    );
    if (r.rows.length === 0) {
      return res.json({ success: true, disconnected: false, message: 'No Microsoft 365 connection to disconnect.' });
    }
    const row = r.rows[0];

    // Symmetry call — documented no-op (Microsoft has no revoke endpoint).
    const revokeAttempted = await msgraphOAuth.revokeToken(null).catch(() => null);

    await pool.query(
      `DELETE FROM org_msgraph_connections WHERE id = $1`,
      [row.id]
    );

    audit.fromReq(req, {
      event: audit.EVENTS.MSGRAPH_DISCONNECTED,
      targetType: 'org_msgraph_connection',
      targetId: row.id,
      meta: { revoked: revokeAttempted },
    });

    return res.json({
      success: true,
      disconnected: true,
      note: 'Stored tokens deleted. To fully revoke the grant, remove this app at https://myaccount.microsoft.com/ (App permissions).',
    });
  } catch (err) {
    if (req.log) req.log.error('msgraph_disconnect_failed', { error: err });
    return res.status(500).json({ success: false, error: 'Failed to disconnect Microsoft 365', requestId: req.requestId });
  }
});

// ---------------------------------------------------------------------------
// POST /mail/sync — org-wide inbound-mail sync (outlook_mail_enabled).
// ---------------------------------------------------------------------------
router.post('/mail/sync', authMiddleware, requireOrgFlag('outlook_mail_enabled'), orgSyncLimiter, async (req, res) => {
  if (!req.orgId) {
    return res.status(400).json({ success: false, error: 'Org context required' });
  }
  try {
    const result = await msgraphSync.syncMailOrg({ orgId: req.orgId });

    if (result.configured === false) {
      return res.status(503).json({
        success: false,
        configured: false,
        error: 'Microsoft 365 integration is not configured on this backend.',
      });
    }
    if (result.connected === false) {
      return res.json({
        success: true,
        connected: false,
        message: 'No active Microsoft 365 connection for this org. Connect Outlook to sync inbound email.',
        reason: result.reason,
      });
    }

    audit.fromReq(req, {
      event: audit.EVENTS.MSGRAPH_MAIL_SYNCED,
      targetType: 'org_msgraph_connection',
      meta: {
        messages_scanned: result.messages_scanned,
        messages_matched: result.messages_matched,
      },
    });

    return res.json({
      success: true,
      connected: true,
      messages_scanned: result.messages_scanned,
      messages_matched: result.messages_matched,
    });
  } catch (err) {
    audit.fromReq(req, {
      event: audit.EVENTS.MSGRAPH_MAIL_SYNC_FAILED,
      targetType: 'org_msgraph_connection',
      meta: { error: err.message },
      success: false,
    });
    if (req.log) req.log.error('msgraph_mail_sync_failed', { error: err });
    const code = err.code || 'MSGRAPH_SYNC_FAILED';
    const status = code === 'MSGRAPH_TOKEN_REVOKED' ? 401 : 500;
    return res.status(status).json({ success: false, error: err.message, code, requestId: req.requestId });
  }
});

// ---------------------------------------------------------------------------
// POST /calendar/sync — org-wide calendar sync (outlook_calendar_enabled).
// ---------------------------------------------------------------------------
router.post('/calendar/sync', authMiddleware, requireOrgFlag('outlook_calendar_enabled'), orgSyncLimiter, async (req, res) => {
  if (!req.orgId) {
    return res.status(400).json({ success: false, error: 'Org context required' });
  }
  try {
    const result = await msgraphSync.syncCalendarOrg({ orgId: req.orgId });

    if (result.configured === false) {
      return res.status(503).json({
        success: false,
        configured: false,
        error: 'Microsoft 365 integration is not configured on this backend.',
      });
    }
    if (result.connected === false) {
      return res.json({
        success: true,
        connected: false,
        message: 'No active Microsoft 365 connection for this org. Connect Outlook to sync meetings.',
        reason: result.reason,
      });
    }

    audit.fromReq(req, {
      event: audit.EVENTS.MSGRAPH_CALENDAR_SYNCED,
      targetType: 'org_msgraph_connection',
      meta: {
        events_scanned: result.events_scanned,
        events_matched: result.events_matched,
      },
    });

    return res.json({
      success: true,
      connected: true,
      events_scanned: result.events_scanned,
      events_matched: result.events_matched,
    });
  } catch (err) {
    audit.fromReq(req, {
      event: audit.EVENTS.MSGRAPH_CALENDAR_SYNC_FAILED,
      targetType: 'org_msgraph_connection',
      meta: { error: err.message },
      success: false,
    });
    if (req.log) req.log.error('msgraph_calendar_sync_failed', { error: err });
    const code = err.code || 'MSGRAPH_SYNC_FAILED';
    const status = code === 'MSGRAPH_TOKEN_REVOKED' ? 401 : 500;
    return res.status(status).json({ success: false, error: err.message, code, requestId: req.requestId });
  }
});

module.exports = router;
