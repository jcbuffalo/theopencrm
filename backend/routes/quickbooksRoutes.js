// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// QuickBooks Online connect/callback/status routes.
//
// Most endpoints require admin (or org owner) auth. The /callback receives
// Intuit's redirect — we look up state, exchange the code, store tokens.

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../auth');
const pool = require('../db');
const qb = require('../services/quickbooks');
const audit = require('../services/audit');

// Only org owners/admins may connect/disconnect the integration or push real
// invoices. Ordinary members must not be able to sever billing sync or create
// financial documents. Mirrors requireOrgAdmin in customFieldsRoutes.js.
function requireOrgAdmin(req, res, next) {
  if (!req.orgId) return res.status(400).json({ success: false, error: 'No organization context' });
  if (req.orgRole !== 'owner' && req.orgRole !== 'admin') {
    return res.status(403).json({ success: false, error: 'Only org owners/admins can manage the QuickBooks integration' });
  }
  next();
}

router.get('/status', authMiddleware, async (req, res) => {
  if (!qb.isConfigured()) {
    return res.json({
      success: true,
      configured: false,
      connected: false,
      message: qb.configError(),
      environment: qb.ENVIRONMENT,
    });
  }
  if (!req.orgId) return res.json({ success: true, configured: true, connected: false });
  const conn = await qb.getConnection(req.orgId);
  res.json({
    success: true,
    configured: true,
    connected: !!conn,
    environment: conn?.environment || qb.ENVIRONMENT,
    realmId: conn?.realm_id || null,
    connectedAt: conn?.connected_at || null,
    lastSyncAt: conn?.last_sync_at || null,
    lastSyncStatus: conn?.last_sync_status || null,
    lastSyncError: conn?.last_sync_error || null,
  });
});

router.post('/connect', authMiddleware, requireOrgAdmin, async (req, res) => {
  if (!qb.isConfigured()) return res.status(503).json({ success: false, error: qb.configError() });
  if (!req.orgId) return res.status(400).json({ success: false, error: 'No organization context' });
  try {
    const url = await qb.buildAuthUrl({ userId: req.userId, orgId: req.orgId });
    res.json({ success: true, authUrl: url });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Intuit redirects here with ?code=...&state=...&realmId=...
router.get('/callback', async (req, res) => {
  const { code, state, realmId, error: oauthError } = req.query;
  if (oauthError) {
    return res.redirect(`/admin/integrations?qb=error&reason=${encodeURIComponent(oauthError)}`);
  }
  if (!code || !state || !realmId) {
    return res.redirect('/admin/integrations?qb=error&reason=missing_params');
  }
  try {
    const ctx = await qb.consumeOAuthState(state);
    if (!ctx) return res.redirect('/admin/integrations?qb=error&reason=invalid_state');

    const tokens = await qb.exchangeCodeForTokens(code);
    await qb.saveConnection({
      orgId: ctx.org_id, userId: ctx.user_id, realmId, tokens,
    });
    res.redirect('/admin/integrations?qb=connected');
  } catch (err) {
    console.error('QB callback failed', err);
    res.redirect(`/admin/integrations?qb=error&reason=${encodeURIComponent(err.message || 'token_exchange')}`);
  }
});

router.post('/disconnect', authMiddleware, requireOrgAdmin, async (req, res) => {
  if (!req.orgId) return res.status(400).json({ success: false, error: 'No organization context' });
  await qb.disconnect(req.orgId);
  audit.fromReq(req, { event: 'qb.disconnected', meta: { orgId: req.orgId } });
  res.json({ success: true });
});

// Manually trigger invoice creation for a specific deal (admin / power-user use).
router.post('/invoice/:dealId', authMiddleware, requireOrgAdmin, async (req, res) => {
  try {
    if (!qb.isConfigured()) return res.status(503).json({ success: false, error: qb.configError() });
    const sf = req.orgId ? 'org_id' : 'user_id';
    const sv = req.orgId || req.userId;
    const r = await pool.query(
      `SELECT d.*, c.name AS customer_name FROM deals d
       LEFT JOIN companies c ON d.customer_id = c.id
       WHERE d.id = $1 AND d.${sf} = $2`,
      [req.params.dealId, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Deal not found' });
    const result = await qb.createInvoiceForDeal(r.rows[0]);
    audit.fromReq(req, { event: 'qb.invoice_created', targetType: 'deal', targetId: r.rows[0].id, meta: result });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('QB manual invoice failed', err);
    res.status(500).json({ success: false, error: err.message, details: err.payload || null });
  }
});

module.exports = router;
