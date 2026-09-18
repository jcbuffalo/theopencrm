// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Per-call Claude token-usage metering + per-user upcharge accounting.
//
// SCOPE: One row per Anthropic SDK response is INSERTed into
// ai_usage_events (migration 080). The aggregator powers the /usage page
// and the Stripe-meter scaffold in aiBilling.js.
//
// WHY THIS LIVES SEPARATELY FROM usageMeter.js:
//   - usage_meter is a (org, period, metric) aggregate keyed on YYYY-MM
//     strings and used for quota enforcement. The grain is too coarse to
//     answer "which endpoint costs us the most" or "what does Joe owe".
//   - ai_usage_events is append-only at per-call grain, with model and
//     endpoint labels. It's the canonical source for billing reconciliation.
//   - Both keep counting in parallel during the transition (usageMeter is
//     still the source of truth for quotaEnforcer); collapsing them is a
//     follow-up once we trust the new ledger.
//
// MICRO-DOLLARS: All cost columns are integer micro-dollars (1 USD =
// 1,000,000 µUSD). Rationale: NUMERIC accumulation has rounding drift on
// millions of rows, and Stripe meter quantities are integers. One Anthropic
// input token at $3/1M tokens = 3 µUSD, so we never lose precision.
//
// FIRE-AND-FORGET: recordUsage swallows every error. A metering hiccup
// MUST NOT break the user-facing AI request — same pattern as audit.js
// and usageMeter.js.

const pool = require('../db');
const logger = require('./logger');
const audit = require('./audit');

// =============================================================================
// Pricing — Anthropic public pricing as of May 2026.
// =============================================================================
// Source verified via WebSearch 2026-05-16:
//   - Opus 4.7   $5/M input · $25/M output
//   - Sonnet 4.6 $3/M input · $15/M output
//   - Haiku 4.5  $1/M input · $5/M output
// Cache read is roughly 10% of input cost; cache write (5-minute TTL) is
// roughly 125% of input cost. These multipliers are stable across the
// Anthropic price book and have held through several model refreshes.
//
// If pricing changes, update this table and document the date. Past
// ai_usage_events rows keep the cost they were stamped with at write time
// (we don't retroactively repricе history — that's why we materialize the
// computed cost into the row instead of recomputing on read).
//
// Unknown models fall back to the default below (Sonnet's prices). This is
// intentional: we'd rather over-charge ourselves slightly than fail-open to
// $0 for a freshly-released model whose ID we haven't mapped yet.
const MODEL_PRICING_PER_M_TOKENS = {
  'claude-opus-4-7':   { input: 5.00,  output: 25.00 },
  'claude-opus-4-6':   { input: 5.00,  output: 25.00 },  // same generation, kept for back-compat
  'claude-opus-4':     { input: 15.00, output: 75.00 },  // older opus, retired
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00 },
  'claude-sonnet-4-5': { input: 3.00,  output: 15.00 },
  'claude-sonnet-4':   { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5':  { input: 1.00,  output: 5.00 },
  'claude-haiku-4':    { input: 0.80,  output: 4.00 },   // older haiku
};

const DEFAULT_PRICING = { input: 3.00, output: 15.00 }; // safe-side default = Sonnet

// ai_usage_events.billing_mode values (migration 154). 'platform' rows are
// charged at cost × UPCHARGE_MULTIPLIER; 'byo_key' rows come from an org's
// own Anthropic key and carry charged_usd_micro = 0. 'gateway' rows (spec
// 202) only exist on a SELF-HOSTED instance whose calls went out through the
// hosted AI gateway: tokens + raw cost are recorded locally for visibility,
// but charged_usd_micro = 0 here because the HOSTED platform's own ledger
// (endpoint='gateway', billing_mode='platform') is what actually bills the
// gateway org — charging locally too would double-count.
const BILLING_MODE_PLATFORM = 'platform';
const BILLING_MODE_BYO = 'byo_key';
const BILLING_MODE_GATEWAY = 'gateway';
const ZERO_CHARGE_MODES = new Set([BILLING_MODE_BYO, BILLING_MODE_GATEWAY]);

