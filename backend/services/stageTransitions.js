// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Stage transition graph — per-profile rules for valid stage progressions.
//
// WHY: the FlowArchitect proposal lists 24 deal stages but defines zero
// transition edges, and the current Kanban allows any → any drag with no
// validation. This module is the canonical source of truth for "from stage
// X, valid next stages = …" — backfilled from contract Exhibit A + the
// implicit transitions encoded in services/automation.js + nextSteps.js.
//
// USAGE: in dealRoutes.js PATCH handler, call:
//
//   const guard = require('../services/stageTransitions');
//   const result = guard.check(profile, oldStage, newStage);
//   if (!result.allowed) {
//     // In warn-only mode (default for first 2 weeks): log and proceed.
//     // After enforcement flip: return 400 with result.reason.
//     req.log.warn('invalid_stage_transition', { from: oldStage, to: newStage, reason: result.reason });
//   }
//
// MODE: warn-only by default (logs, allows). Flip ENFORCE_STAGE_TRANSITIONS=true
// in env to enforce.

// ---------------------------------------------------------------------------
// GENERIC profile — boring 6-stage CRM pipeline
// ---------------------------------------------------------------------------
//
// CASE: lowercase. The canonical generic stage IDs are lowercase
// ('lead', 'qualified', 'proposal', 'negotiation', 'closed_won',
// 'closed_lost') — that's what `migrations/011_create_deals.sql` defaults
// to ('lead'), what `utils/dealStages.js` VALID_STAGES enumerates,
// what `routes/metricsRoutes.js` queries for win/loss counts, and what
// `services/automation.js` filters in the hot-deal-stale rule.
// Mismatching the case here made `check()` silently return
// `unknown_from_stage:<lowercase>` for every generic-profile org —
// undetected because `ENFORCE_STAGE_TRANSITIONS` defaults to warn-only.
// Zang's graph keeps uppercase because Exhibit A and the DB rows for
// Zang orgs are uppercase (TRIAGE, VENDOR_QUOTING, …).
const GENERIC = {
  lead:        ['qualified', 'closed_lost'],
  qualified:   ['proposal', 'closed_lost'],
  proposal:    ['negotiation', 'closed_won', 'closed_lost'],
  negotiation: ['closed_won', 'closed_lost'],
  closed_won:  [],
  closed_lost: [],
};

