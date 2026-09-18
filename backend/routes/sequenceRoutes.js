// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Email sequences (multi-step drip) — routes. Mounted at /api/sequences from
// index.js behind requireFeature('campaigns_enabled').
//
// Endpoints (all auth, all org-scoped via qs(req) semantics inside
// services/sequences.js):
//   GET    /                       — list sequences (+ step/enrollment counts)
//                                    + email_configured so the UI can show the
//                                    "email isn't activated" banner
//   POST   /                       — create { name, is_active?, steps? }
//   GET    /:id                    — sequence + ordered steps
//   PUT    /:id                    — update name / is_active; replace steps
//                                    when a `steps` array is provided
//   DELETE /:id                    — delete (steps + enrollments CASCADE)
//   POST   /:id/enroll             — { contact_ids: [] } → { enrolled, skipped }
//   GET    /:id/enrollments        — enrollment list w/ contact identity
//   GET    /:id/stats              — per-sequence + per-step analytics rollup
//                                    (enrolled/sent/opened/unsubscribed/completed
//                                    + open/unsub rates; zeros before first send)
//   POST   /enrollments/:id/stop   — stop one active enrollment
//
// The actual SENDING is worker-only (services/sequenceWorker.js) — there is
// deliberately no "send now" endpoint in v1: every dispatch flows through the
// suppression + atomic-claim path in services/sequences.js.

const express = require('express');
const { authMiddleware } = require('../auth');
const email = require('../services/email');
const sequences = require('../services/sequences');

const router = express.Router();

router.use(authMiddleware);

function scope(req) {
  return { orgId: req.orgId, userId: req.userId };
}

router.get('/', async (req, res) => {
  try {
    const rows = await sequences.listSequences(scope(req));
    res.json({ sequences: rows, email_configured: email.isConfigured() });
  } catch (err) {
    if (req.log) req.log.error('sequences_list_failed', { error: err });
    res.status(500).json({ error: 'Failed to list sequences' });
  }
});

router.post('/', async (req, res) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (name.length > 160) return res.status(400).json({ error: 'name must be 160 characters or fewer' });

    const norm = sequences.normalizeSteps(req.body.steps ?? []);
    if (norm.error) return res.status(400).json({ error: norm.error });

    const created = await sequences.createSequence(scope(req), {
      name,
      is_active: req.body.is_active !== false,
      steps: norm.steps,
    });
    res.status(201).json(created);
  } catch (err) {
    if (req.log) req.log.error('sequence_create_failed', { error: err });
    res.status(500).json({ error: 'Failed to create sequence' });
  }
});

router.get('/:id(\\d+)', async (req, res) => {
  try {
    const seq = await sequences.getSequence(scope(req), req.params.id);
    if (!seq) return res.status(404).json({ error: 'Sequence not found' });
    res.json(seq);
  } catch (err) {
    if (req.log) req.log.error('sequence_get_failed', { error: err });
    res.status(500).json({ error: 'Failed to load sequence' });
  }
});

router.put('/:id(\\d+)', async (req, res) => {
  try {
    const patch = {};
    if (req.body.name !== undefined) {
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
      if (!name) return res.status(400).json({ error: 'name cannot be empty' });
      if (name.length > 160) return res.status(400).json({ error: 'name must be 160 characters or fewer' });
      patch.name = name;
    }
    if (req.body.is_active !== undefined) patch.is_active = Boolean(req.body.is_active);
    if (req.body.steps !== undefined) {
      const norm = sequences.normalizeSteps(req.body.steps);
      if (norm.error) return res.status(400).json({ error: norm.error });
      patch.steps = norm.steps;
    }

    const updated = await sequences.updateSequence(scope(req), req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'Sequence not found' });
    res.json(updated);
  } catch (err) {
    if (req.log) req.log.error('sequence_update_failed', { error: err });
    res.status(500).json({ error: 'Failed to update sequence' });
  }
});

router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const ok = await sequences.deleteSequence(scope(req), req.params.id);
    if (!ok) return res.status(404).json({ error: 'Sequence not found' });
    res.json({ ok: true });
  } catch (err) {
    if (req.log) req.log.error('sequence_delete_failed', { error: err });
    res.status(500).json({ error: 'Failed to delete sequence' });
  }
});

router.post('/:id(\\d+)/enroll', async (req, res) => {
  try {
    const result = await sequences.enroll(scope(req), req.params.id, req.body.contact_ids);
    if (result === null) return res.status(404).json({ error: 'Sequence not found' });
    if (result.error) return res.status(400).json({ error: result.error });
    res.status(201).json(result);
  } catch (err) {
    if (req.log) req.log.error('sequence_enroll_failed', { error: err });
    res.status(500).json({ error: 'Failed to enroll contacts' });
  }
});

router.get('/:id(\\d+)/enrollments', async (req, res) => {
  try {
    // 404 for a sequence outside the caller's tenancy (don't leak existence).
    const seq = await sequences.getSequence(scope(req), req.params.id);
    if (!seq) return res.status(404).json({ error: 'Sequence not found' });
    const rows = await sequences.listEnrollments(scope(req), req.params.id);
    res.json(rows);
  } catch (err) {
    if (req.log) req.log.error('sequence_enrollments_list_failed', { error: err });
    res.status(500).json({ error: 'Failed to list enrollments' });
  }
});

router.get('/:id(\\d+)/stats', async (req, res) => {
  try {
    // sequenceStats itself scopes the sequence lookup — a sequence outside the
    // caller's tenancy returns null → 404 (existence never leaks).
    const stats = await sequences.sequenceStats(scope(req), req.params.id);
    if (!stats) return res.status(404).json({ error: 'Sequence not found' });
    res.json(stats);
  } catch (err) {
    if (req.log) req.log.error('sequence_stats_failed', { error: err });
    res.status(500).json({ error: 'Failed to load sequence stats' });
  }
});

router.post('/enrollments/:id(\\d+)/stop', async (req, res) => {
  try {
    const row = await sequences.stop(scope(req), req.params.id);
    if (!row) return res.status(404).json({ error: 'Active enrollment not found' });
    res.json(row);
  } catch (err) {
    if (req.log) req.log.error('sequence_enrollment_stop_failed', { error: err });
    res.status(500).json({ error: 'Failed to stop enrollment' });
  }
});

module.exports = router;
