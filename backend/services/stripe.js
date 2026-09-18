// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Stripe integration scaffold.
//
// STATUS: structurally complete; awaiting real Stripe account configuration.
// Returns 503 with code STRIPE_NOT_CONFIGURED when STRIPE_SECRET_KEY is
// unset, so endpoints can be safely mounted before the keys are wired.
//
// REQUIRED ENV VARS (set when you have a Stripe account):
//   STRIPE_SECRET_KEY        — sk_live_... or sk_test_...
//   STRIPE_WEBHOOK_SECRET    — whsec_... (from the Stripe dashboard Webhooks
//                              page; used to verify webhook signatures)
//   STRIPE_PRICE_STARTER     — price_... for the $15 Starter tier
//   STRIPE_PRICE_PRO         — price_... for the $39 Professional tier
//   STRIPE_PRICE_AI_USAGE    — price_... (metered) for the AI Pay-as-you-go
//                              product (Stripe product id prod_Uj9hvCriplpPrA).
//                              Owner-provided product; price id is created by
//                              the owner in the Stripe dashboard and pasted in.
//   STRIPE_PORTAL_RETURN_URL — where to return after Stripe Customer Portal
//                              (default: https://app.theopencrm.com/usage)
//
// Tiers are managed in PLUGIN_PLATFORM_VISION.md §2.2; the price IDs above
// map to those tier products in your Stripe account.

const logger = require('./logger');

const SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

let cachedStripe = null;

function getStripe() {
  if (cachedStripe) return cachedStripe;
  if (!SECRET_KEY) return null;
  try {
    const Stripe = require('stripe');
    cachedStripe = new Stripe(SECRET_KEY, { apiVersion: '2024-12-18.acacia' });
    return cachedStripe;
  } catch (err) {
    logger.warn('stripe_client_init_failed', { error: err.message });
    return null;
  }
}

function isConfigured() {
  return !!SECRET_KEY;
}

/**
 * Create a Stripe Checkout session for a tier upgrade. Returns the session
 * URL the frontend redirects the user to.
 *
 * @param {object} opts
 * @param {string} opts.tier - 'starter' | 'pro'
 * @param {string} opts.customerEmail
 * @param {string} opts.successUrl - return URL after successful checkout
 * @param {string} opts.cancelUrl - return URL if the customer cancels
 * @param {object} opts.metadata - org_id + user_id for webhook reconciliation
 */
async function createCheckoutSession({ tier, customerEmail, successUrl, cancelUrl, metadata }) {
  const stripe = getStripe();
  if (!stripe) {
    const e = new Error('Stripe is not configured on this server');
    e.code = 'STRIPE_NOT_CONFIGURED';
    e.statusCode = 503;
    throw e;
  }
  const priceId = {
    starter: process.env.STRIPE_PRICE_STARTER,
    pro:     process.env.STRIPE_PRICE_PRO,
  }[tier];
  if (!priceId) {
    const e = new Error(`No Stripe price configured for tier "${tier}"`);
    e.code = 'TIER_PRICE_MISSING';
    e.statusCode = 400;
    throw e;
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer_email: customerEmail,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: metadata || {},
    // Stamp the subscription itself with the same metadata (org_id / tier)
    // so subscription.updated/.deleted webhooks can scope tier changes to
    // the owning org even when several orgs share a stripe_customer_id.
    subscription_data: {
      metadata: metadata || {},
    },
    allow_promotion_codes: true,
    automatic_tax: { enabled: false },
  });
  return { id: session.id, url: session.url };
}

/**
 * Create a Stripe Checkout session for the AI Pay-as-you-go (metered)
 * subscription. Returns the session URL the frontend redirects the user to.
 *
 * The metered price (STRIPE_PRICE_AI_USAGE) MUST NOT carry a quantity at
 * checkout — Stripe rejects it. Quantity comes later via meter events posted
 * by services/aiBilling.js once per billing period.
 *
 * @param {object} opts
 * @param {string} opts.customerEmail
 * @param {string} opts.successUrl
 * @param {string} opts.cancelUrl
 * @param {object} opts.metadata - org_id + user_id for webhook reconciliation
 */
async function createUsageCheckoutSession({ customerEmail, successUrl, cancelUrl, metadata }) {
  const stripe = getStripe();
  if (!stripe) {
    const e = new Error('Stripe is not configured on this server');
    e.code = 'STRIPE_NOT_CONFIGURED';
    e.statusCode = 503;
    throw e;
  }
  const priceId = process.env.STRIPE_PRICE_AI_USAGE;
  if (!priceId) {
    const e = new Error(
      'STRIPE_PRICE_AI_USAGE is not set. Create a metered price under product ' +
      'prod_Uj9hvCriplpPrA in the Stripe dashboard and add the price id to the env.'
    );
    e.code = 'STRIPE_PRICE_AI_USAGE_MISSING';
    e.statusCode = 503;
    throw e;
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer_email: customerEmail,
    // Metered prices forbid `quantity` at checkout — the meter posts handle
    // the running tally. Just reference the price.
    line_items: [{ price: priceId }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { ...(metadata || {}), product: 'ai_pay_as_you_go' },
    // Tag the subscription itself with the same metadata so the webhook can
    // reconcile by sub.metadata even if the session is gone by retry time.
    subscription_data: {
      metadata: { ...(metadata || {}), product: 'ai_pay_as_you_go' },
    },
    allow_promotion_codes: true,
    automatic_tax: { enabled: false },
  });
  return { id: session.id, url: session.url };
}

/**
 * Create a Stripe Customer Portal session — the hosted page where the
 * customer can change plan, update card, see invoices. Requires the
 * customer to have a stripe_customer_id (set by a prior checkout).
 */
async function createPortalSession({ stripeCustomerId, returnUrl }) {
  const stripe = getStripe();
  if (!stripe) {
    const e = new Error('Stripe is not configured on this server');
    e.code = 'STRIPE_NOT_CONFIGURED';
    e.statusCode = 503;
    throw e;
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl || process.env.STRIPE_PORTAL_RETURN_URL || 'https://app.theopencrm.com/usage',
  });
  return { url: session.url };
}

/**
 * Verify and parse a Stripe webhook payload. Returns the event object;
 * throws if the signature doesn't verify.
 *
 * @param {Buffer} rawBody - raw request body (NOT JSON-parsed). Express
 *                            json middleware breaks this; the webhook
 *                            route uses express.raw().
 * @param {string} signatureHeader - `stripe-signature` header value
 */
function verifyWebhook(rawBody, signatureHeader) {
  const stripe = getStripe();
  if (!stripe) {
    const e = new Error('Stripe is not configured on this server');
    e.code = 'STRIPE_NOT_CONFIGURED';
    e.statusCode = 503;
    throw e;
  }
  if (!WEBHOOK_SECRET) {
    const e = new Error('STRIPE_WEBHOOK_SECRET is not set');
    e.code = 'STRIPE_WEBHOOK_SECRET_MISSING';
    e.statusCode = 503;
    throw e;
  }
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, WEBHOOK_SECRET);
}

module.exports = {
  isConfigured,
  createCheckoutSession,
  createUsageCheckoutSession,
  createPortalSession,
  verifyWebhook,
};
