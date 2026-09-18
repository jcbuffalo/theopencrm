// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Per-route rate limiters that need finer control than the global limiters
// configured in index.js.
//
// index.js already mounts three app-wide limiters (global IP limiter, auth
// limiter on /api/auth/*, AI limiter on the Claude-burning endpoints). The
// limiters here are scoped to individual sensitive routes that need a
// different key strategy or a much stricter cap — typically things like
// password changes where we want to throttle per-user, not per-IP, because
// the attacker controls the IP but not the JWT.

const rateLimit = require('express-rate-limit');
// `ipKeyGenerator` normalizes IPv6 addresses to a /64 prefix so a single
// attacker can't bypass the limiter by rotating through the trailing 64 bits.
// express-rate-limit v8 warns (loudly, at startup) if a custom keyGenerator
// uses req.ip directly without it. See ERR_ERL_KEY_GEN_IPV6.
const { ipKeyGenerator } = require('express-rate-limit');

/**
 * Throttle password-change attempts.
 *
 * Keyed by req.userId (the authenticated user) with an IP fallback for
 * defense-in-depth in case authMiddleware hasn't run yet upstream. Five
 * attempts per 15 minutes is roomy enough for "fat-fingered the current
 * password twice, then got it right" but bounds a compromised-token
 * brute-force on the current-password check at 5/15min.
 *
 * Apply to the POST /api/me/change-password route in routes/meRoutes.js,
 * AFTER the authMiddleware mount so req.userId is populated.
 */
const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    // req.userId is set by authMiddleware. Fall back to IP (via the
    // IPv6-safe helper) if for any reason we end up running before auth —
    // better to limit by IP than not at all.
    if (req.userId !== undefined && req.userId !== null) {
      return `user:${req.userId}`;
    }
    return `ip:${ipKeyGenerator(req, res)}`;
  },
  message: { error: 'Too many password-change attempts. Try again in 15 minutes.' },
});

/**
 * Throttle conversational AI search (`POST /api/ai/search`).
 *
 * Keyed by req.userId (post-authMiddleware) so a noisy user doesn't burn an
 * org's AI budget; the per-IP `aiLimiter` in index.js (60/15min) is the
 * defense-in-depth layer. 10 conversational searches per minute is enough
 * for a power user iterating on a query but bounds runaway client bugs.
 *
 * Mount AFTER authMiddleware on the route so req.userId is populated.
 */
const aiSearchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    if (req.userId !== undefined && req.userId !== null) {
      return `user:${req.userId}`;
    }
    return `ip:${ipKeyGenerator(req, res)}`;
  },
  message: { error: 'Too many AI search requests. Slow down for a minute.' },
});

/**
 * Throttle manual plugin invocations (POST /api/plugins/:id/run).
 *
 * Keyed by req.userId so a compromised JWT can't burn through quota by
 * rotating IPs; IP fallback covers the unauthenticated edge case.
 * 60/minute mirrors the runtime's own per-org soft cap (see
 * PLUGIN_PLATFORM_VISION.md §3.4): a user trying to manually invoke a
 * plugin faster than once per second is almost certainly debugging in a
 * loop, and the monthly tier quota is the real ceiling.
 *
 * Apply AFTER authMiddleware so req.userId is populated.
 */
const pluginRunLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    if (req.userId !== undefined && req.userId !== null) {
      return `user:${req.userId}`;
    }
    return `ip:${ipKeyGenerator(req, res)}`;
  },
  message: { success: false, error: 'Too many plugin runs. Try again in a minute.', code: 'PLUGIN_RUN_RATE_LIMIT' },
});

/**
 * Throttle the conversational chat copilot (`POST /api/ai/chat`).
 *
 * Each chat turn can fan out to up to 5 tool-use round-trips with Claude, so
 * the per-call cost is higher than single-shot AI endpoints — we keep the
 * per-minute cap tighter than `aiSearchLimiter`. The 200/day soft cap is
 * enforced separately in the route handler against the chat_messages table.
 *
 * Keyed by req.userId (post-authMiddleware) with an IP fallback so an
 * unauthenticated edge case still gets bounded.
 */
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    if (req.userId !== undefined && req.userId !== null) {
      return `user:${req.userId}`;
    }
    return `ip:${ipKeyGenerator(req, res)}`;
  },
  message: { error: 'Too many chat messages. Wait a minute and try again.', code: 'CHAT_RATE_LIMIT' },
});

