// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Leads — pre-qualification pipeline (migration 130).
//
// Endpoints (all auth-required, all org-scoped, mounted behind
// requireFeature('leads_enabled') in index.js):
//   GET    /             — list (filters: status, search, limit)
//   GET    /:id          — fetch one
//   POST   /             — create (owner defaults to round-robin when omitted)
//   PUT    /:id          — update (COALESCE-style partial; cannot set 'converted')
//   DELETE /:id          — hard delete
//   POST   /:id/convert  — transactional convert → contacts row (+ optional
//                          deals row); stamps status='converted' +
//                          converted_contact_id/_deal_id. 409 if already
//                          converted, 404 cross-org.
//
// Tenancy: scoped via qs(req) — the service takes the tuple for every query.

const express = require('express');
const { authMiddleware } = require('../auth');
const leads = require('../services/leads');
const leadScoring = require('../services/leadScoring');
const audit = require('../services/audit');
const { ownerValidationError } = require('../services/recordOwnership');
const notificationDispatcher = require('../services/notificationDispatcher');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

router.get('/', async (req, res) => {
  try {
    const rows = await leads.listLeads(qs(req), {
      status: req.query.status,
      search: req.query.search,
      limit: req.query.limit,
      sort: req.query.sort, // 'score' → highest first; anything else = default
    });
    res.json(rows);
  } catch (error) {
    if (req.log) req.log.error('leads_list_failed', { error });
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// ---------------------------------------------------------------------------
// Scoring rules (migration 147) — registered BEFORE '/:id' so the literal
// path wins. Reads are open to any member (the board shows scores anyway);
// writes are org-admin-gated, same isOrgAdmin convention as segments and
// playbooks (org-less workspaces are their own admin).
// ---------------------------------------------------------------------------

function isOrgAdmin(req) {
  if (!req.orgId) return true;
  return req.orgRole === 'owner' || req.orgRole === 'admin';
}

function requireOrgAdmin(req, res, next) {
  if (!isOrgAdmin(req)) {
    return res.status(403).json({ error: 'Only org owners/admins can manage scoring rules' });
  }
  next();
}

router.get('/scoring-rules', async (req, res) => {
  try {
    res.json(await leadScoring.listRules(qs(req)));
  } catch (error) {
    if (req.log) req.log.error('scoring_rules_list_failed', { error });
    res.status(500).json({ error: 'Failed to fetch scoring rules' });
  }
});

router.post('/scoring-rules', requireOrgAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    // A routing target must live inside the caller's tenancy — same check as
    // an explicit lead owner. (Re-validated again at pick time.)
    if (body.route_to_user_id !== undefined && body.route_to_user_id !== null) {
      const ownerErr = await ownerValidationError(req, body.route_to_user_id);
      if (ownerErr) return res.status(400).json({ error: ownerErr });
    }
    const rule = await leadScoring.createRule(
      { userId: req.userId, orgId: req.orgId || null },
      body
    );
    res.status(201).json(rule);
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    if (req.log) req.log.error('scoring_rule_create_failed', { error });
    res.status(500).json({ error: 'Failed to create scoring rule' });
  }
});

router.put('/scoring-rules/:id', requireOrgAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    if (body.route_to_user_id !== undefined && body.route_to_user_id !== null) {
      const ownerErr = await ownerValidationError(req, body.route_to_user_id);
      if (ownerErr) return res.status(400).json({ error: ownerErr });
    }
    const rule = await leadScoring.updateRule(qs(req), req.params.id, body);
    if (!rule) return res.status(404).json({ error: 'Scoring rule not found' });
    res.json(rule);
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    if (req.log) req.log.error('scoring_rule_update_failed', { error });
    res.status(500).json({ error: 'Failed to update scoring rule' });
  }
});