// Cache pricing is derived: read ≈ 10% of input, write ≈ 125% of input.
// Encoded as multipliers so a tier-specific change is a one-liner.
const CACHE_READ_MULTIPLIER  = 0.10;
const CACHE_WRITE_MULTIPLIER = 1.25;

// Per-process dedupe set so a freshly-released model id only logs once
// per restart instead of spamming on every metered call. The audit event
// (ai.unknown_model_fallback) fires exactly once per (process, model)
// tuple — same fire-once-per-startup pattern as services/envValidation.js
// and services/email.js cache the warm-up state.
const seenUnknownModels = new Set();

// Customer-facing upcharge over our raw cost. 2× by default covers
// pass-through + margin + the Anthropic price-volatility risk we eat
// between meter posts. Per-tier multipliers are a follow-up; today this
// is one knob across all customers.
// Finite-check (not `|| 2.0`) so an explicit `0` — pass-through, no markup —
// is honored instead of silently coerced back to 2×. Any non-finite or
// negative value falls back to the 2× default.
const _rawMultiplier = Number(process.env.CLAUDE_UPCHARGE_MULTIPLIER);
const UPCHARGE_MULTIPLIER = Number.isFinite(_rawMultiplier) && _rawMultiplier >= 0
  ? _rawMultiplier
  : 2.0;

function pricingFor(model) {
  const known = MODEL_PRICING_PER_M_TOKENS[model];
  if (known) return known;
  // First time we see this (model id) per process? Surface a console.warn
  // AND write an audit row so we notice when a fresh Anthropic model id
  // gets deployed via ANTHROPIC_MODEL without us updating the price table.
  // Subsequent calls are silent — same fire-once-per-startup idiom used
  // elsewhere in the codebase (envValidation, email cache).
  if (model && !seenUnknownModels.has(model)) {
    seenUnknownModels.add(model);
    console.warn(
      `[aiMetering] Unknown model "${model}" — falling back to Sonnet pricing ` +
      `($${DEFAULT_PRICING.input}/M input, $${DEFAULT_PRICING.output}/M output). ` +
      `Update MODEL_PRICING_PER_M_TOKENS in services/aiMetering.js to track the real rate.`
    );
    // Fire-and-forget audit row. We swallow errors via audit.record's
    // built-in try/catch — orgId/userId aren't available at this seam so
    // the row is global-scope (org_id NULL).
    audit.record({
      event: audit.EVENTS.AI_UNKNOWN_MODEL_FALLBACK,
      meta: {
        model,
        fallback_input_per_m_usd:  DEFAULT_PRICING.input,
        fallback_output_per_m_usd: DEFAULT_PRICING.output,
      },
    });
  }
  return DEFAULT_PRICING;
}

/**
 * Compute the raw Anthropic cost for a usage object, in micro-dollars.
 *
 * @param {string} model - the Anthropic model identifier
 * @param {object} usage - the .usage object from a Claude response (input_tokens,
 *                         output_tokens, optionally cache_creation_input_tokens,
 *                         cache_read_input_tokens)
 * @returns {{cost_usd_micro: number, charged_usd_micro: number}}
 */
function computeCost(model, usage) {
  const price = pricingFor(model);
  const input  = Number(usage?.input_tokens  || 0);
  const output = Number(usage?.output_tokens || 0);
  // Anthropic exposes both `cache_creation_input_tokens` and
  // `cache_read_input_tokens` in the SDK response when prompt caching is in
  // use. They live on the same .usage object. Default to 0 when absent.
  const cacheCreate = Number(usage?.cache_creation_input_tokens || 0);
  const cacheRead   = Number(usage?.cache_read_input_tokens     || 0);

  // Per-token µUSD: ($/M tokens × 1,000,000 µUSD/$ ÷ 1,000,000 tokens) = $/M as µUSD-per-token.
  // Simplifies to: price_per_million_usd µUSD per token. We compute as
  // tokens × price / 1 (since µUSD per token = price_per_M).
  const inputMicroPerToken  = price.input;
  const outputMicroPerToken = price.output;
  const cacheReadMicroPerToken  = price.input * CACHE_READ_MULTIPLIER;
  const cacheWriteMicroPerToken = price.input * CACHE_WRITE_MULTIPLIER;

  const costMicro = Math.round(
    input  * inputMicroPerToken
    + output * outputMicroPerToken
    + cacheRead   * cacheReadMicroPerToken
    + cacheCreate * cacheWriteMicroPerToken
  );

  const chargedMicro = Math.round(costMicro * UPCHARGE_MULTIPLIER);

  return { cost_usd_micro: costMicro, charged_usd_micro: chargedMicro };
}

