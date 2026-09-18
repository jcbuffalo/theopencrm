// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// In-app Notification Center — /api/notifications.
//
//   GET    /                — my notifications (?unread=1 to filter, ?limit=)
//                             + unread_count in the same payload so the bell
//                             needs exactly one request
//   PATCH  /:id/read        — mark one of MY notifications read (idempotent)
//   POST   /read-all        — mark all MY unread notifications read
//
// Scoping: org-scoped via qs(req) AND recipient-scoped via req.userId — a
// user can only ever see/touch their own rows, even inside their org.
// Notifications are a CORE surface (like /api/my-day): deliberately NOT
// feature-gated at the mount — plain auth only.

const express = require('express');
const { authMiddleware } = require('../auth');
const notifications = require('../services/notifications');

const router = express.Router();
router.use(authMiddleware);

// Returns [scopeField, scopeValue] for the current request's tenancy.
// Falls back to user_id when the user doesn't belong to an org.
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

router.get('/', async (req, res) => {
  try {
    const scope = qs(req);
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
    const [rows, unread] = await Promise.all([
      notifications.listForUser(scope, req.userId, { unreadOnly, limit: req.query.limit }),
      notifications.unreadCount(scope, req.userId),
    ]);
    res.json({ notifications: rows, unread_count: unread });
  } catch (error) {
    if (req.log) req.log.error('notifications_list_failed', { error });
    else console.error('Notifications list error:', error.message);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

router.patch('/:id/read', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid notification id' });
    const row = await notifications.markRead(qs(req), req.userId, id);
    if (!row) return res.status(404).json({ error: 'Notification not found' });
    res.json(row);
  } catch (error) {
    if (req.log) req.log.error('notification_mark_read_failed', { error });
    else console.error('Notification mark-read error:', error.message);
    res.status(500).json({ error: 'Failed to mark notification read' });
  }
});

router.post('/read-all', async (req, res) => {
  try {
    const updated = await notifications.markAllRead(qs(req), req.userId);
    res.json({ updated });
  } catch (error) {
    if (req.log) req.log.error('notifications_read_all_failed', { error });
    else console.error('Notifications read-all error:', error.message);
    res.status(500).json({ error: 'Failed to mark notifications read' });
  }
});

module.exports = router;