// ---------------------------------------------------------------------------
// ZANG profile — manufacturer's-rep workflow per Hitch contract Exhibit A
// ---------------------------------------------------------------------------
//
// Transition graph derived from:
//   - Contract Exhibit A pages 16-17 (the canonical pipeline)
//   - backend/services/automation.js (existing auto-transitions)
//   - frontend/src/nextSteps.js (intent-driven hints)
//
// Wildcard convention: every Pre-Sale stage may move to LOST or COLD
// (deal goes dark / awarded elsewhere). Every Post-Sale stage may move to
// CANCELLED (order pulled). Listed explicitly to catch typos.
//
// Two FOLLOW_UP semantics share one stage; differentiated by
// deals.follow_up_owner ('customer' | 'zang' | null).
const ZANG = {
  // ---- PRE-SALE -----------------------------------------------------------
  TRIAGE: [
    'VENDOR_QUOTING',  // qualified opportunity, ready to ask vendor
    'NO_QUOTE',        // out of expertise / out of territory
    'COLD',            // customer won't engage further
    'LOST',            // already awarded elsewhere
  ],
  VENDOR_QUOTING: [
    'CUSTOMER_QUOTING', // vendor responded; build customer-facing quote
    'NO_QUOTE',         // vendor declined or no fit
    'COLD',
    'LOST',
  ],
  CUSTOMER_QUOTING: [
    'FOLLOW_UP',        // quote sent to customer, awaiting PO
    'NO_FOLLOW_UP',     // quote sent but small enough we don't chase
    'COLD',
    'LOST',
  ],
  FOLLOW_UP: [
    'NOT_PROCESSED',    // PO arrived
    'COLD',             // customer went silent
    'LOST',             // told us they went elsewhere
    'CANCELLED',        // explicitly cancelled
  ],
  NO_FOLLOW_UP: [
    'NOT_PROCESSED',    // PO arrived unsolicited
    'COLD',
    'LOST',
  ],
  NO_QUOTE: ['LOST'],   // typically a terminal state
  COLD:     ['FOLLOW_UP', 'LOST'], // can be revived if customer re-engages
  LOST:     [],         // terminal

  // ---- POST-SALE ----------------------------------------------------------
  NOT_PROCESSED: [
    'PROCESSED',  // we processed but no vendor PO needed (e.g., services)
    'ORDACK',     // PO sent to vendor, awaiting ack
    'CANCELLED',
  ],
  PROCESSED: [
    'TBI',        // ready to invoice (no fulfillment cycle)
    'CANCELLED',
  ],
  ORDACK: [
    'VAP',        // vendor needs to provide drawings
    'RELACK',     // straight to release ack (no drawings)
    'CANCELLED',
  ],
  VAP:    ['CAP', 'CANCELLED'],
  CAP:    ['RELACK', 'VAP', 'CANCELLED'], // back to VAP if customer rejects
  RELACK: ['MONITOR', 'CANCELLED'],
  MONITOR: [
    'COORDINATE', // ship within 30 days; need close coordination
    'WHSE',       // arrived at warehouse
    'CANCELLED',
  ],
  COORDINATE: ['WHSE', 'CANCELLED'],
  WHSE:       ['TBI', 'CANCELLED'],
  TBI:        ['INVOICED'],
  INVOICED:   ['COMM_WATCH', 'CLOSED_PAID'],
  COMM_WATCH: ['CLOSED_PAID'],
  CLOSED_PAID: ['SERVICE', 'CLOSEOUTS', 'WARRANTY', 'CLOSED'],
  CLOSED:     [],         // terminal
  CANCELLED:  [],         // terminal

  // ---- POST-SHIP (SOW Phase V) -------------------------------------------
  SERVICE:             ['CLOSEOUTS', 'WARRANTY', 'END_USER', 'CLOSED'],
  CLOSEOUTS:           ['CUSTOMER_EXPERIENCE', 'WARRANTY', 'CLOSED'],
  CUSTOMER_EXPERIENCE: ['MARKETING', 'WARRANTY', 'CLOSED'],
  WARRANTY:            ['END_USER', 'CLOSED'],
  MARKETING:           ['CLOSED'],
  END_USER:            ['CLOSED'],
};

const PROFILES = {
  generic: GENERIC,
  zang:    ZANG,
};

/**
 * Check whether a stage transition is valid for the given profile.
 *
 * @param {string} profile   - 'generic' | 'zang' | other registered profile
 * @param {string} fromStage - current stage ID
 * @param {string} toStage   - proposed new stage ID
 * @returns {{allowed: boolean, reason?: string}}
 */
function check(profile, fromStage, toStage) {
  const graph = PROFILES[profile];
  if (!graph) {
    return { allowed: true, reason: `unknown_profile:${profile}_skipping_check` };
  }
  if (fromStage === toStage) {
    return { allowed: true };
  }
  if (!fromStage) {
    // Initial stage assignment — allow.
    return { allowed: true };
  }
  const validNext = graph[fromStage];
  if (!validNext) {
    return { allowed: false, reason: `unknown_from_stage:${fromStage}` };
  }
  if (validNext.includes(toStage)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `from_${fromStage}_to_${toStage}_not_in_graph`,
    validNextStages: validNext,
  };
}

/**
 * Whether the system is currently enforcing transitions or just warning.
 * Controlled by ENFORCE_STAGE_TRANSITIONS env var. Default: warn-only.
 */
function isEnforced() {
  return process.env.ENFORCE_STAGE_TRANSITIONS === 'true';
}

module.exports = {
  check,
  isEnforced,
  PROFILES,
};