/**
 * Append one row to ai_usage_events. Fire-and-forget — never throws.
 *
 * @param {object} opts
 * @param {number} opts.orgId    - required; rows without orgId are dropped
 *                                 (we can't bill what we can't attribute)
 * @param {number} opts.userId   - optional; the seat that triggered the call
 * @param {string} opts.endpoint - short label, e.g. 'summarize-deal', 'chat'
 * @param {string} opts.model    - Anthropic model id, e.g. 'claude-sonnet-4-6'
 * @param {object} opts.usage    - the raw .usage object from the SDK response
 * @param {string} [opts.billingMode='platform'] - 'platform' (deployment key,
 *                                 charged at cost × upcharge) or 'byo_key'
 *                                 (the org's own Anthropic key, migration 154:
 *                                 tokens + raw cost still recorded for
 *                                 visibility, charged_usd_micro forced to 0
 *                                 because Anthropic bills the customer)
 */
async function recordUsage({ orgId, userId = null, endpoint, model, usage, billingMode = 'platform' }) {
  if (!orgId) return; // unattributed calls (e.g. system jobs without org) skip the ledger
  if (!usage || typeof usage !== 'object') return;
  try {
    const mode = ZERO_CHARGE_MODES.has(billingMode) ? billingMode : BILLING_MODE_PLATFORM;
    const computed = computeCost(model, usage);
    const cost_usd_micro = computed.cost_usd_micro;
    const charged_usd_micro = ZERO_CHARGE_MODES.has(mode) ? 0 : computed.charged_usd_micro;
    const inputTokens         = Number(usage.input_tokens  || 0);
    const outputTokens        = Number(usage.output_tokens || 0);
    const cacheCreationTokens = Number(usage.cache_creation_input_tokens || 0);
    const cacheReadTokens     = Number(usage.cache_read_input_tokens     || 0);

    await pool.query(
      `INSERT INTO ai_usage_events
         (org_id, user_id, endpoint, model,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
          cost_usd_micro, charged_usd_micro, billing_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [orgId, userId, String(endpoint || 'unknown').slice(0, 64),
       String(model || 'unknown').slice(0, 64),
       inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
       cost_usd_micro, charged_usd_micro, mode]
    );

    // Audit-trail row. Best-effort; audit.record already swallows failures.
    // We don't await — fire-and-forget. Meta carries the per-row cost so a
    // forensic reader can reconstruct billing without joining the ledger.
    audit.record({
      event: audit.EVENTS.AI_USAGE_RECORDED,
      actorUserId: userId,
      orgId,
      targetType: 'ai_usage_event',
      meta: {
        endpoint,
        model,
        input_tokens:  inputTokens,
        output_tokens: outputTokens,
        cache_creation_tokens: cacheCreationTokens,
        cache_read_tokens:     cacheReadTokens,
        cost_usd_micro,
        charged_usd_micro,
        billing_mode: mode,
      },
    });
  } catch (err) {
    // Never let metering kill a real request. Log and move on.
    logger.warn('ai_metering_write_failed', { orgId, endpoint, error: err.message });
  }
}

// =============================================================================
// Read path — aggregations for the /usage page.
// =============================================================================

/**
 * Aggregate ai_usage_events between [from, to). Returns totals plus
 * breakdowns by endpoint, user, and day. All cost values come back as
 * USD numbers (not micro-dollars) for direct display.
 *
 * @param {object} opts
 * @param {number} opts.orgId
 * @param {Date|string} opts.from - inclusive lower bound
 * @param {Date|string} opts.to   - exclusive upper bound
 */
async function summarizeUsage({ orgId, from, to }) {
  if (!orgId) {
    return emptySummary();
  }
  const fromTs = from instanceof Date ? from.toISOString() : from;
  const toTs   = to   instanceof Date ? to.toISOString()   : to;

  // Single connection, three queries — issued in parallel. Read-only, no
  // transaction needed (the ledger is append-only).
  const [totals, byEndpoint, byUser, byDay] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int                                          AS calls,
         COALESCE(SUM(input_tokens), 0)::bigint                 AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0)::bigint                AS total_output_tokens,
         COALESCE(SUM(cache_creation_tokens), 0)::bigint        AS total_cache_creation_tokens,
         COALESCE(SUM(cache_read_tokens), 0)::bigint            AS total_cache_read_tokens,
         COALESCE(SUM(cost_usd_micro), 0)::bigint               AS cost_micro,
         COALESCE(SUM(charged_usd_micro), 0)::bigint            AS charged_micro,
         COUNT(*) FILTER (WHERE billing_mode = 'byo_key')::int  AS byo_key_calls
       FROM ai_usage_events
       WHERE org_id = $1 AND created_at >= $2 AND created_at < $3`,
      [orgId, fromTs, toTs]
    ),
    pool.query(
      `SELECT
         endpoint,
         COUNT(*)::int                          AS calls,
         COUNT(*) FILTER (WHERE billing_mode = 'byo_key')::int AS byo_key_calls,
         COALESCE(SUM(input_tokens), 0)::bigint  AS input_tokens,
         COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
         COALESCE(SUM(cost_usd_micro), 0)::bigint    AS cost_micro,
         COALESCE(SUM(charged_usd_micro), 0)::bigint AS charged_micro
       FROM ai_usage_events
       WHERE org_id = $1 AND created_at >= $2 AND created_at < $3
       GROUP BY endpoint
       ORDER BY charged_micro DESC`,
      [orgId, fromTs, toTs]
    ),
    pool.query(
      `SELECT
         e.user_id,
         u.email AS user_email,
         COUNT(*)::int                          AS calls,
         COALESCE(SUM(e.input_tokens), 0)::bigint  AS input_tokens,
         COALESCE(SUM(e.output_tokens), 0)::bigint AS output_tokens,
         COALESCE(SUM(e.cost_usd_micro), 0)::bigint    AS cost_micro,
         COALESCE(SUM(e.charged_usd_micro), 0)::bigint AS charged_micro
       FROM ai_usage_events e
       LEFT JOIN users u ON u.id = e.user_id
       WHERE e.org_id = $1 AND e.created_at >= $2 AND e.created_at < $3
       GROUP BY e.user_id, u.email
       ORDER BY charged_micro DESC`,
      [orgId, fromTs, toTs]
    ),
    pool.query(
      `SELECT
         date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day,
         COUNT(*)::int                          AS calls,
         COALESCE(SUM(input_tokens), 0)::bigint  AS input_tokens,
         COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
         COALESCE(SUM(cost_usd_micro), 0)::bigint    AS cost_micro,
         COALESCE(SUM(charged_usd_micro), 0)::bigint AS charged_micro
       FROM ai_usage_events
       WHERE org_id = $1 AND created_at >= $2 AND created_at < $3
       GROUP BY day
       ORDER BY day ASC`,
      [orgId, fromTs, toTs]
    ),
  ]);

  const t = totals.rows[0] || {};
  return {
    total_input_tokens:           Number(t.total_input_tokens  || 0),
    total_output_tokens:          Number(t.total_output_tokens || 0),
    total_cache_creation_tokens:  Number(t.total_cache_creation_tokens || 0),
    total_cache_read_tokens:      Number(t.total_cache_read_tokens || 0),
    total_calls:                  Number(t.calls || 0),
    total_cost_usd:               microToUsd(t.cost_micro),
    total_charged_usd:            microToUsd(t.charged_micro),
    upcharge_multiplier:          UPCHARGE_MULTIPLIER,
    // Calls made under the org's own Anthropic key (billing_mode='byo_key').
    // These are in every total above for visibility but contributed $0 to
    // total_charged_usd.
    byo_key_calls:                Number(t.byo_key_calls || 0),
    by_endpoint: byEndpoint.rows.map(r => ({
      endpoint:       r.endpoint,
      calls:          Number(r.calls),
      byo_key_calls:  Number(r.byo_key_calls || 0),
      input_tokens:   Number(r.input_tokens),
      output_tokens:  Number(r.output_tokens),
      cost_usd:       microToUsd(r.cost_micro),
      charged_usd:    microToUsd(r.charged_micro),
    })),
    by_user: byUser.rows.map(r => ({
      user_id:        r.user_id,
      user_email:     r.user_email,
      calls:          Number(r.calls),
      input_tokens:   Number(r.input_tokens),
      output_tokens:  Number(r.output_tokens),
      cost_usd:       microToUsd(r.cost_micro),
      charged_usd:    microToUsd(r.charged_micro),
    })),
    by_day: byDay.rows.map(r => ({
      day:            r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
      calls:          Number(r.calls),
      input_tokens:   Number(r.input_tokens),
      output_tokens:  Number(r.output_tokens),
      cost_usd:       microToUsd(r.cost_micro),
      charged_usd:    microToUsd(r.charged_micro),
    })),
  };
}

