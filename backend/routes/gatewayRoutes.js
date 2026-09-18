// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// AI Gateway proxy — POST /api/gateway/v1/messages (spec 202, v1).
//
// A self-hosted Open CRM instance without its own Anthropic key sends its AI
// calls here, authenticated by an ocrm_gw_* gateway key minted from a hosted
// org's /settings#billing page. We enforce the org's billing verdict, call
// Anthropic with the PLATFORM key, meter the usage to the org exactly like a
// hosted AI call (ai_usage_events endpoint='gateway', billing_mode='platform',
// cost × upcharge), and return the upstream Messages API JSON unchanged plus
// an X-OpenCRM-Charged-USD header.
//
// SECURITY / SHAPE RAILS (v1 keeps the proxy surface deliberately small):
//   • No session auth, CSRF-exempt (see isCsrfExempt in index.js) — the
//     gateway key IS the credential, hashed-at-rest with a 30s lookup cache.
//   • Per-key rate limit 60/min (falls back to per-IP pre-auth).
//   • 1 MB body cap (413).
//   • Model allowlist = services/aiModel.js VALID_MODELS (400 otherwise).
//   • max_tokens ceiling 8192 (400 above it).
//   • Streaming and tool-use are rejected with clear 400s (v2 scope).
//   • Billing verdict (middleware/requireAiBilling.evaluateAiBilling) runs
//     BEFORE the upstream call — past_due grace / halted / hard-cap behave
//     identically to hosted AI, and a deny is a 402 with the verdict's
//     code/message.
//   • PRIVACY: prompt/completion bodies are NEVER logged — log lines carry
//     model / org / status / token counts only, same posture as services/ai.js.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const gatewayKeys = require('../services/gatewayKeys');
// Called through the module objects (not destructured) so tests can stub them.
const requireAiBilling = require('../middleware/requireAiBilling');
const aiMetering = require('../services/aiMetering');
const usageMeter = require('../services/usageMeter');
const aiModel = require('../services/aiModel');
const logger = require('../services/logger');

const router = express.Router();

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
const MAX_TOKENS_CEILING = 8192;

// Per-key rate limit: 60 requests/minute. Keyed on a hash of the presented
// token (pre-lookup, so an invalid key burns its own bucket, not a victim's),
// falling back to per-IP for requests with no candidate key at all.
const gatewayLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const token = gatewayKeys.extractKeyFromRequest(req);
    if (token) return `gwkey:${gatewayKeys.sha256Hex(token).slice(0, 32)}`;
    return `ip:${ipKeyGenerator(req, res)}`;
  },
  message: {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'Gateway rate limit exceeded (60 requests/minute per key). Slow down.' },
  },
});

// Anthropic-dialect error payload so the calling SDK/client surfaces a
// sensible message. `code` is our machine-readable extra.
function apiError(res, status, type, message, extra = {}) {
  return res.status(status).json({
    type: 'error',
    error: { type, message },
    ...extra,
  });
}

// v1 accepts plain (non-tool) messages: content is a string, or an array of
// text-type blocks only. tool_use / tool_result blocks are v2 scope.
function findNonTextBlock(messages) {
  for (const m of messages) {
    if (!m || typeof m !== 'object') return 'malformed message';
    if (typeof m.content === 'string') continue;
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block || typeof block !== 'object' || block.type !== 'text') {
          return `content block type "${block && block.type}"`;
        }
      }
      continue;
    }
    return 'malformed message content';
  }
  return null;
}

