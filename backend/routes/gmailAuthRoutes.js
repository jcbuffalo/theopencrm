// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Gmail integration — OAuth + connection management routes.
// Mount path: /api/gmail (set by index.js).
//
// Endpoints
//   GET    /connection             — current connection summary (any auth user)
//   GET    /auth/start             — returns { authUrl } (org admin/owner only)
//   GET    /auth/callback?code&state — Google's redirect target; UPSERTs the row
//                                    and 302s to FRONTEND_URL/settings#gmail=connected
//   DELETE /connection             — revoke + delete row (org admin/owner only)
//
// MIRRORS routes/driveAuthRoutes.js exactly. Same per-org scoping, same
// state-token verification model, same graceful-degradation 503 shape.
// The integrator (index.js) is expected to wrap this mount with
// requireFeature('gmail_intel_enabled'); the routes here do not
// re-check the flag.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const gmailOAuth = require('../services/gmailOAuth');
const gmailTokens = require('../services/gmailTokens');
const gmailSync = require('../services/gmailSync');
const audit = require('../services/audit');

const router = express.Router();

// Rate limiter for the org-wide inbound sync — keyed on (org, ip). Org-wide
// discovery is heavier than a single-thread sync (it fans out over recent
// threads), so we allow fewer: 6 / 15min. A background worker does the routine
// pulls; this manual trigger is for "sync now" impatience.
const orgSyncLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const ip = ipKeyGenerator(req, res);
    const scope = req.orgId ? `org:${req.orgId}` : `user:${req.userId || 'anon'}`;
    return `gmail-org-sync:${scope}:${ip}`;
  },
  message: { error: 'Too many Gmail sync requests. Try again in 15 minutes.', code: 'GMAIL_SYNC_RATE_LIMIT' },
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
    error: 'Gmail integration not configured',
    detail: detail || 'Set GOOGLE_GMAIL_CLIENT_ID, GOOGLE_GMAIL_CLIENT_SECRET, GOOGLE_GMAIL_REDIRECT_URI, and DRIVE_TOKEN_ENCRYPTION_KEY to enable.',
  });
}

// Quick check across BOTH services. We require token encryption to be
// configured before allowing the OAuth dance — otherwise we'd succeed in
// the redirect and then explode trying to persist the refresh token.
//
// gmailOAuth.isConfigured() is async; gmailTokens (re-export of
// driveTokens) is sync.
async function gmailStackConfigured() {
  return (await gmailOAuth.isConfigured()) && gmailTokens.isConfigured();
}

async function gmailStackConfigError() {
  if (!(await gmailOAuth.isConfigured())) return gmailOAuth.configError();
  if (!gmailTokens.isConfigured()) return gmailTokens.configError();
  return null;
}

function frontendRedirect(suffix) {
  const raw = process.env.FRONTEND_URL || 'https://app.theopencrm.com';
  const first = raw.split(',')[0].trim();
  return `${first}${suffix}`;
}