function emptySummary() {
  return {
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_creation_tokens: 0,
    total_cache_read_tokens: 0,
    total_calls: 0,
    total_cost_usd: 0,
    total_charged_usd: 0,
    upcharge_multiplier: UPCHARGE_MULTIPLIER,
    byo_key_calls: 0,
    by_endpoint: [],
    by_user: [],
    by_day: [],
  };
}

function microToUsd(micro) {
  return Number(micro || 0) / 1_000_000;
}

/**
 * Aggregate last-completed-calendar-month for one org. Used by the Stripe
 * meter push (services/aiBilling.js). Returns the same shape as
 * summarizeUsage() so the billing job can log + post in one pass.
 *
 * "Last completed month" = the calendar month BEFORE today, UTC. E.g. on
 * 2026-05-16 it returns 2026-04-01 to 2026-05-01.
 */
async function summarizeLastCompletedMonth(orgId) {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const to   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(),     1));
  return summarizeUsage({ orgId, from, to });
}

/**
 * Aggregate a single calendar month for one org. Convenience wrapper used by
 * the AI billing endpoints (/api/billing/ai/status) and the threshold worker.
 *
 * @param {number} orgId
 * @param {number} year - 4-digit UTC year (e.g. 2026)
 * @param {number} month - 1-12 UTC month
 */
