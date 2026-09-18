// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Stripe billing endpoints.
//
//   POST /api/billing/checkout       — create a Checkout session for a tier
//                                       upgrade. Returns { url } the frontend
//                                       redirects to.
//   POST /api/billing/portal         — return a Stripe Customer Portal URL
//                                       so the customer can manage their
//                                       subscription, card, invoices.
//   POST /api/billing/webhook        — Stripe → us, on subscription events.
//                                       Updates organizations.tier and
//                                       organizations.stripe_customer_id.
//                                       MUST be mounted with express.raw()
//                                       so signature verification works.
//   GET  /api/billing/status         — caller's tier + stripe linkage state
//
// Webhook events handled:
//   • checkout.session.completed       — user finished a successful upgrade
//   • customer.subscription.updated    — plan change (e.g., Starter → Pro)
//   • customer.subscription.deleted    — subscription canceled (revert to free)
//   • invoice.payment_failed           — alert the operator + admin
//
// All routes return 503 STRIPE_NOT_CONFIGURED when keys aren't set, so the
// frontend can render "upgrade" buttons that gracefully explain billing
// isn't wired yet rather than crashing.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const stripeService = require('../services/stripe');
const audit = require('../services/audit');
const adminNotify = require('../services/adminNotify');
const logger = require('../services/logger');
const aiMetering = require('../services/aiMetering');
const aiThresholdWorker = require('../services/aiThresholdWorker');
const requireAiBilling = require('../middleware/requireAiBilling');
const { isSuperAdmin } = require('../middleware/adminAuth');

const router = express.Router();

// Helper — was the requesting user authorized to manage billing for the
// caller's org? Org admins (role='admin'/'owner') and super-admins qualify.
// First configured frontend origin (FRONTEND_URL may be comma-separated for
// multi-origin CORS). Falls back to the production app host so a missing
// var never produces a relative/broken Stripe return URL.
function frontendBaseUrl() {
  const first = (process.env.FRONTEND_URL || '').split(',').map(s => s.trim()).filter(Boolean)[0];
  return (first || 'https://app.theopencrm.com').replace(/\/+$/, '');
}

async function canManageOrgBilling(req) {
  if (req.orgRole === 'admin' || req.orgRole === 'owner') return true;
  if (req.userId && await isSuperAdmin(req.userId)) return true;
  return false;
}