// ---------------------------------------------------------------------------
// GET /connection — connection summary (any authenticated user)
// ---------------------------------------------------------------------------
router.get('/connection', authMiddleware, async (req, res) => {
  if (!(await gmailStackConfigured())) {
    return send503NotConfigured(res, await gmailStackConfigError());
  }
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `SELECT google_user_email, access_token_expires_at, status, last_error
         FROM org_gmail_connections
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
      last_error: row.last_error,
    });
  } catch (err) {
    if (req.log) req.log.error('gmail_connection_get_failed', { error: err });
    return res.status(500).json({ success: false, error: 'Failed to fetch Gmail connection', requestId: req.requestId });
  }
});

// ---------------------------------------------------------------------------
// GET /auth/start — admin-only. Returns { authUrl } to redirect to Google.
// ---------------------------------------------------------------------------
router.get('/auth/start', authMiddleware, async (req, res) => {
  if (!(await gmailStackConfigured())) {
    return send503NotConfigured(res, await gmailStackConfigError());
  }
  if (!req.orgId) {
    return res.status(400).json({ success: false, error: 'Org context required' });
  }
  if (!isOrgAdmin(req)) {
    return res.status(403).json({ success: false, error: 'Only org owners/admins can connect Gmail' });
  }
  try {
    const authUrl = await gmailOAuth.buildAuthUrl({ orgId: req.orgId, userId: req.userId });
    return res.json({ success: true, authUrl });
  } catch (err) {
    if (req.log) req.log.error('gmail_auth_start_failed', { error: err });
    return res.status(500).json({ success: false, error: err.message, requestId: req.requestId });
  }
});

// ---------------------------------------------------------------------------
// GET /auth/callback — Google redirects here with ?code&state. NO authMiddleware
// (Google's redirect doesn't carry our auth cookie reliably; we trust the
// signed state JWT instead).
// ---------------------------------------------------------------------------
router.get('/auth/callback', async (req, res) => {
  if (!(await gmailStackConfigured())) {
    return res.redirect(frontendRedirect(`/settings#gmail=error&reason=${encodeURIComponent('not_configured')}`));
  }

  const { code, state, error: oauthError } = req.query;
  if (oauthError) {
    return res.redirect(frontendRedirect(`/settings#gmail=error&reason=${encodeURIComponent(String(oauthError))}`));
  }
  if (!code || !state) {
    return res.redirect(frontendRedirect('/settings#gmail=error&reason=missing_params'));
  }

  let stateCtx;
  try {
    stateCtx = gmailOAuth.verifyStateToken(String(state));
  } catch (err) {
    if (req.log) req.log.warn('gmail_callback_bad_state', { error: err.message });
    return res.redirect(frontendRedirect('/settings#gmail=error&reason=invalid_state'));
  }

  try {
    const tokens = await gmailOAuth.exchangeCodeForTokens(String(code));
    const userEmail = await gmailOAuth.fetchUserEmail(tokens.access_token);

    const enc = gmailTokens.encrypt(tokens.refresh_token);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // UPSERT — re-authorizing replaces the prior row in place.
    await pool.query(
      `INSERT INTO org_gmail_connections
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

    // Audit — actor is the user from the state token, not req.userId
    // (which is null on the unauthed callback).
    audit.record({
      event: audit.EVENTS.GMAIL_CONNECTED,
      actorUserId: stateCtx.user_id,
      orgId: stateCtx.org_id,
      targetType: 'org_gmail_connection',
      ip: req.ip,
      userAgent: req.headers?.['user-agent'] || null,
      requestId: req.requestId || null,
      meta: { google_user_email: userEmail, scopes: tokens.scopes },
    }).catch(() => { /* audit failures never break the user flow */ });

    return res.redirect(frontendRedirect('/settings#gmail=connected'));
  } catch (err) {
    if (req.log) req.log.error('gmail_callback_failed', { error: err });
    return res.redirect(frontendRedirect(`/settings#gmail=error&reason=${encodeURIComponent(err.message || 'token_exchange')}`));
  }
});