async function summarizeMonthForOrg(orgId, year, month) {
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to   = new Date(Date.UTC(year, month,     1));
  return summarizeUsage({ orgId, from, to });
}

/**
 * Aggregate last completed month across ALL orgs. Returns an array of
 * { orgId, summary } pairs. Used by the Stripe-meter cron.
 */
async function summarizeLastMonthAllOrgs() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const to   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(),     1));
  const orgs = await pool.query(
    `SELECT DISTINCT org_id FROM ai_usage_events
     WHERE created_at >= $1 AND created_at < $2`,
    [from.toISOString(), to.toISOString()]
  );
  const out = [];
  for (const row of orgs.rows) {
    const summary = await summarizeUsage({ orgId: row.org_id, from, to });
    out.push({ orgId: row.org_id, summary, periodFrom: from, periodTo: to });
  }
  return out;
}

module.exports = {
  MODEL_PRICING_PER_M_TOKENS,
  DEFAULT_PRICING,
  UPCHARGE_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  BILLING_MODE_PLATFORM,
  BILLING_MODE_BYO,
  BILLING_MODE_GATEWAY,
  computeCost,
  recordUsage,
  summarizeUsage,
  summarizeLastCompletedMonth,
  summarizeMonthForOrg,
  summarizeLastMonthAllOrgs,
  microToUsd,
};
