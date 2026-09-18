// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Phase B — per-org usage metering.
//
// Increments per-org per-period counters. Used by services/ai.js (AI cost
// tracking) and will be used by the plugin runner (Phase C) and billing
// (Phase F). Read path (getUsage) feeds the future Usage dashboard.
//
// CONVENTIONS:
//   - period is 'YYYY-MM' (current calendar month, UTC)
//   - metric is a short snake_case string registered in METRICS below
//   - estimated_cost_usd_cents is OUR cost (not the customer's price)
//
// CONCURRENCY:
//   The increment() UPSERT is atomic. Two concurrent increments race-safely
//   on the (org_id, period, metric) UNIQUE constraint.

const pool = require('../db');
const logger = require('./logger');

const METRICS = {
  ai_requests:        { description: 'Total Claude API calls' },
  ai_input_tokens:    { description: 'Sum of input tokens billed by Anthropic' },
  ai_output_tokens:   { description: 'Sum of output tokens billed by Anthropic' },
  plugin_runs:        { description: 'Total plugin invocations (Phase C)' },
  plugin_run_ms:      { description: 'Total CPU ms across plugin invocations' },
  emails_sent:        { description: 'Outbound emails dispatched via services/email.js' },
  documents_uploaded_bytes: { description: 'Total bytes uploaded to GCS via documents module' },
};

// Anthropic pricing as of mid-2026 (Claude Opus 4.x) per million tokens.
// Update when pricing changes. These are our cost; customer-facing pricing
// is set in PLUGIN_PLATFORM_VISION.md.
const ANTHROPIC_PRICING = {
  input_per_million_usd:  3.00,   // $3 per 1M input tokens
  output_per_million_usd: 15.00,  // $15 per 1M output tokens
};

function currentPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Increment a counter atomically. Returns the new total.
 * @param {number} orgId
 * @param {string} metric - one of METRICS keys
 * @param {number} count - usually 1 for events, or token count for AI
 * @param {number} costCents - estimated platform cost in USD cents
 */
async function increment(orgId, metric, count = 1, costCents = 0) {
  if (!orgId) return; // unscoped calls don't get metered; usually means anon endpoint
  if (!METRICS[metric]) {
    logger.warn('usage_meter_unknown_metric', { metric });
    // Still record it — better to over-record than to lose data on a new metric.
  }
  try {
    await pool.query(
      `INSERT INTO usage_meter (org_id, period, metric, count, estimated_cost_usd_cents, first_at, last_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (org_id, period, metric) DO UPDATE
         SET count = usage_meter.count + EXCLUDED.count,
             estimated_cost_usd_cents = usage_meter.estimated_cost_usd_cents + EXCLUDED.estimated_cost_usd_cents,
             last_at = NOW()`,
      [orgId, currentPeriod(), metric, count, Math.round(costCents)]
    );
  } catch (err) {
    // Never let a metering write fail a real operation. Log and move on.
    logger.warn('usage_meter_write_failed', { orgId, metric, error: err.message });
  }
}

/**
 * Convenience: increment AI usage with cost auto-computed from token counts.
 */
async function recordAiUsage(orgId, { inputTokens = 0, outputTokens = 0 } = {}) {
  if (!orgId) return;
  const inputCostCents  = (inputTokens  / 1_000_000) * ANTHROPIC_PRICING.input_per_million_usd  * 100;
  const outputCostCents = (outputTokens / 1_000_000) * ANTHROPIC_PRICING.output_per_million_usd * 100;
  await Promise.all([
    increment(orgId, 'ai_requests',      1, 0),
    increment(orgId, 'ai_input_tokens',  inputTokens,  inputCostCents),
    increment(orgId, 'ai_output_tokens', outputTokens, outputCostCents),
  ]);
}

/**
 * Read usage for an org. Optional period defaults to current month.
 * Returns { period, metrics: { metric: { count, costCents, firstAt, lastAt } } }.
 */
async function getUsage(orgId, period = null) {
  const p = period || currentPeriod();
  const r = await pool.query(
    `SELECT metric, count, estimated_cost_usd_cents, first_at, last_at
       FROM usage_meter
      WHERE org_id = $1 AND period = $2`,
    [orgId, p]
  );
  const metrics = {};
  for (const row of r.rows) {
    metrics[row.metric] = {
      count: Number(row.count),
      estimatedCostCents: Number(row.estimated_cost_usd_cents),
      firstAt: row.first_at,
      lastAt: row.last_at,
    };
  }
  return { period: p, metrics };
}

module.exports = {
  METRICS,
  ANTHROPIC_PRICING,
  currentPeriod,
  increment,
  recordAiUsage,
  getUsage,
};
