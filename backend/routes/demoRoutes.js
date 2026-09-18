// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authMiddleware } = require('../auth');
const { seedForUser, wipeDemoForOrg, demoStatusForOrg } = require('../services/demoSeeder');
const audit = require('../services/audit');

// Demo seed/clear is an ORG-OWNER action (not a platform-admin one): a customer
// on a trial should be able to populate their OWN workspace with sample data,
// explore, then clear it and start fresh — all org-scoped by req.orgId, so it
// can never touch another tenant.
function requireOrgAdmin(req, res, next) {
  if (!req.orgId) return res.status(400).json({ error: 'No org context' });
  if (!['owner', 'admin'].includes(req.orgRole)) {
    return res.status(403).json({ error: 'Only an organization owner or admin can manage demo data' });
  }
  next();
}

// Seeding wipes-then-inserts a fixed, bounded demo set (no AI calls, no runaway
// rows). This limiter is belt-and-suspenders so the button can't be hammered.
const demoWriteLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many demo operations. Give it a minute.' },
});

// Is this org currently showing demo data? Drives the app-wide demo banner.
router.get('/status', authMiddleware, requireOrgAdmin, async (req, res) => {
  try {
    if (!req.orgId) return res.json({ hasDemo: false, counts: {} });
    res.json(await demoStatusForOrg(req.orgId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/seed', demoWriteLimiter, authMiddleware, requireOrgAdmin, async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ error: 'No org context' });
    const profile = req.body?.profile || 'generic';
    if (!['generic', 'zang'].includes(profile)) {
      return res.status(400).json({ error: 'profile must be generic or zang' });
    }
    const summary = await seedForUser({ userId: req.userId, orgId: req.orgId, profile });
    audit.fromReq(req, { event: 'demo.seeded', meta: summary });
    res.json({ success: true, summary });
  } catch (err) {
    console.error('demo seed failed', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/wipe', demoWriteLimiter, authMiddleware, requireOrgAdmin, async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ error: 'No org context' });
    await wipeDemoForOrg(req.orgId);
    audit.fromReq(req, { event: 'demo.wiped' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