/**
 * Throttle the chat copilot's debug surface (`POST /api/ai/chat` with
 * `mode: 'debug'`).
 *
 * Heavier than the normal `chatLimiter` because debug-mode users are
 * troubleshooting and routinely fire several questions in quick succession
 * ("show me failures" → "now show me that plugin run" → "now show me the
 * audit events around it"). 40/minute matches the in-the-spec power-user
 * cap and still bounds runaway client bugs. The route falls back to the
 * normal `chatLimiter` for non-debug calls, so this only kicks in when
 * `req.body.mode === 'debug'`.
 *
 * Keyed by req.userId (post-authMiddleware) with an IP fallback so an
 * unauthenticated edge case still gets bounded.
 */
const chatDebugLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    if (req.userId !== undefined && req.userId !== null) {
      return `user:${req.userId}`;
    }
    return `ip:${ipKeyGenerator(req, res)}`;
  },
  message: { error: 'Too many debug-chat messages. Wait a minute and try again.', code: 'CHAT_DEBUG_RATE_LIMIT' },
});

/**
 * Throttle CSV import EXECUTE routes (POST /api/import/contacts and /companies).
 *
 * A single request to these routes loops over the posted `rows` array and runs
 * one INSERT per row — a large upload can create tens of thousands of rows and
 * hammer the DB. Keyed by req.userId (post-authMiddleware) so a compromised JWT
 * can't bypass by rotating IPs; the per-IP global limiter is the fallback.
 * 10 bulk imports per 15 minutes is generous for a human curating an import but
 * bounds an abusive/looping client.
 *
 * Apply AFTER authMiddleware on each execute route so req.userId is populated.
 */
const importExecuteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    if (req.userId !== undefined && req.userId !== null) {
      return `user:${req.userId}`;
    }
    return `ip:${ipKeyGenerator(req, res)}`;
  },
  message: { error: 'Too many imports. Wait a few minutes before importing again.', code: 'IMPORT_RATE_LIMIT' },
});

/**
 * Throttle unauthenticated public POST endpoints (contact form, request-access).
 *
 * These accept anonymous input and each one writes a row + can trigger an
 * email, so they're an abuse/spam vector. Keyed per-IP (the default v8
 * keyGenerator, which is already IPv6-safe) since there's no session yet.
 * 10 submissions per 15 minutes per IP is plenty for a real visitor.
 *
 * Mount at the top of the public router, before the handler.
 */
const publicFormLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many submissions. Please try again in a few minutes.', code: 'PUBLIC_FORM_RATE_LIMIT' },
});

/**
 * Throttle the PUBLIC lead-capture surface (/api/public/lead-forms/:token).
 *
 * Unauthenticated, writes a leads row per submit, and the token in the URL is
 * the only scoping — this is the most exposed write endpoint in the app, so
 * it gets its own strict per-IP cap (default v8 keyGenerator, IPv6-safe)
 * rather than sharing publicFormLimiter's counter with the contact form.
 * 20 per 15 minutes per IP is roomy for a real visitor (a human submits a
 * capture form once, maybe twice) while bounding scripted spam; the global
 * per-IP limiter remains the outer rail.
 *
 * Mount at the /api/public/lead-forms mount point in index.js, covering both
 * the GET (render) and POST (submit) paths.
 */
const leadCaptureLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again in a few minutes.', code: 'LEAD_CAPTURE_RATE_LIMIT' },
});

/**
 * Throttle the PUBLIC survey-response surface (/api/public/surveys/:token).
 *
 * Mirrors leadCaptureLimiter: unauthenticated, token-scoped, writes on POST —
 * an abuse surface that gets its own strict per-IP cap (default v8
 * keyGenerator, IPv6-safe) rather than sharing another public counter. 20 per
 * 15 minutes per IP is roomy for a real respondent (a human answers a survey
 * once) while bounding scripted token-guessing and spam; the global per-IP
 * limiter remains the outer rail.
 *
 * Mount at the /api/public/surveys mount point in index.js, covering both the
 * GET (render) and POST (respond) paths.
 */
const surveyResponseLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again in a few minutes.', code: 'SURVEY_RESPONSE_RATE_LIMIT' },
});