// Helper — apply a status transition + bust the middleware cache. Centralizes
// the cache invalidation so we don't have to remember it at every call site.
async function updateAiBillingStatus(orgId, patch) {
  const fields = [];
  const values = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = $${i++}`);
    values.push(v);
  }
  fields.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(orgId);
  await pool.query(
    `UPDATE organizations SET ${fields.join(', ')} WHERE id = $${i}`,
    values
  );
  requireAiBilling.bustCache(orgId);
}

// --------------------------------------------------------------------------
// Webhook receiver — MUST come BEFORE express.json() body parser. Mounted
// with express.raw() so the signature verification sees the original bytes.
// --------------------------------------------------------------------------
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripeService.isConfigured()) {
    return res.status(503).json({ error: 'Stripe not configured', code: 'STRIPE_NOT_CONFIGURED' });
  }
  let event;
  try {
    event = stripeService.verifyWebhook(req.body, req.headers['stripe-signature']);
  } catch (err) {
    logger.warn('stripe_webhook_verify_failed', { error: err.message });
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  // Idempotency guard — Stripe delivers at-least-once, so the same event id can
  // arrive multiple times. Claim it before doing any work: if the row already
  // exists this is a duplicate retry and we must NOT reprocess (that would send
  // duplicate admin emails and write duplicate audit rows). See migration 101.
  try {
    const claim = await pool.query(
      `INSERT INTO stripe_webhook_events (event_id) VALUES ($1)
       ON CONFLICT DO NOTHING RETURNING event_id`,
      [event.id]
    );
    if (claim.rowCount === 0) {
      logger.info('stripe_webhook_duplicate_ignored', { eventId: event.id, type: event.type });
      return res.json({ received: true, duplicate: true });
    }
  } catch (err) {
    // Fail closed: if the dedupe store is unreachable we return 500 so Stripe
    // retries later, rather than processing without idempotency and risking the
    // duplicate emails/audit rows this guard exists to prevent.
    logger.error('stripe_webhook_dedupe_failed', { eventId: event?.id, error: err.message });
    return res.status(500).json({ error: 'Webhook dedupe unavailable' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const orgId = Number(session.metadata?.org_id);
        const product = String(session.metadata?.product || '').toLowerCase();
        const tier  = String(session.metadata?.tier || '').toLowerCase();

        // AI Pay-as-you-go checkout — store the customer id so future portal
        // sessions work. The actual ai_billing_status flip happens in the
        // customer.subscription.created handler (fired immediately after).
        if (orgId && product === 'ai_pay_as_you_go') {
          await pool.query(
            `UPDATE organizations
                SET stripe_customer_id = COALESCE(stripe_customer_id, $1),
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = $2`,
            [session.customer || null, orgId]
          );
          audit.record({
            event: audit.EVENTS.BILLING_AI_ACTIVATED,
            orgId,
            meta: { sessionId: session.id, customer: session.customer, source: 'checkout.session.completed' },
          }).catch(() => {});
          adminNotify.send({
            event: 'signup',
            subject: `[The Open CRM] Org ${orgId} started AI Pay-as-you-go`,
            html: `<p>Organization ${orgId} just completed Stripe checkout for the AI Pay-as-you-go plan.</p>`,
            text: `Org ${orgId} started AI Pay-as-you-go`,
            throttleKey: `billing_ai_started:${orgId}`,
          }).catch(() => {});
          break;
        }

        if (orgId && (tier === 'starter' || tier === 'pro')) {
          // limits_tier tracks the purchased tier so the seat/record caps
          // (services/tierLimits.js) lift the moment the plan is bought.
          await pool.query(
            `UPDATE organizations
                SET tier = $1,
                    limits_tier = $1,
                    stripe_customer_id = $2,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = $3`,
            [tier, session.customer || null, orgId]
          );
          audit.record({
            event: 'billing.tier_upgraded',
            actorUserId: null,
            orgId,
            meta: { tier, stripeSessionId: session.id, customer: session.customer },
          }).catch(() => {});
          adminNotify.send({
            event: 'signup',  // reuse channel until a dedicated event lands
            subject: `[The Open CRM] Org ${orgId} upgraded to ${tier}`,
            html: `<p>Organization ${orgId} just completed Stripe checkout for the <b>${tier}</b> plan.</p>`,
            text: `Org ${orgId} upgraded to ${tier}`,
            throttleKey: `billing_upgrade:${orgId}:${tier}`,
          }).catch(() => {});
        } else {
          logger.warn('stripe_webhook_unknown_session_metadata', { metadata: session.metadata });
        }
        break;
      }

      case 'customer.subscription.created': {
        const sub = event.data.object;
        // AI Pay-as-you-go subscription? Match by the line item's price id.
        if (isAiUsageSubscription(sub)) {
          const orgId = Number(sub.metadata?.org_id);
          if (orgId) {
            await pool.query(
              `UPDATE organizations
                  SET ai_billing_status = 'active',
                      ai_billing_subscription_id = $1,
                      stripe_customer_id = COALESCE(stripe_customer_id, $2),
                      updated_at = CURRENT_TIMESTAMP
                WHERE id = $3`,
              [sub.id, sub.customer || null, orgId]
            );
            requireAiBilling.bustCache(orgId);
            audit.record({
              event: audit.EVENTS.BILLING_AI_ACTIVATED,
              orgId,
              meta: { subscriptionId: sub.id, priceId: sub.items?.data?.[0]?.price?.id },
            }).catch(() => {});
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        // AI subscription update — flip status based on Stripe's state.
        if (isAiUsageSubscription(sub)) {
          const orgId = await resolveOrgIdForAiSub(sub);
          if (orgId) {
            let nextStatus = null;
            if (sub.status === 'active' || sub.status === 'trialing') nextStatus = 'active';
            else if (sub.status === 'past_due' || sub.status === 'unpaid') nextStatus = 'past_due';
            else if (sub.status === 'incomplete_expired' || sub.status === 'canceled') nextStatus = 'unconfigured';
            if (nextStatus) {
              await pool.query(
                `UPDATE organizations
                    SET ai_billing_status = $1,
                        ai_billing_subscription_id = CASE WHEN $1 = 'unconfigured' THEN NULL ELSE $2 END,
                        updated_at = CURRENT_TIMESTAMP
                  WHERE id = $3`,
                [nextStatus, sub.id, orgId]
              );
              requireAiBilling.bustCache(orgId);
              const evtMap = {
                active:       audit.EVENTS.BILLING_AI_ACTIVATED,
                past_due:     audit.EVENTS.BILLING_AI_PAST_DUE,
                unconfigured: audit.EVENTS.BILLING_AI_CANCELLED,
              };
              audit.record({
                event: evtMap[nextStatus],
                orgId,
                meta: { subscriptionId: sub.id, stripeStatus: sub.status },
              }).catch(() => {});
            }
          }
        }

        // Subscription plan changes (Starter → Pro, etc.). Stripe sends the
        // new price; we reverse-lookup the tier from STRIPE_PRICE_* env vars.
        // Scope to the org that owns THIS subscription (metadata.org_id,
        // stamped at checkout) — several orgs can legitimately share a
        // stripe_customer_id and must not all be re-tiered by one org's plan
        // change. The customer-wide fallback only covers legacy subs created
        // before subscription metadata was stamped.
        const newPriceId = sub.items?.data?.[0]?.price?.id;
        const tier = priceIdToTier(newPriceId);
        if (tier && sub.customer) {
          const metaOrgId = Number(sub.metadata?.org_id) || null;
          const r = metaOrgId
            ? await pool.query(
                `UPDATE organizations SET tier = $1, limits_tier = $1, updated_at = CURRENT_TIMESTAMP
                  WHERE id = $2 RETURNING id`,
                [tier, metaOrgId]
              )
            : await pool.query(
                `UPDATE organizations SET tier = $1, limits_tier = $1, updated_at = CURRENT_TIMESTAMP
                  WHERE stripe_customer_id = $2 RETURNING id`,
                [tier, sub.customer]
              );
          for (const row of r.rows) {
            audit.record({ event: 'billing.tier_changed', orgId: row.id, meta: { tier, subscriptionId: sub.id } }).catch(() => {});
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        // AI subscription cancel → unconfigured. Cancelling the AI
        // pay-as-you-go sub must NOT touch the org's paid tier, so handle it
        // here and stop before the tier-reset below.
        if (isAiUsageSubscription(sub)) {
          const orgId = await resolveOrgIdForAiSub(sub);
          if (orgId) {
            await pool.query(
              `UPDATE organizations
                  SET ai_billing_status = 'unconfigured',
                      ai_billing_subscription_id = NULL,
                      updated_at = CURRENT_TIMESTAMP
                WHERE id = $1`,
              [orgId]
            );
            requireAiBilling.bustCache(orgId);
            audit.record({
              event: audit.EVENTS.BILLING_AI_CANCELLED,
              orgId,
              meta: { subscriptionId: sub.id },
            }).catch(() => {});
          }
          break;
        }
        // Only reset tier when the cancelled subscription actually maps to a
        // paid tier price. Otherwise an unrelated sub cancel would wrongly
        // downgrade a paid org. Scope the downgrade to the org whose
        // subscription actually changed: prefer the org_id stamped in the
        // subscription metadata at checkout; for legacy subs without it,
        // fall back to the customer id but additionally match the cancelled
        // tier — a shared stripe_customer_id must NOT downgrade every org
        // attached to that customer.
        const cancelledPriceId = sub.items?.data?.[0]?.price?.id;
        const cancelledTier = priceIdToTier(cancelledPriceId);
        if (cancelledTier && sub.customer) {
          const metaOrgId = Number(sub.metadata?.org_id) || null;
          const r = metaOrgId
            ? await pool.query(
                `UPDATE organizations SET tier = 'free', limits_tier = 'free', updated_at = CURRENT_TIMESTAMP
                  WHERE id = $1 RETURNING id`,
                [metaOrgId]
              )
            : await pool.query(
                `UPDATE organizations SET tier = 'free', limits_tier = 'free', updated_at = CURRENT_TIMESTAMP
                  WHERE stripe_customer_id = $1 AND tier = $2 RETURNING id`,
                [sub.customer, cancelledTier]
              );
          for (const row of r.rows) {
            audit.record({ event: 'billing.subscription_cancelled', orgId: row.id, meta: { subscriptionId: sub.id, priorTier: cancelledTier } }).catch(() => {});
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object;
        adminNotify.send({
          event: 'signup',
          subject: `[The Open CRM] Stripe payment failed for customer ${inv.customer}`,
          html: `<p>Stripe invoice <code>${inv.id}</code> failed for customer <code>${inv.customer}</code> (amount ${inv.amount_due} ${inv.currency}).</p>
                 <p>Stripe will retry per your dunning settings; check the Stripe dashboard for the org's contact details.</p>`,
          text: `Stripe payment failed for ${inv.customer}, invoice ${inv.id}`,
          throttleKey: `payment_failed:${inv.customer}:${inv.id}`,
        }).catch(() => {});
        break;
      }

      default:
        // Stripe sends many event types; we only care about a subset. Log
        // and acknowledge so Stripe doesn't retry.
        logger.info('stripe_webhook_unhandled', { type: event.type });
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('stripe_webhook_handler_failed', { eventType: event?.type, error: err.message });
    // Return 500 so Stripe retries — better to over-deliver than to silently drop.
    res.status(500).json({ error: 'Webhook handler error' });
  }
});