router.delete('/scoring-rules/:id', requireOrgAdmin, async (req, res) => {
  try {
    const rule = await leadScoring.deleteRule(qs(req), req.params.id);
    if (!rule) return res.status(404).json({ error: 'Scoring rule not found' });
    res.json({ message: 'Scoring rule deleted', rule });
  } catch (error) {
    if (req.log) req.log.error('scoring_rule_delete_failed', { error });
    res.status(500).json({ error: 'Failed to delete scoring rule' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const lead = await leads.getLead(qs(req), req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (error) {
    if (req.log) req.log.error('lead_get_failed', { error });
    res.status(500).json({ error: 'Failed to fetch lead' });
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    // Owner: explicit id wins; otherwise round-robin across org members so
    // manually entered leads distribute the same way captured ones do. An
    // explicit owner must be a member of the caller's org (in-org check,
    // matching companies/deals/commission) — no dangling cross-org refs.
    const ownerErr = await ownerValidationError(req, body.owner_user_id);
    if (ownerErr) return res.status(400).json({ error: ownerErr });
    let owner = Number.isInteger(body.owner_user_id) ? body.owner_user_id : null;
    if (!owner) {
      // Score-aware routing: a matching routing rule (subject to its
      // min_score threshold) wins; otherwise pickOwner falls back to the
      // same round-robin as before. createLead recomputes the score itself.
      const score = await leadScoring.scoreLead(qs(req), body).catch(() => 0);
      owner = await leadScoring.pickOwner(qs(req), body, score).catch(() => null);
    }
    const lead = await leads.createLead(
      { userId: req.userId, orgId: req.orgId || null },
      { ...body, owner_user_id: owner, source: body.source || 'manual' }
    );

    // Fire-and-forget: tell the owner (round-robin or explicit) when it isn't
    // the creator. Never breaks the create.
    if (lead.owner_user_id && Number(lead.owner_user_id) !== Number(req.userId)) {
      notificationDispatcher.notifyLeadAssigned(lead.id, req.userId)
        .catch(err => console.warn('notify_lead_assigned_failed', err && err.message ? err.message : err));
    }

    res.status(201).json(lead);
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    if (req.log) req.log.error('lead_create_failed', { error });
    res.status(500).json({ error: 'Failed to create lead' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const ownerErr = await ownerValidationError(req, (req.body || {}).owner_user_id);
    if (ownerErr) return res.status(400).json({ error: ownerErr });
    const lead = await leads.updateLead(qs(req), req.params.id, req.body || {});
    if (!lead) return res.status(404).json({ error: 'Lead not found (or already converted)' });

    // Fire-and-forget: an explicit owner_user_id in the body is an assignment
    // gesture — notify the new owner unless they made the change themselves.
    if (Number.isInteger((req.body || {}).owner_user_id)
        && Number(lead.owner_user_id) === Number(req.body.owner_user_id)
        && Number(lead.owner_user_id) !== Number(req.userId)) {
      notificationDispatcher.notifyLeadAssigned(lead.id, req.userId)
        .catch(err => console.warn('notify_lead_assigned_failed', err && err.message ? err.message : err));
    }

    res.json(lead);
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    if (req.log) req.log.error('lead_update_failed', { error });
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const lead = await leads.deleteLead(qs(req), req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json({ message: 'Lead deleted', lead });
  } catch (error) {
    if (req.log) req.log.error('lead_delete_failed', { error });
    res.status(500).json({ error: 'Failed to delete lead' });
  }
});

// POST /:id/convert  { createDeal?, dealTitle?, dealAmount?, dealStage? }
router.post('/:id/convert', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await leads.convertLead(
      qs(req),
      req.params.id,
      { userId: req.userId, orgId: req.orgId || null },
      {
        createDeal: !!body.createDeal,
        dealTitle: body.dealTitle,
        dealAmount: body.dealAmount,
        dealStage: body.dealStage,
      }
    );
    if (!result) return res.status(404).json({ error: 'Lead not found' });

    // Fire-and-forget audit — after the transaction committed, so a rolled-
    // back convert never leaves a phantom audit row.
    audit.fromReq(req, {
      event: 'lead.converted',
      targetType: 'lead',
      targetId: String(result.lead.id),
      meta: {
        contact_id: result.contact.id,
        deal_id: result.deal ? result.deal.id : null,
      },
    });

    res.json(result);
  } catch (error) {
    if (error.status === 409) return res.status(409).json({ error: error.message });
    // Invalid dealStage (services/leads.js convertLead) carries a route-
    // equivalent 400 body (INVALID_STAGE + valid_stages), same shape as
    // POST /api/deals.
    if (error.status === 400 && error.body) return res.status(400).json(error.body);
    if (req.log) req.log.error('lead_convert_failed', { error });
    res.status(500).json({ error: 'Failed to convert lead' });
  }
});

module.exports = router;
