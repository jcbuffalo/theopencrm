// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Outlook / Microsoft 365 per-deal intel — the read surface over the rows
// msgraphSyncWorker already lands in outlook_messages / outlook_calendar_events
// (migration 140, matched to deals by participant email).
//
// Mount path (set by index.js): /api/deals/:id/outlook-intel — behind
// requireAnyFeature('outlook_mail_enabled', 'outlook_calendar_enabled'), the
// same gate as /api/msgraph. Inside the handler each surface is additionally
// gated by ITS OWN flag: an org with only calendar enabled gets events but an
// empty mail lane, and vice versa — mirroring msgraphSyncWorker's per-surface
// checks.
//
// The Outlook tables are org-only (org_id NOT NULL — the M365 connection is
// an org concept), so org-less personal workspaces simply get empty lanes.
//
// Response: { connected, messages: [...], events: [...] } — `connected` lets
// the panel show a "connect Microsoft 365 in Settings" hint instead of a
// permanently-empty card.

const express = require('express');
const { authMiddleware } = require('../auth');
const { requireAnyFeature } = require('../middleware/featureGate');
const featureFlags = require('../services/featureFlags');
const pool = require('../db');

const router = express.Router({ mergeParams: true });
router.use(authMiddleware);
router.use(requireAnyFeature('outlook_mail_enabled', 'outlook_calendar_enabled'));

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const dealId = Number(req.params.id);
    if (!Number.isInteger(dealId) || dealId <= 0) {
      return res.status(400).json({ error: 'Invalid deal id' });
    }

    // The deal must be visible to the caller's tenancy.
    const dealRes = await pool.query(
      `SELECT id FROM deals WHERE id = $1 AND ${sf} = $2`,
      [dealId, sv]
    );
    if (dealRes.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    // Org-only feature — personal workspaces have no M365 connection.
    if (!req.orgId) return res.json({ connected: false, messages: [], events: [] });

    const connRes = await pool.query(
      `SELECT 1 FROM org_msgraph_connections WHERE org_id = $1 AND status = 'active' LIMIT 1`,
      [req.orgId]
    ).catch(() => ({ rows: [] }));
    const connected = connRes.rows.length > 0;

    const [mailOn, calOn] = await Promise.all([
      featureFlags.hasFeature(req.orgId, 'outlook_mail_enabled'),
      featureFlags.hasFeature(req.orgId, 'outlook_calendar_enabled'),
    ]);

    let messages = [];
    if (mailOn) {
      const r = await pool.query(
        `SELECT id, subject, body_preview, from_addr, to_addrs, received_at, web_link
           FROM outlook_messages
          WHERE org_id = $1 AND deal_id = $2
          ORDER BY received_at DESC NULLS LAST
          LIMIT 50`,
        [req.orgId, dealId]
      );
      messages = r.rows;
    }

    let events = [];
    if (calOn) {
      const r = await pool.query(
        `SELECT id, title, start_at, end_at, attendees, meeting_link, web_link,
                organizer_email, status, source
           FROM outlook_calendar_events
          WHERE org_id = $1 AND deal_id = $2
          ORDER BY start_at DESC NULLS LAST
          LIMIT 50`,
        [req.orgId, dealId]
      );
      events = r.rows;
    }

    res.json({ connected, messages, events });
  } catch (error) {
    if (req.log) req.log.error('deal_outlook_intel_failed', { error });
    res.status(500).json({ error: 'Failed to fetch Outlook intel' });
  }
});

module.exports = router;