// Resolve an org's monthly AI threshold, honouring an explicitly-configured 0
// (which `x || 50` would incorrectly turn back into the 50 default). Only a
// NULL/undefined/unparseable stored value falls back to the default.
const DEFAULT_AI_THRESHOLD_USD = 50;
function resolveThresholdUsd(stored) {
  if (stored === null || stored === undefined) return DEFAULT_AI_THRESHOLD_USD;
  const n = Number(stored);
  return Number.isFinite(n) ? n : DEFAULT_AI_THRESHOLD_USD;
}

function priceIdToTier(priceId) {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_STARTER) return 'starter';
  if (priceId === process.env.STRIPE_PRICE_PRO)     return 'pro';
  return null;
}

// Detect a Stripe subscription that maps to AI Pay-as-you-go. We accept
// either an env-matching price id OR explicit metadata.product, so an
// operator-created subscription (without going through our checkout) still
// gets recognized.
function isAiUsageSubscription(sub) {
  if (!sub) return false;
  if (String(sub.metadata?.product || '').toLowerCase() === 'ai_pay_as_you_go') return true;
  const priceId = sub.items?.data?.[0]?.price?.id;
  if (priceId && process.env.STRIPE_PRICE_AI_USAGE && priceId === process.env.STRIPE_PRICE_AI_USAGE) return true;
  return false;
}

