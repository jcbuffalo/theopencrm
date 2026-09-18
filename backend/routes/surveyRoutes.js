// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// NPS/CSAT Surveys (CS-7, migration 138) — two routers in one file, mirroring
// routes/leadFormRoutes.js:
//
//   1. `router` — AUTHENTICATED survey management, mounted at /api/surveys
//      behind requireFeature('customer_success_enabled'). CRUD + generate
//      response links + results + an EXPLICIT manual send action.
//
//   2. `publicRouter` — the PUBLIC response surface, mounted at
//      /api/public/surveys with NO auth. Abuse-surface treatment:
//        • per-IP rate limited (surveyResponseLimiter, mounted in index.js)
//        • CSRF-exempt (prefix in isCsrfExempt — anonymous respondents have
//          no session, and the endpoint grants nothing to the caller)
//        • org resolved ONLY from the unguessable 192-bit response token —
//          no org id ever appears in a request or response
//        • unknown token, inactive survey, and feature-flag-off all return
//          the SAME generic 404 (no existence oracle)
//        • a token records EXACTLY ONE response (responded_at IS NULL guard)
//
// ⚠️ NO AUTO-SEND: creating a survey creates nothing but the survey row.
// Links are minted by an explicit POST /:id/links; email goes out only via an
// explicit POST /:id/send with a hand-picked contact list, routed through
// services/email.js (console no-op when unconfigured).

const express = require('express');
const pool = require('../db');
const { authMiddleware } = require('../auth');
const surveys = require('../services/surveys');
const featureFlags = require('../services/featureFlags');

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }
function scopeOf(req) {
  const [sf, sv] = qs(req);
  return { sf, sv, orgId: req.orgId || null, userId: req.userId };
}

// Map a typed SurveyError to its status; anything else is a 500.
function fail(req, res, error, event, msg) {
  if (error instanceof surveys.SurveyError) {
    return res.status(error.status).json({ error: error.message });
  }
  if (req.log) req.log.error(event, { error });
  return res.status(500).json({ error: msg });
}

// ---------------------------------------------------------------------------
// Authenticated survey management
// ---------------------------------------------------------------------------

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    res.json(await surveys.listSurveys(scopeOf(req), pool));
  } catch (error) {
    fail(req, res, error, 'surveys_list_failed', 'Failed to fetch surveys');
  }
});

// NOTE: /summary must be declared before /:id.
router.get('/summary', async (req, res) => {
  try {
    res.json(await surveys.summary(scopeOf(req), pool));
  } catch (error) {
    fail(req, res, error, 'surveys_summary_failed', 'Failed to compute survey summary');
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const created = await surveys.createSurvey(scopeOf(req), body, pool);
    res.status(201).json(created);
  } catch (error) {
    fail(req, res, error, 'survey_create_failed', 'Failed to create survey');
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await surveys.surveyResults(scopeOf(req), req.params.id, pool));
  } catch (error) {
    fail(req, res, error, 'survey_results_failed', 'Failed to fetch survey results');
  }
});

router.put('/:id', async (req, res) => {
  try {
    res.json(await surveys.updateSurvey(scopeOf(req), req.params.id, req.body || {}, pool));
  } catch (error) {
    fail(req, res, error, 'survey_update_failed', 'Failed to update survey');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await surveys.deleteSurvey(scopeOf(req), req.params.id, pool);
    res.json({ message: 'Survey deleted' });
  } catch (error) {
    fail(req, res, error, 'survey_delete_failed', 'Failed to delete survey');
  }
});

// Mint response links (pending rows + tokens). NEVER sends anything.
router.post('/:id/links', async (req, res) => {
  try {
    const body = req.body || {};
    const { created } = await surveys.createResponseTokens(
      scopeOf(req), req.params.id,
      { contactIds: body.contact_ids, count: body.count },
      pool
    );
    res.status(201).json({
      created: created.map((r) => ({
        id: r.id,
        contact_id: r.contact_id,
        company_id: r.company_id,
        token: r.response_token,
        path: `/s/${r.response_token}`,
      })),
    });
  } catch (error) {
    fail(req, res, error, 'survey_links_failed', 'Failed to generate response links');
  }
});

// EXPLICIT manual send to a hand-picked contact list. Degrades gracefully when
// the email transport is unconfigured (configured:false, links still minted).
router.post('/:id/send', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await surveys.sendSurvey(
      scopeOf(req), req.params.id, { contactIds: body.contact_ids }, pool
    );
    res.json(result);
  } catch (error) {
    fail(req, res, error, 'survey_send_failed', 'Failed to send survey');
  }
});

// ---------------------------------------------------------------------------
// Public response surface — NO AUTH. See file header for the threat model.
// ---------------------------------------------------------------------------

const publicRouter = express.Router();

const GENERIC_404 = { error: 'Not found' };

// Resolve an active-survey response row by token, re-checking the org's
// customer_success_enabled flag (org disabled the module → the public surface
// disappears too; user_id-scoped rows skip the check — flags are an org
// concept). Every failure mode → null → generic 404.
async function resolveRespondable(token) {
  const row = await surveys.resolveByToken(token, pool);
  if (!row) return null;
  if (row.org_id) {
    const enabled = await featureFlags.hasFeature(row.org_id, 'customer_success_enabled');
    if (!enabled) return null;
  }
  return row;
}

// GET /:token — just enough to render the response page: question + scale.
// No org name, no ids, no respondent info.
publicRouter.get('/:token', async (req, res) => {
  try {
    const row = await resolveRespondable(req.params.token);
    if (!row) return res.status(404).json(GENERIC_404);
    res.json({
      name: row.name,
      question: row.question,
      kind: row.kind,
      scale: surveys.SCALES[row.kind] || surveys.SCALES.nps,
      responded: row.responded_at != null,
    });
  } catch (error) {
    if (req.log) req.log.error('survey_public_get_failed', { error });
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// POST /:token/respond — record exactly one response for this token.
publicRouter.post('/:token/respond', async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Invalid submission' });
    }
    // Anonymous responses never legitimately exceed a few KB.
    if (JSON.stringify(body).length > 16384) {
      return res.status(413).json({ error: 'Submission too large' });
    }

    const row = await resolveRespondable(req.params.token);
    if (!row) return res.status(404).json(GENERIC_404);

    const result = await surveys.recordResponse(row, { score: body.score, comment: body.comment }, pool);
    res.json(result);
  } catch (error) {
    if (error instanceof surveys.SurveyError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (req.log) req.log.error('survey_public_respond_failed', { error });
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
module.exports.publicRouter = publicRouter;