router.post('/v1/messages', gatewayLimiter, async (req, res) => {
  // ---- Auth: gateway key → org ------------------------------------------
  const token = gatewayKeys.extractKeyFromRequest(req);
  if (!token) {
    return apiError(res, 401, 'authentication_error',
      'Missing gateway key. Send "Authorization: Bearer ocrm_gw_..." (or x-api-key).');
  }
  let keyRow;
  try {
    keyRow = await gatewayKeys.findActiveByPlaintext(token);
  } catch (err) {
    logger.error('gateway_key_lookup_failed', { error: err.message });
    return apiError(res, 503, 'api_error', 'Gateway temporarily unavailable. Try again.');
  }
  if (!keyRow) {
    return apiError(res, 401, 'authentication_error', 'Invalid or revoked gateway key.');
  }
  const orgId = keyRow.org_id;

  // ---- Body rails --------------------------------------------------------
  const bodyBytes = req.rawBody ? req.rawBody.length : Buffer.byteLength(JSON.stringify(req.body || {}));
  if (bodyBytes > MAX_BODY_BYTES) {
    return apiError(res, 413, 'invalid_request_error', 'Request body exceeds the 1 MB gateway limit.');
  }
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return apiError(res, 400, 'invalid_request_error', 'Request body must be a JSON object in the Anthropic Messages API shape.');
  }
  if (body.stream) {
    return apiError(res, 400, 'invalid_request_error', 'Streaming is not supported by the gateway yet (v1 is non-streaming). Set stream: false.');
  }
  if (body.tools !== undefined || body.tool_choice !== undefined) {
    return apiError(res, 400, 'invalid_request_error', 'Tool use is not supported by the gateway yet (v1 is plain messages only). Remove tools/tool_choice.');
  }
  const allowedModels = aiModel.VALID_MODELS.map(m => m.id);
  if (typeof body.model !== 'string' || !allowedModels.includes(body.model)) {
    return apiError(res, 400, 'invalid_request_error',
      `Model must be one of: ${allowedModels.join(', ')}.`);
  }
  const maxTokens = body.max_tokens === undefined ? 1024 : Number(body.max_tokens);
  if (!Number.isFinite(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS_CEILING) {
    return apiError(res, 400, 'invalid_request_error',
      `max_tokens must be between 1 and ${MAX_TOKENS_CEILING} on the gateway.`);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return apiError(res, 400, 'invalid_request_error', 'messages must be a non-empty array.');
  }
  const nonText = findNonTextBlock(body.messages);
  if (nonText) {
    return apiError(res, 400, 'invalid_request_error',
      `Only plain text messages are supported by the gateway yet (v1): found ${nonText}.`);
  }

  // ---- Billing verdict BEFORE the upstream call --------------------------
  // Reuses the exact hosted-AI state machine (past_due grace, halted,
  // hard-cap auto-halt, trial expiry). No userId here: the key is the org's
  // credential, so there is no super-admin bypass on this surface.
  const verdict = await requireAiBilling.evaluateAiBilling({ orgId, log: req.log });
  if (!verdict.allowed) {
    return res.status(402).json({
      type: 'error',
      error: { type: 'billing_error', message: verdict.message },
      code: verdict.code,
      action: verdict.action,
      status: verdict.status,
    });
  }

  // ---- Platform key ------------------------------------------------------
  // Read at request time (not module load) so ops key rotation and tests
  // behave predictably. Graceful 503 when the platform itself has no key.
  const platformKey = process.env.ANTHROPIC_API_KEY;
  if (!platformKey) {
    return apiError(res, 503, 'api_error',
      'The platform AI service is not configured. Contact support@theopencrm.com.');
  }

  // Whitelisted passthrough — everything else is dropped so the proxy
  // surface stays small and predictable.
  const upstreamBody = {
    model: body.model,
    max_tokens: maxTokens,
    messages: body.messages,
  };
  if (body.system !== undefined) upstreamBody.system = body.system;
  if (body.temperature !== undefined) upstreamBody.temperature = body.temperature;
  if (body.top_p !== undefined) upstreamBody.top_p = body.top_p;
  if (body.top_k !== undefined) upstreamBody.top_k = body.top_k;
  if (body.stop_sequences !== undefined) upstreamBody.stop_sequences = body.stop_sequences;
  if (body.thinking !== undefined) upstreamBody.thinking = body.thinking;

  try {
    const upstream = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': platformKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(upstreamBody),
    });

    if (!upstream.ok) {
      // Failed calls still count as an attempted request for abuse tracking
      // (same as services/ai.js) but accrue no token cost. Never log the
      // upstream body — Anthropic error payloads can echo request content.
      logger.warn('gateway_upstream_error', { orgId, keyId: keyRow.id, model: body.model, status: upstream.status });
      usageMeter.increment(orgId, 'ai_requests', 1, 0).catch(() => {});
      gatewayKeys.touchUsage(keyRow.id);
      let errJson = null;
      try { errJson = await upstream.json(); } catch { /* non-JSON upstream error */ }
      return res.status(upstream.status).json(
        errJson || { type: 'error', error: { type: 'api_error', message: `Upstream error ${upstream.status}` } }
      );
    }

    const json = await upstream.json();

    // ---- Metering: identical to hosted (services/ai.js callClaude) -------
    let chargedUsd = 0;
    if (json.usage) {
      usageMeter.recordAiUsage(orgId, {
        inputTokens: json.usage.input_tokens || 0,
        outputTokens: json.usage.output_tokens || 0,
      }).catch(() => {});
      // Fire-and-forget: recordUsage swallows its own errors. user_id NULL —
      // the key, not a seat, made the call; the org carries the charge.
      aiMetering.recordUsage({
        orgId,
        endpoint: 'gateway',
        model: body.model,
        usage: json.usage,
        billingMode: 'platform',
      });
      chargedUsd = aiMetering.computeCost(body.model, json.usage).charged_usd_micro / 1_000_000;
    }
    gatewayKeys.touchUsage(keyRow.id);

    logger.info('gateway_message_proxied', {
      orgId,
      keyId: keyRow.id,
      model: body.model,
      input_tokens: json.usage?.input_tokens || 0,
      output_tokens: json.usage?.output_tokens || 0,
    });

    res.setHeader('X-OpenCRM-Charged-USD', chargedUsd.toFixed(6));
    return res.status(200).json(json);
  } catch (err) {
    logger.error('gateway_proxy_failed', { orgId, keyId: keyRow.id, model: body.model, error: err.message });
    return apiError(res, 502, 'api_error', 'The gateway could not reach the AI provider. Try again.');
  }
});

module.exports = router;