// Find which org owns a given AI sub. Metadata is the cheap path; falling
// back to a customer-id lookup covers legacy subs without metadata.
async function resolveOrgIdForAiSub(sub) {
  const fromMeta = Number(sub.metadata?.org_id);
  if (fromMeta) return fromMeta;
  if (sub.customer) {
    const r = await pool.query(
      `SELECT id FROM organizations WHERE stripe_customer_id = $1 LIMIT 1`,
      [sub.customer]
    );
    if (r.rows[0]?.id) return r.rows[0].id;
  }
  return null;
}

// --------------------------------------------------------------------------
// Authed routes — mounted AFTER express.json() upstream so these get JSON
// bodies. Webhook above gets raw bytes.
// --------------------------------------------------------------------------
router.use(authMiddleware);

router.get('/status', async (req, res) => {
  try {
    if (!req.orgId) return res.json({ success: true, tier: 'free', configured: stripeService.isConfigured() });
    const r = await pool.query(
      `SELECT tier, stripe_customer_id FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    res.json({
      success: true,
      configured: stripeService.isConfigured(),
      tier: r.rows[0]?.tier || 'free',
      hasStripeCustomer: !!r.rows[0]?.stripe_customer_id,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch billing status' });
  }
});

router.post('/checkout', async (req, res) => {
  if (!stripeService.isConfigured()) {
    return res.status(503).json({
      success: false,
      error: 'Billing is not yet enabled on this deployment',
      code: 'STRIPE_NOT_CONFIGURED',
    });
  }
  const { tier } = req.body || {};
  if (tier !== 'starter' && tier !== 'pro') {
    return res.status(400).json({ success: false, error: 'tier must be "starter" or "pro"' });
  }
  if (!req.orgId) return res.status(400).json({ success: false, error: 'Org context required' });
  if (!(await canManageOrgBilling(req))) {
    return res.status(403).json({ success: false, error: 'Only a workspace owner or admin can manage billing', code: 'ADMIN_REQUIRED' });
  }

  try {
    // Get the user's email for prefilling.
    const u = await pool.query(`SELECT email FROM users WHERE id = $1`, [req.userId]);
    const session = await stripeService.createCheckoutSession({
      tier,
      customerEmail: u.rows[0]?.email || undefined,
      successUrl: `https://app.theopencrm.com/usage?upgraded=${tier}`,
      cancelUrl:  `https://app.theopencrm.com/usage?upgrade_cancelled=1`,
      metadata: { org_id: String(req.orgId), user_id: String(req.userId), tier },
    });
    audit.fromReq(req, { event: 'billing.checkout_started', meta: { tier, sessionId: session.id } });
    res.json({ success: true, ...session });
  } catch (err) {
    if (req.log) req.log.error('billing_checkout_failed', { error: err });
    res.status(err.statusCode || 500).json({
      success: false,
      error: err.message || 'Failed to start checkout',
      code: err.code || undefined,
    });
  }
});