// ---------------------------------------------------------------------------
// DELETE /connection — admin-only. Revokes the token at Google + deletes row.
// ---------------------------------------------------------------------------
router.delete('/connection', authMiddleware, async (req, res) => {
  if (!(await gmailStackConfigured())) {
    return send503NotConfigured(res, await gmailStackConfigError());
  }
  if (!req.orgId) {
    return res.status(400).json({ success: false, error: 'Org context required' });
  }
  if (!isOrgAdmin(req)) {
    return res.status(403).json({ success: false, error: 'Only org owners/admins can disconnect Gmail' });
  }
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `SELECT id, access_token,
              refresh_token_ciphertext, refresh_token_iv, refresh_token_tag
         FROM org_gmail_connections
        WHERE ${sf} = $1
        LIMIT 1`,
      [sv]
    );
    if (r.rows.length === 0) {
      return res.json({ success: true, disconnected: false, message: 'No Gmail connection to disconnect.' });
    }
    const row = r.rows[0];

    // Best-effort revoke. Per the spec we hit Google's revoke endpoint
    // with the access token; if that's gone or expired we try the
    // refresh token. Revoke failures are tolerated — the row is being
    // deleted regardless.
    let revokeAttempted = null;
    if (row.access_token) {
      try {
        const result = await gmailOAuth.revokeToken(row.access_token);
        revokeAttempted = { token: 'access', ...result };
      } catch (err) {
        if (req.log) req.log.warn('gmail_revoke_access_failed', { error: err.message });
      }
    }
    if (!revokeAttempted) {
      try {
        const refreshToken = gmailTokens.decrypt({
          ciphertext: row.refresh_token_ciphertext,
          iv: row.refresh_token_iv,
          tag: row.refresh_token_tag,
        });
        const result = await gmailOAuth.revokeToken(refreshToken);
        revokeAttempted = { token: 'refresh', ...result };
      } catch (err) {
        if (req.log) req.log.warn('gmail_revoke_refresh_failed', { error: err.message });
      }
    }

    await pool.query(
      `DELETE FROM org_gmail_connections WHERE id = $1`,
      [row.id]
    );

    audit.fromReq(req, {
      event: audit.EVENTS.GMAIL_DISCONNECTED,
      targetType: 'org_gmail_connection',
      targetId: row.id,
      meta: { revoked: revokeAttempted },
    });

    return res.json({ success: true, disconnected: true });
  } catch (err) {
    if (req.log) req.log.error('gmail_disconnect_failed', { error: err });
    return res.status(500).json({ success: false, error: 'Failed to disconnect Gmail', requestId: req.requestId });
  }
});

// ---------------------------------------------------------------------------
// POST /sync — trigger an org-wide inbound sync for the caller's org.
//
// Discovers recent Gmail threads, matches each to a deal by a participant
// email, auto-links + syncs the matches. Any authenticated org member can
// trigger it (it only reads Gmail + writes the org's own deal timelines).
// Rate-limited per (org, ip). Graceful when Gmail isn't configured/connected.
// ---------------------------------------------------------------------------
router.post('/sync', authMiddleware, orgSyncLimiter, async (req, res) => {
  if (!req.orgId) {
    return res.status(400).json({ success: false, error: 'Org context required' });
  }
  try {
    const result = await gmailSync.syncOrg({ orgId: req.orgId });

    // Not configured / not connected → 200 with a clear flag so the UI can
    // render a "connect Gmail first" nudge rather than treating it as an error.
    if (result.configured === false) {
      return res.status(503).json({
        success: false,
        configured: false,
        error: 'Gmail integration is not configured on this backend.',
      });
    }
    if (result.connected === false) {
      return res.json({
        success: true,
        connected: false,
        message: 'No active Gmail connection for this org. Connect Gmail to sync inbound email.',
        reason: result.reason,
      });
    }

    audit.fromReq(req, {
      event: audit.EVENTS.GMAIL_ORG_SYNCED,
      targetType: 'org_gmail_connection',
      meta: {
        threads_scanned: result.threads_scanned,
        threads_matched: result.threads_matched,
        messages_synced: result.messages_synced,
      },
    });

    return res.json({
      success: true,
      connected: true,
      threads_scanned: result.threads_scanned,
      threads_matched: result.threads_matched,
      messages_synced: result.messages_synced,
    });
  } catch (err) {
    audit.fromReq(req, {
      event: audit.EVENTS.GMAIL_ORG_SYNC_FAILED,
      targetType: 'org_gmail_connection',
      meta: { error: err.message },
      success: false,
    });
    if (req.log) req.log.error('gmail_org_sync_failed', { error: err });
    const code = err.code || 'GMAIL_SYNC_FAILED';
    const status = code === 'GMAIL_TOKEN_REVOKED' ? 401 : 500;
    return res.status(status).json({ success: false, error: err.message, code, requestId: req.requestId });
  }
});

module.exports = router;