/**
 * Throttle the PUBLIC customer-portal read surface (/api/public/portal/:token).
 *
 * Unauthenticated and token-scoped like leadCaptureLimiter /
 * surveyResponseLimiter, but READ-ONLY (the only write it can cause is the
 * last_accessed_at stamp), so the cap is roomier: a customer reviewing their
 * account loads overview + deals + documents and may download a few files in
 * one sitting. 60 per 15 minutes per IP covers that comfortably while still
 * bounding scripted token-guessing (a 192-bit token space makes brute force
 * hopeless anyway; the limiter is the defense-in-depth rail). Per-IP via the
 * default v8 keyGenerator (IPv6-safe); the global per-IP limiter remains the
 * outer rail.
 *
 * Mount at the /api/public/portal mount point in index.js, covering all the
 * token-scoped GET paths.
 */
const portalReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a few minutes.', code: 'PORTAL_RATE_LIMIT' },
});

/**
 * Throttle the PUBLIC customer-portal WRITE surface
 * (POST /api/public/portal/:token/cases).
 *
 * The portal's first (and only) public write beyond lead capture: an
 * unauthenticated, token-scoped case submission. It gets its own STRICT
 * per-IP cap — deliberately NOT the roomy portalReadLimiter (60/15min, sized
 * for browsing) and NOT sharing another public counter. 10 per 15 minutes per
 * IP is plenty for a real customer filing a ticket (or two) while bounding
 * scripted spam-case floods; the global per-IP limiter and portalReadLimiter
 * (which wraps the whole /api/public/portal mount) remain the outer rails.
 * Per-IP via the default v8 keyGenerator (IPv6-safe) — there is no session.
 *
 * Apply directly on the POST /:token/cases route in portalRoutes.publicRouter
 * so reads never burn the write budget.
 */
const portalWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again in a few minutes.', code: 'PORTAL_WRITE_RATE_LIMIT' },
});

/**
 * Throttle Segment EVALUATION reads (POST /api/segments/preview and
 * GET /api/segments/:id/members).
 *
 * Each call compiles user criteria into a query that can include the
 * correlated last-touch subquery (a scan over activities/deals/contacts).
 * It's bounded to the caller's own tenancy and capped at 200 rows, but the
 * live builder can fire a preview on every keystroke (debounced client-side).
 * This is the defense-in-depth server rail the security review flagged (P3):
 * 90/minute is generous for a human tuning a segment but bounds a runaway
 * client or a scripted hammer. Keyed by req.userId (post-authMiddleware) so a
 * compromised JWT can't rotate IPs; per-IP global limiter is the fallback.
 *
 * Apply AFTER authMiddleware so req.userId is populated.
 */
const segmentQueryLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 90,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    if (req.userId !== undefined && req.userId !== null) {
      return `user:${req.userId}`;
    }
    return `ip:${ipKeyGenerator(req, res)}`;
  },
  message: { error: 'Too many segment previews. Slow down for a minute.', code: 'SEGMENT_QUERY_RATE_LIMIT' },
});

/**
 * Throttle Segment BULK WRITE actions (POST /api/segments/:id/bulk).
 *
 * A single bulk call can rewrite every matching row in the caller's tenant
 * (admin-gated + audited + affected-count-capped in the route). A human runs
 * these deliberately a few at a time; 20/minute bounds a scripted abuse loop
 * without getting in the way of legitimate batch cleanup. Keyed by req.userId
 * with an IP fallback.
 *
 * Apply AFTER authMiddleware so req.userId is populated.
 */
const segmentBulkLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    if (req.userId !== undefined && req.userId !== null) {
      return `user:${req.userId}`;
    }
    return `ip:${ipKeyGenerator(req, res)}`;
  },
  message: { error: 'Too many bulk actions. Wait a minute and try again.', code: 'SEGMENT_BULK_RATE_LIMIT' },
});

/**
 * Throttle PUBLIC password-reset REQUESTS (POST /api/security/password-reset/request).
 *
 * Unauthenticated by definition (the caller forgot their password), writes a
 * token row + sends an email per hit, and is the classic account-enumeration /
 * email-bombing surface — so it gets a STRICT per-IP cap (default v8
 * keyGenerator, IPv6-safe). 5 per 15 minutes per IP covers "typo'd my email,
 * tried again" with room to spare while bounding scripted floods. A per-ACCOUNT
 * throttle (max 3 outstanding token mints per 15 min, enforced in the route
 * against password_reset_tokens.created_at) is the second rail, so rotating
 * IPs still can't bomb one inbox. The global per-IP limiter is the outer rail.
 *
 * Mount directly on the request route in routes/securityFlowRoutes.js.
 */
const passwordResetRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many reset requests. Try again in 15 minutes.', code: 'PASSWORD_RESET_RATE_LIMIT' },
});

/**
 * Throttle PUBLIC password-reset CONFIRMS (POST /api/security/password-reset/confirm).
 *
 * Also unauthenticated — the 256-bit token in the body is the credential, so
 * brute force is hopeless, but the endpoint burns a bcrypt compare per history
 * row plus a hash on success, and a scripted hammer shouldn't get to spin
 * those CPUs. 10 per 15 minutes per IP is roomy for a human who fat-fingers
 * the new password a few times against the policy; per-IP via the default v8
 * keyGenerator (IPv6-safe).
 *
 * Mount directly on the confirm route in routes/securityFlowRoutes.js.
 */
const passwordResetConfirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts. Try again in 15 minutes.', code: 'PASSWORD_RESET_RATE_LIMIT' },
});

/**
 * Throttle the PUBLIC browser crash-report receiver (POST /api/client-errors)
 * and its CSP-violation sibling (POST /api/client-errors/csp).
 *
 * Auth-optional and CSRF-exempt by design (an ErrorBoundary must be able to
 * report even when the session is broken — a broken session is often WHY the
 * page crashed), which makes it a log-spam vector. A real user produces at
 * most a couple of crash reports per session; 10 per 15 minutes per IP is
 * roomy for that while bounding scripted floods. Per-IP via the default v8
 * keyGenerator (IPv6-safe). The handler itself never 500s — a rejected or
 * malformed report is dropped, never surfaced to the crashing page.
 */
const clientErrorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many error reports.', code: 'CLIENT_ERROR_RATE_LIMIT' },
});

/**
 * Throttle the first-party pageview beacon (POST /api/metrics/pageview).
 *
 * Fire-and-forget from the SPA on every route change; anonymous-friendly and
 * CSRF-exempt, so it needs its own per-IP rail. 60 per 15 minutes per IP is
 * generous for a human clicking around (4 page loads a minute, sustained)
 * while bounding scripted noise — an over-limit beacon is silently dropped
 * client-side (the sender never surfaces failures). Per-IP via the default
 * v8 keyGenerator (IPv6-safe); the global limiter remains the outer rail.
 */
const pageviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many pageview beacons.', code: 'PAGEVIEW_RATE_LIMIT' },
});

/**
 * Programmatic consumer of pluginRunLimiter for NON-route invocation paths
 * (the chat copilot's run_plugin tool). It shares the SAME limiter instance
 * and store as POST /api/plugins/:id/run — one 60/min/user budget covers
 * plugin runs regardless of which surface triggers them — but instead of
 * writing a 429 response it resolves { allowed: false } so the caller can
 * return a tool-level error into the chat turn.
 *
 * Fail-open on any internal error: a limiter hiccup must not take the chat
 * tool offline.
 */
async function consumePluginRunAllowance(req) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (allowed) => {
      if (!settled) { settled = true; resolve({ allowed }); }
    };
    // Minimal res stub — express-rate-limit only touches headers and, on
    // limit, status().send()/json() via its default handler.
    const stubRes = {
      headersSent: false,
      locals: {},
      setHeader() { return this; },
      getHeader() { return undefined; },
      removeHeader() { return this; },
      append() { return this; },
      status() { return this; },
      send() { done(false); return this; },
      json() { done(false); return this; },
      end() { done(false); return this; },
      on() { return this; },
    };
    try {
      pluginRunLimiter(req, stubRes, () => done(true));
    } catch {
      done(true); // fail open
    }
  });
}

module.exports = {
  changePasswordLimiter,
  aiSearchLimiter,
  pluginRunLimiter,
  consumePluginRunAllowance,
  chatLimiter,
  chatDebugLimiter,
  importExecuteLimiter,
  publicFormLimiter,
  leadCaptureLimiter,
  surveyResponseLimiter,
  portalReadLimiter,
  portalWriteLimiter,
  passwordResetRequestLimiter,
  passwordResetConfirmLimiter,
  clientErrorLimiter,
  pageviewLimiter,
  segmentQueryLimiter,
  segmentBulkLimiter,
};