router.post('/portal', async (req, res) => {
  if (!stripeService.isConfigured()) {
    return res.status(503).json({ success: false, error: 'Billing not configured', code: 'STRIPE_NOT_CONFIGURED' });
  }
  if (!req.orgId) return res.status(400).json({ success: false, error: 'Org context required' });
  if (!(await canManageOrgBilling(req))) {
    return res.status(403).json({ success: false, error: 'Only a workspace owner or admin can manage billing', code: 'ADMIN_REQUIRED' });
  }
  try {
    const r = await pool.query(`SELECT stripe_customer_id FROM organizations WHERE id = $1`, [req.orgId]);
    const customerId = r.rows[0]?.stripe_customer_id;
    if (!customerId) {
      return res.status(400).json({
        success: false,
        error: 'No Stripe customer associated with this org yet. Complete an upgrade first.',
        code: 'NO_STRIPE_CUSTOMER',
      });
    }
    const session = await stripeService.createPortalSession({ stripeCustomerId: customerId });
    res.json({ success: true, url: session.url });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message, code: err.code || undefined });
  }
});

// ============================================================================
// AI Pay-as-you-go endpoints — /api/billing/ai/*
// ============================================================================
//
// Owner intent (verbatim, see PR body):
//   "Here is the product Key for Anthropic pay as you use it in Stripe.
//    Make sure that each person using it can start billing, and then block
//    them to go and pay as you go. Track usage and approach for each million
//    topks so that if someone passes ~$50/month then I get a warning and the
//    ability to halt them in the admin panel before they go off the rails.
//    prod_Uj9hvCriplpPrA"
//
// The metered price id (STRIPE_PRICE_AI_USAGE) is owner-provided per env.
// $50/month threshold is warn-only; manual halt only. See the
// services/aiThresholdWorker.js file for the notifier.

// Helper to compute month-to-date usage in dollars for an org.
async function getMtdUsageUsd(orgId) {
  if (!orgId) return { mtd_usage_usd: 0, mtd_calls: 0, mtd_tokens: 0 };
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const summary = await aiMetering.summarizeUsage({ orgId, from, to });
  return {
    mtd_usage_usd: Number(summary.total_charged_usd || 0),
    mtd_calls:     Number(summary.total_calls || 0),
    mtd_tokens:    Number(summary.total_input_tokens || 0) + Number(summary.total_output_tokens || 0),
  };
}

