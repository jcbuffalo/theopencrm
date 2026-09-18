// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Deal-stage validation.
//
// Stages are per-org since migration 155 (services/pipelines.js): an org's
// EFFECTIVE pipeline is either its own edited stage list or the profile
// default. Validation therefore takes the pipeline as an argument:
//
//   isValidStage(stage, pipeline)   → boolean
//   assertStage(stage, pipeline)    → throws { status: 400, body } on failure
//   resolveStageId(raw, pipeline)   → exact / case-insensitive id or label
//                                     match, else null (CSV import, chat)
//   phaseForStage(stage, pipeline?) → the deals.phase value for a stage
//
// COMPATIBILITY RULE — an org WITHOUT a custom pipeline accepts its profile
// stages PLUS the legacy global union below (exactly what was accepted
// before), so no existing org sees a stage rejected that used to pass. An
// org WITH a custom pipeline accepts ONLY its own slugs.
//
// `VALID_STAGES` (the legacy union) is still exported for callers that have
// no org context (services/intelWriteback.js); it's a thin wrapper over
// "every profile default id", not a second source of truth.

const VALID_STAGES = [
  'TRIAGE', 'VENDOR_QUOTING', 'CUSTOMER_QUOTING', 'FOLLOW_UP', 'NO_FOLLOW_UP',
  'NO_QUOTE', 'LOST', 'COLD',
  'CANCELLED', 'NOT_PROCESSED', 'PROCESSED', 'ORDACK', 'VAP', 'CAP', 'RELACK',
  'MONITOR', 'COORDINATE', 'WHSE', 'TBI', 'COMM_WATCH', 'INVOICED', 'CLOSED_PAID', 'CLOSED',
  'SERVICE', 'CLOSEOUTS', 'CUSTOMER_EXPERIENCE', 'WARRANTY', 'MARKETING', 'END_USER',
  'lead', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost',
];

// Legacy stage → phase derivation for stages without an explicit pipeline
// phase (generic / jcp / rin pipelines have none; deals.phase is 'pre_sale'
// for them, exactly as before).
const POST_SALE_STAGES = ['CANCELLED', 'NOT_PROCESSED', 'PROCESSED', 'ORDACK', 'VAP', 'CAP', 'RELACK', 'MONITOR', 'COORDINATE', 'WHSE', 'TBI', 'COMM_WATCH', 'INVOICED', 'CLOSED_PAID', 'CLOSED'];
const POST_SHIP_STAGES = ['SERVICE', 'CLOSEOUTS', 'CUSTOMER_EXPERIENCE', 'WARRANTY', 'MARKETING', 'END_USER'];

function legacyPhaseForStage(stage) {
  if (POST_SHIP_STAGES.includes(stage)) return 'post_ship';
  if (POST_SALE_STAGES.includes(stage)) return 'post_sale';
  return 'pre_sale';
}

function stageIds(pipeline) {
  return pipeline && Array.isArray(pipeline.stages) ? pipeline.stages.map((st) => st.id) : [];
}

function isValidStage(stage, pipeline) {
  if (typeof stage !== 'string' || !stage) return false;
  if (!pipeline) return VALID_STAGES.includes(stage);
  if (stageIds(pipeline).includes(stage)) return true;
  return !pipeline.is_custom && VALID_STAGES.includes(stage);
}

function validStagesFor(pipeline) {
  if (!pipeline) return VALID_STAGES.slice();
  const ids = stageIds(pipeline);
  return pipeline.is_custom ? ids : Array.from(new Set([...ids, ...VALID_STAGES]));
}

function assertStage(stage, pipeline) {
  if (!isValidStage(stage, pipeline)) {
    throw Object.assign(new Error('Invalid stage'), {
      status: 400,
      body: { error: 'Invalid stage', code: 'INVALID_STAGE', stage, valid_stages: stageIds(pipeline).length ? stageIds(pipeline) : VALID_STAGES },
    });
  }
  return stage;
}

// "Closed Won" / "closed_won" / "CLOSED_WON" / a label → the real stage id.
function resolveStageId(raw, pipeline) {
  const str = String(raw == null ? '' : raw).trim();
  if (!str) return null;
  if (isValidStage(str, pipeline)) return str;
  const snake = str.replace(/[\s-]+/g, '_');
  const candidates = [snake, snake.toLowerCase(), snake.toUpperCase()];
  for (const c of candidates) if (isValidStage(c, pipeline)) return c;
  const lower = str.toLowerCase();
  for (const st of (pipeline && pipeline.stages) || []) {
    if (st.id.toLowerCase() === lower || String(st.label || '').toLowerCase() === lower) return st.id;
  }
  if (!pipeline || !pipeline.is_custom) {
    for (const v of VALID_STAGES) if (v.toLowerCase() === lower || v.toLowerCase() === snake.toLowerCase()) return v;
  }
  return null;
}

function phaseForStage(stage, pipeline) {
  if (pipeline && Array.isArray(pipeline.stages)) {
    const st = pipeline.stages.find((x) => x.id === stage);
    if (st && st.phase) return st.phase;
  }
  return legacyPhaseForStage(stage);
}

module.exports = { VALID_STAGES, isValidStage, validStagesFor, assertStage, resolveStageId, phaseForStage, legacyPhaseForStage };