router.get('/ai/status', async (req, res) => {
  try {
    if (!req.orgId) {
      return res.json({
        success: true,
        status: 'unconfigured',
        configured: !!process.env.STRIPE_PRICE_AI_USAGE,
        stripeConfigured: stripeService.isConfigured(),
      });
    }
    const r = await pool.query(
      `SELECT ai_billing_status, ai_billing_subscription_id, ai_billing_trial_ends_at,
              ai_monthly_threshold_usd, ai_threshold_last_warned_period,
              ai_monthly_hard_cap_usd,
              ai_halted_at, ai_halted_reason, stripe_customer_id, updated_at
         FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    const row = r.rows[0] || {};
    const mtd = await getMtdUsageUsd(req.orgId);
    const threshold = resolveThresholdUsd(row.ai_monthly_threshold_usd);
    const thresholdPct = threshold > 0 ? Math.min(100, Math.round((mtd.mtd_usage_usd / threshold) * 100)) : 0;
    const storedCap = Number(row.ai_monthly_hard_cap_usd);
    const hardCap = Number.isFinite(storedCap) ? storedCap : aiThresholdWorker.DEFAULT_HARD_CAP_USD;
    res.json({
      success: true,
      status: row.ai_billing_status || 'unconfigured',
      subscription_id: row.ai_billing_subscription_id || null,
      trial_ends_at: row.ai_billing_trial_ends_at || null,
      threshold_usd: threshold,
      hard_cap_usd: hardCap,
      hard_cap_is_default: !Number.isFinite(storedCap),
      mtd_usage_usd: mtd.mtd_usage_usd,
      mtd_calls: mtd.mtd_calls,
      mtd_tokens: mtd.mtd_tokens,
      threshold_pct: thresholdPct,
      last_warning_period: row.ai_threshold_last_warned_period || null,
      halted_at: row.ai_halted_at || null,
      halted_reason: row.ai_halted_reason || null,
      has_stripe_customer: !!row.stripe_customer_id,
      configured: !!process.env.STRIPE_PRICE_AI_USAGE,
      stripeConfigured: stripeService.isConfigured(),
    });
  } catch (err) {
    if (req.log) req.log.error('billing_ai_status_failed', { error: err });
    res.status(500).json({ success: false, error: err.message || 'Failed to fetch AI billing status' });
  }
});

router.post('/ai/start', async (req, res) => {
  if (!stripeService.isConfigured()) {
    return res.status(503).json({
      success: false,
      error: 'Billing is not yet enabled on this deployment',
      code: 'STRIPE_NOT_CONFIGURED',
    });
  }
  if (!process.env.STRIPE_PRICE_AI_USAGE) {
    return res.status(503).json({
      success: false,
      error: 'STRIPE_PRICE_AI_USAGE is not set. Ask the operator to add the metered price id from the Stripe dashboard.',
      code: 'STRIPE_PRICE_AI_USAGE_MISSING',
    });
  }
  if (!req.orgId) return res.status(400).json({ success: false, error: 'Org context required' });
  if (!(await canManageOrgBilling(req))) {
    return res.status(403).json({ success: false, error: 'Only a workspace owner or admin can start the AI plan', code: 'ADMIN_REQUIRED' });
  }

  // Where to land after Stripe. Default is Chat: the whole point of the plan
  // is the copilot, so the user should come back to the composer, not a
  // usage ledger. Usage keeps its own return so its button still round-trips.
  const returnTo = req.body?.return_to === 'usage' ? '/usage' : '/chat';
  const base = frontendBaseUrl();

  try {
    const u = await pool.query(`SELECT email FROM users WHERE id = $1`, [req.userId]);
    const session = await stripeService.createUsageCheckoutSession({
      customerEmail: u.rows[0]?.email || undefined,
      successUrl: `${base}${returnTo}?ai_subscribed=1`,
      cancelUrl:  `${base}${returnTo}?ai_subscribe_cancelled=1`,
      metadata: { org_id: String(req.orgId), user_id: String(req.userId) },
    });
    audit.fromReq(req, {
      event: audit.EVENTS.BILLING_AI_CHECKOUT_STARTED,
      meta: { sessionId: session.id },
    });
    res.json({ success: true, ...session });
  } catch (err) {
    if (req.log) req.log.error('billing_ai_start_failed', { error: err });
    res.status(err.statusCode || 500).json({
      success: false,
      error: err.message || 'Failed to start AI checkout',
      code: err.code || undefined,
    });
  }
});

router.post('/ai/halt', async (req, res) => {
  if (!req.orgId) return res.status(400).json({ success: false, error: 'Org context required' });
  if (!(await canManageOrgBilling(req))) {
    return res.status(403).json({ success: false, error: 'Admin role required to halt AI billing' });
  }
  const reason = typeof req.body?.reason === 'string'
    ? req.body.reason.slice(0, 64)
    : 'admin';
  try {
    const prior = await pool.query(
      `SELECT ai_billing_status FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    const priorStatus = prior.rows[0]?.ai_billing_status || 'unconfigured';
    await updateAiBillingStatus(req.orgId, {
      ai_billing_status: 'halted',
      ai_halted_at: new Date().toISOString(),
      ai_halted_by_user_id: req.userId,
      ai_halted_reason: reason,
    });
    audit.fromReq(req, {
      event: audit.EVENTS.BILLING_AI_HALTED,
      meta: { reason, prior_status: priorStatus },
    });
    res.json({ success: true, status: 'halted', reason });
  } catch (err) {
    if (req.log) req.log.error('billing_ai_halt_failed', { error: err });
    res.status(500).json({ success: false, error: err.message || 'Failed to halt AI billing' });
  }
});

router.post('/ai/resume', async (req, res) => {
  if (!req.orgId) return res.status(400).json({ success: false, error: 'Org context required' });
  if (!(await canManageOrgBilling(req))) {
    return res.status(403).json({ success: false, error: 'Admin role required to resume AI billing' });
  }
  try {
    const r = await pool.query(
      `SELECT ai_billing_subscription_id FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    const subId = r.rows[0]?.ai_billing_subscription_id;
    // If a Stripe subscription is still recorded we assume it's still valid
    // (the webhook would have flipped us off otherwise) and restore to active.
    // Otherwise drop back to unconfigured so the user is prompted to start.
    const nextStatus = subId ? 'active' : 'unconfigured';
    await updateAiBillingStatus(req.orgId, {
      ai_billing_status: nextStatus,
      ai_halted_at: null,
      ai_halted_by_user_id: null,
      ai_halted_reason: null,
    });
    audit.fromReq(req, {
      event: audit.EVENTS.BILLING_AI_RESUMED,
      meta: { restored_status: nextStatus },
    });
    res.json({ success: true, status: nextStatus });
  } catch (err) {
    if (req.log) req.log.error('billing_ai_resume_failed', { error: err });
    res.status(500).json({ success: false, error: err.message || 'Failed to resume AI billing' });
  }
});

router.post('/ai/comp', async (req, res) => {
  // Super-admin only.
  if (!req.userId || !(await isSuperAdmin(req.userId))) {
    return res.status(403).json({ success: false, error: 'Super-admin role required' });
  }
  const orgId = Number(req.body?.org_id);
  if (!orgId || !Number.isFinite(orgId)) {
    return res.status(400).json({ success: false, error: 'org_id is required' });
  }
  try {
    const r = await pool.query(`SELECT id FROM organizations WHERE id = $1`, [orgId]);
    if (r.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Org not found' });
    }
    await updateAiBillingStatus(orgId, {
      ai_billing_status: 'comped',
      ai_halted_at: null,
      ai_halted_by_user_id: null,
      ai_halted_reason: null,
    });
    audit.fromReq(req, {
      event: audit.EVENTS.BILLING_AI_COMPED,
      meta: { target_org_id: orgId },
    });
    res.json({ success: true, status: 'comped', org_id: orgId });
  } catch (err) {
    if (req.log) req.log.error('billing_ai_comp_failed', { error: err });
    res.status(500).json({ success: false, error: err.message || 'Failed to comp org' });
  }
});

router.post('/ai/start-trial', async (req, res) => {
  // Super-admin only.
  if (!req.userId || !(await isSuperAdmin(req.userId))) {
    return res.status(403).json({ success: false, error: 'Super-admin role required' });
  }
  const orgId = Number(req.body?.org_id);
  const days = Math.max(1, Math.min(90, Number(req.body?.days) || 14));
  if (!orgId || !Number.isFinite(orgId)) {
    return res.status(400).json({ success: false, error: 'org_id is required' });
  }
  try {
    const r = await pool.query(`SELECT id FROM organizations WHERE id = $1`, [orgId]);
    if (r.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Org not found' });
    }
    const trialEndsAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    await updateAiBillingStatus(orgId, {
      ai_billing_status: 'trial',
      ai_billing_trial_ends_at: trialEndsAt.toISOString(),
      ai_halted_at: null,
      ai_halted_by_user_id: null,
      ai_halted_reason: null,
    });
    audit.fromReq(req, {
      event: audit.EVENTS.BILLING_AI_TRIAL_STARTED,
      meta: { target_org_id: orgId, days, trial_ends_at: trialEndsAt.toISOString() },
    });
    res.json({ success: true, status: 'trial', trial_ends_at: trialEndsAt.toISOString(), days });
  } catch (err) {
    if (req.log) req.log.error('billing_ai_start_trial_failed', { error: err });
    res.status(500).json({ success: false, error: err.message || 'Failed to start trial' });
  }
});

// PATCH /ai/threshold — change the monthly warn threshold and/or the hard
// cap (migration 162: auto-halt ceiling; NULL = $200 default) for the
// caller's org. Admins only. Resets ai_threshold_last_warned_period so a
// raised threshold can re-warn in the same month if usage crosses the new
// ceiling.
router.patch('/ai/threshold', async (req, res) => {
  if (!req.orgId) return res.status(400).json({ success: false, error: 'Org context required' });
  if (!(await canManageOrgBilling(req))) {
    return res.status(403).json({ success: false, error: 'Admin role required' });
  }
  const patch = {};
  if (req.body?.threshold_usd !== undefined) {
    const next = Number(req.body.threshold_usd);
    if (!Number.isFinite(next) || next < 0 || next > 100000) {
      return res.status(400).json({ success: false, error: 'threshold_usd must be a number between 0 and 100000' });
    }
    patch.ai_monthly_threshold_usd = next;
    patch.ai_threshold_last_warned_period = null;
  }
  if (req.body?.hard_cap_usd !== undefined) {
    // null resets to the code default ($200).
    if (req.body.hard_cap_usd === null) {
      patch.ai_monthly_hard_cap_usd = null;
    } else {
      const cap = Number(req.body.hard_cap_usd);
      if (!Number.isFinite(cap) || cap < 0 || cap > 100000) {
        return res.status(400).json({ success: false, error: 'hard_cap_usd must be a number between 0 and 100000, or null for the default' });
      }
      patch.ai_monthly_hard_cap_usd = cap;
    }
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ success: false, error: 'Provide threshold_usd and/or hard_cap_usd' });
  }
  try {
    await updateAiBillingStatus(req.orgId, patch);
    res.json({
      success: true,
      ...(patch.ai_monthly_threshold_usd !== undefined ? { threshold_usd: patch.ai_monthly_threshold_usd } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'ai_monthly_hard_cap_usd') ? { hard_cap_usd: patch.ai_monthly_hard_cap_usd } : {}),
    });
  } catch (err) {
    if (req.log) req.log.error('billing_ai_threshold_patch_failed', { error: err });
    res.status(500).json({ success: false, error: err.message || 'Failed to update threshold' });
  }
});

// GET /ai/admin/list — super-admin only. Returns every org's billing snapshot
// for the /admin/ai-billing page. Org admins should call /ai/status instead.
router.get('/ai/admin/list', async (req, res) => {
  if (!req.userId || !(await isSuperAdmin(req.userId))) {
    return res.status(403).json({ success: false, error: 'Super-admin role required' });
  }
  try {
    const orgs = await pool.query(
      `SELECT id, name, ai_billing_status, ai_billing_subscription_id,
              ai_billing_trial_ends_at, ai_monthly_threshold_usd,
              ai_monthly_hard_cap_usd,
              ai_threshold_last_warned_period, ai_halted_at, ai_halted_reason,
              stripe_customer_id
         FROM organizations
        ORDER BY id ASC`
    );
    const rows = [];
    for (const r of orgs.rows) {
      // eslint-disable-next-line no-await-in-loop
      const mtd = await getMtdUsageUsd(r.id);
      const threshold = resolveThresholdUsd(r.ai_monthly_threshold_usd);
      rows.push({
        id: r.id,
        name: r.name,
        status: r.ai_billing_status,
        subscription_id: r.ai_billing_subscription_id,
        trial_ends_at: r.ai_billing_trial_ends_at,
        threshold_usd: threshold,
        hard_cap_usd: Number.isFinite(Number(r.ai_monthly_hard_cap_usd))
          ? Number(r.ai_monthly_hard_cap_usd)
          : aiThresholdWorker.DEFAULT_HARD_CAP_USD,
        last_warning_period: r.ai_threshold_last_warned_period,
        halted_at: r.ai_halted_at,
        halted_reason: r.ai_halted_reason,
        mtd_usage_usd: mtd.mtd_usage_usd,
        mtd_calls: mtd.mtd_calls,
        mtd_tokens: mtd.mtd_tokens,
        threshold_pct: threshold > 0 ? Math.min(100, Math.round((mtd.mtd_usage_usd / threshold) * 100)) : 0,
        has_stripe_customer: !!r.stripe_customer_id,
      });
    }
    res.json({ success: true, configured: !!process.env.STRIPE_PRICE_AI_USAGE, orgs: rows });
  } catch (err) {
    if (req.log) req.log.error('billing_ai_admin_list_failed', { error: err });
    res.status(500).json({ success: false, error: err.message || 'Failed to list AI billing' });
  }
});

module.exports = router;
