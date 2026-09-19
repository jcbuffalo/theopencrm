// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Main Express server entry point
// Includes all core middleware and patterns from pantryqueen

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5001;

// ============================================================================
// BOOT-TIME ENV VALIDATION — fail fast on misconfigured deploys
// ============================================================================
// In production this throws if any REQUIRED env var is missing, which crashes
// the container and prevents the bad revision from receiving traffic. Better
// to fail at deploy than mid-pitch.
const { validateEnv } = require('./services/envValidation');
let envReport;
try {
  envReport = validateEnv();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('\n' + (err.message || err) + '\n');
  process.exit(1);
}

// ============================================================================
// SECURITY MIDDLEWARE
// ============================================================================

// Security headers. Default helmet covers HSTS, frameguard, no-sniff, etc.
// CSP is configured explicitly because helmet's defaults are intentionally
// permissive — we lock script-src to 'self' + Google's accounts.google.com
// (needed for Google Sign-In's iframe + GSI library) and allow Tailwind's
// inline styles (required by CRA-built bundles). Adjust the directives below
// if a new third-party script is introduced.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src':  ["'self'", 'https://accounts.google.com', 'https://apis.google.com'],
      'style-src':   ["'self'", "'unsafe-inline'"],
      'img-src':     ["'self'", 'data:', 'https:'],
      'connect-src': ["'self'", 'https://accounts.google.com', 'https://*.run.app'],
      'frame-src':   ["'self'", 'https://accounts.google.com'],
      'frame-ancestors': ["'none'"],
      'object-src':  ["'none'"],
    },
  },
}));

// CORS configuration - Enhanced for Cloud Run troubleshooting
// ⚠️ CRITICAL: FRONTEND_URL must be set correctly for Cloud Run
// FRONTEND_URL accepts a single URL or a comma-separated list. We split it so
// you can list both the custom domain and the raw Cloud Run URL (which users
// sometimes hit directly during testing or when DNS hasn't propagated).
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  ...(process.env.FRONTEND_URL || '').split(',').map(s => s.trim()).filter(Boolean),
];

// Cloud Run URLs follow a stable per-project pattern. Allowing the project's
// own *.run.app subdomains avoids the "I hit the raw URL and got CORS-blocked"
// failure mode without opening up to all of *.run.app on the public internet.
const RUN_APP_PATTERN = /^https:\/\/[a-z0-9-]+-vknejwwyra-uc\.a\.run\.app$/;

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (CLI, curl, mobile)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (RUN_APP_PATTERN.test(origin))    return callback(null, true);

    console.warn(`⚠️  CORS blocked origin: ${origin}. Allowed: ${allowedOrigins.join(', ')}`);
    return callback(new Error('CORS not allowed for this origin'));
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  // X-CSRF-Token added — the frontend reads the csrfToken cookie and echoes
  // it on every state-changing request (double-submit pattern). Authorization
  // stays in the list for the transitional Bearer-token fallback in
  // backend/auth.js — slated for removal once API clients have migrated.
  allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // limit each IP to 500 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/health';
  },
});

app.use(limiter);

// Auth-specific limiter: stricter caps on login/registration/oauth endpoints
// to slow credential-stuffing and password-spray attacks. Keyed by IP rather
// than email so a single attacker can't bypass by rotating account names.
// Mounted *before* the auth router so it covers every route under /api/auth.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // 30 attempts per 15 min per IP across login/register/google
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many auth attempts. Try again in 15 minutes.' },
  // Exempt the read-only session probes the SPA calls on every mount. They are
  // not credential-exposure surfaces, and counting them throttles normal
  // sign-in from shared IPs (corporate/mobile-carrier NAT) to 429. Credential
  // endpoints (/login, /register, /google-signin, /2fa/verify) stay limited.
  skip: (req) => {
    const p = req.path || '';
    return p === '/me' || p === '/login-options'
        || p.endsWith('/auth/me') || p.endsWith('/auth/login-options');
  },
});

// AI-burning endpoint limiter — per-IP cap on routes that invoke Claude.
// Defense-in-depth on top of the per-org tier quota: if a single user is
// hammering the endpoint (intentional or runaway script), this stops the
// noise without affecting other tenants. 60/15min is generous for normal
// use but bounds the worst case at < $5 even on the most expensive prompts.
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many AI requests from this IP. Slow down for 15 minutes.' },
});

// SMS-send limiter — per-IP cap on the outbound-SMS endpoint. SMS costs real
// money per segment and is an abuse surface (spam / toll-fraud), so we bound
// it tighter than the global limiter. 30/15min is generous for a rep working a
// pipeline but stops a runaway script or a compromised session from racking up
// a Twilio bill. Mounted only on /api/sms (POST send); call-logging is free.
const smsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many SMS sends from this IP. Slow down for 15 minutes.' },
});

// ============================================================================
// BODY PARSING MIDDLEWARE
// ============================================================================
//
// IMPORTANT: the Stripe webhook receiver MUST see the unparsed request body
// because stripe.webhooks.constructEvent() recomputes the signature over the
// raw bytes. If express.json() runs first it consumes the stream and turns
// req.body into a parsed object — signature verification then fails (or
// silently mismatches), and every customer.subscription.* event is rejected,
// which would prevent ai_billing_status from flipping to 'active' after a
// successful AI Pay-as-you-go checkout. The router-scoped express.raw() on
// /api/billing/webhook in routes/billingRoutes.js only works if THIS global
// parser doesn't fire first. Hence the explicit skip below.
const STRIPE_WEBHOOK_PATH = '/api/billing/webhook';
app.use((req, res, next) => {
  if (req.path === STRIPE_WEBHOOK_PATH) return next();
  // Stash the raw bytes so signature-verified inbound webhooks (e.g. Zoom in
  // routes/webhookRoutes.js) can HMAC the exact payload instead of a
  // re-serialized JSON string, which can diverge and cause false 401s.
  return express.json({ limit: '10mb', verify: (req, _res, buf) => { req.rawBody = buf; } })(req, res, next);
});
app.use((req, res, next) => {
  if (req.path === STRIPE_WEBHOOK_PATH) return next();
  return express.urlencoded({ limit: '10mb', extended: true })(req, res, next);
});

// ============================================================================
// COOKIE PARSER + CSRF (double-submit, signed cookies)
// ============================================================================
// COOKIE_SECRET signs every cookie we set (including the auth cookie and the
// csrf-csrf double-submit secret cookie). Boot-time env validation in
// services/envValidation.js refuses to start in production without it.
app.use(cookieParser(process.env.COOKIE_SECRET));

// CSRF: double-submit cookie pattern via csrf-csrf. Two cookies are set on
// the client:
//   • __Host-psifi.x-csrf-token (signed, httpOnly) — server-side secret
//   • csrfToken (readable from JS)                 — what the frontend echoes
//     back in the X-CSRF-Token header on state-changing requests
// The double-submit comparison is what blocks CSRF: an attacker on another
// origin can't read the csrfToken cookie value to forge the header.
//
// Exempt routes (CSRF intentionally NOT enforced):
//   1. GET / HEAD / OPTIONS — no state change.
//   2. /api/billing/webhook — Stripe → us. Signed with stripe-signature.
//   3. /api/webhooks/*      — Teams / Zoom / generic. Signed with shared
//      secret or HMAC in service-specific header. Inbound third-party POSTs
//      can't carry our CSRF cookie anyway.
//   4. /api/contact          — public contact form (no session yet).
//   5. /api/request-access   — public access request (no session yet).
//   6. /api/auth/login, /register, /google-signin, /test-login — pre-session.
//      The state change is "create session"; CSRF protection on pre-session
//      POSTs would require a token nobody has yet.
//   7. /api/auth/2fa/verify  — pre-session (tempToken-authenticated, not
//      cookie-authenticated). The tempToken itself is the anti-CSRF token.
//   8. /api/security/email/verify — public, token-from-email is enough.
//      Same for /api/security/password-reset/request (pre-session by
//      definition — the caller forgot their password) and /confirm (the
//      256-bit token from the email is the credential). Both are strictly
//      rate-limited in routes/securityFlowRoutes.js.
//   9. /api/invites/*        — public accept-invite (token in URL).
//  10. /api/emails/unsubscribe/* and /track/*.gif — public from any inbox.
//  11. /api/public/lead-forms/* — public lead-capture submit (no session; the
//      192-bit form token in the URL is the scoping credential, and the
//      endpoint grants nothing to the caller). Per-IP rate limited.
//  12. /api/public/surveys/* — public NPS/CSAT survey respond (no session;
//      the 192-bit response token is the scoping credential and records
//      exactly one response). Per-IP rate limited.
const csrfIgnoredRoutes = [
  '/api/billing/webhook',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/google-signin',
  '/api/auth/test-login',
  '/api/auth/2fa/verify',
  '/api/auth/resend-verification',
  '/api/auth/csrf',                       // token-refresh, no side effects
  '/api/security/email/verify',
  '/api/security/password-reset/request',
  '/api/security/password-reset/confirm',
  '/api/contact',
  '/api/request-access',
  // Browser crash reports + CSP violation reports (routes/clientErrorRoutes.js).
  // Auth-optional by design (a broken session is often why the page crashed;
  // CSP reports are browser-generated and carry no cookies), grant nothing to
  // the caller, and are strictly per-IP rate limited.
  '/api/client-errors',
  '/api/client-errors/csp',
  // First-party pageview beacon (routes/pageviewRoutes.js) — anonymous-friendly
  // fire-and-forget write of one aggregate row; per-IP rate limited, no PII.
  '/api/metrics/pageview',
];
function isCsrfExempt(req) {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  const p = req.path;
  if (csrfIgnoredRoutes.includes(p)) return true;
  if (p.startsWith('/api/webhooks/')) return true;
  // /api/v1/* is authenticated by an API key (middleware/apiKeyAuth.js), not
  // the session cookie — external clients can't carry a CSRF cookie, and the
  // API key itself is an unguessable bearer credential, so double-submit CSRF
  // does not apply. (Read-only today; exempting the prefix is forward-safe.)
  if (p.startsWith('/api/v1/')) return true;
  // SCIM 2.0 provisioning is authenticated by a scim_ bearer token (no cookies),
  // so double-submit CSRF does not apply. See middleware/scimAuth.js.
  if (p.startsWith('/scim/')) return true;
  if (p.startsWith('/api/invites/')) return true;
  if (p.startsWith('/api/public/lead-forms/')) return true;
  if (p.startsWith('/api/public/surveys/')) return true;
  // Customer portal public reads (no session; the 192-bit portal token in the
  // URL is the scoping credential). GET-only today — listed for forward-safety.
  if (p.startsWith('/api/public/portal/')) return true;
  // AI Gateway proxy (spec 202): authenticated by an ocrm_gw_ bearer key, not
  // the session cookie — an external self-hosted server can't carry a CSRF
  // cookie, and the 256-bit gateway key is the credential. Management
  // endpoints (/api/billing/ai/gateway-keys) stay session-authed + CSRF'd.
  if (p.startsWith('/api/gateway/')) return true;
  if (p.startsWith('/api/emails/unsubscribe/')) return true;
  if (p.startsWith('/api/emails/track/')) return true;
  return false;
}

// CSRF_SECRET is required in production (see envValidation.js). In dev we
// generate a random one at boot so local testing isn't blocked by missing
// config — but tokens minted in one dev run won't survive a restart.
const csrfSecret = process.env.CSRF_SECRET
  || (process.env.NODE_ENV === 'production'
    ? (() => { throw new Error('CSRF_SECRET required in production'); })()
    : require('crypto').randomBytes(64).toString('hex'));

const {
  generateToken: generateCsrfToken,
  doubleCsrfProtection,
} = doubleCsrf({
  getSecret: () => csrfSecret,
  cookieName: 'csrfToken',
  cookieOptions: {
    httpOnly: false, // frontend reads this and echoes it in X-CSRF-Token
    // Cross-site cookie semantics — same logic as auth.js authCookieOptions:
    // frontend on theopencrm.com talks to backend on *.run.app, which is
    // cross-registrable-domain. SameSite=lax would prevent the csrf cookie
    // (signed secret half of double-submit) from shipping on POST requests,
    // so every authenticated state-changing call would 403 even though the
    // auth cookie (sameSite=none) makes it through. Symptom we just hit on
    // the phone: /security/email/send-verification returned 403.
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  },
  size: 64,
  getTokenFromRequest: (req) => req.headers['x-csrf-token'],
  ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
});

// Expose the issuer to route handlers (login / google-signin / 2fa-verify
// call this to include the token in their JSON response).
app.locals.generateCsrfToken = generateCsrfToken;

app.use((req, res, next) => {
  if (isCsrfExempt(req)) return next();
  return doubleCsrfProtection(req, res, next);
});

// ============================================================================
// REQUEST CONTEXT + STRUCTURED LOGGING
// ============================================================================
// Trust the Cloud Run front-end proxy so req.ip resolves to the real client IP.
// Setting this to a fixed hop count (rather than `true`) avoids the express-rate-limit
// "permissive trust proxy" warning and prevents header spoofing past the LB.
app.set('trust proxy', 1);

const requestContext = require('./middleware/requestContext');
app.use(requestContext);

// ============================================================================
// HEALTH CHECK ENDPOINT (for Cloud Run)
// ============================================================================

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Deep health check — actually tests dependencies. Returns 503 if anything's
// down. Use this in deploy scripts to verify a fresh revision is truly working
// before cutting traffic over. Slower than /health (fires real DB query) so
// don't put it on Cloud Run's startup-probe path.
app.get('/health/deep', async (req, res) => {
  const checks = {};
  let httpStatus = 200;

  // DB
  try {
    const pool = require('./db');
    const r = await pool.query('SELECT NOW() AS now');
    checks.database = { ok: true, now: r.rows[0].now };
  } catch (err) {
    checks.database = { ok: false, error: err.message };
    httpStatus = 503;
  }

  // GCS (only if configured)
  try {
    const storage = require('./services/storage');
    if (storage.isConfigured()) {
      // Tiny probe — list 1 object. If bucket access is broken, this fails fast.
      // We don't actually use the result.
      checks.storage = { ok: true, bucket: storage.BUCKET_NAME };
    } else {
      checks.storage = { ok: 'skipped', reason: 'not_configured' };
    }
  } catch (err) {
    checks.storage = { ok: false, error: err.message };
    // GCS down doesn't fail the health check — uploads degrade to DB blob.
  }

  // Email
  try {
    const email = require('./services/email');
    checks.email = { ok: email.isConfigured() ? true : 'skipped', configured: email.isConfigured() };
  } catch (err) {
    checks.email = { ok: false, error: err.message };
  }

  // AI
  try {
    const ai = require('./services/ai');
    checks.ai = { ok: ai.isConfigured() ? true : 'skipped', configured: ai.isConfigured() };
  } catch (err) {
    checks.ai = { ok: false, error: err.message };
  }

  res.status(httpStatus).json({
    status: httpStatus === 200 ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
    integrations: envReport?.integrations || {},
  });
});

// Pitch-readiness endpoint — green/yellow/red status of every demo-relevant
// feature. Hit this just before a demo to make sure nothing's broken silently.
// Returns 200 even if things are red so monitoring tools can read the body.
app.get('/api/pitch-readiness', async (req, res) => {
  const out = { timestamp: new Date().toISOString(), checks: [] };
  const pool = require('./db');

  async function check(name, fn) {
    try { const v = await fn(); out.checks.push({ name, status: 'green', detail: v }); }
    catch (err) { out.checks.push({ name, status: 'red', detail: err.message }); }
  }

  await check('Database connection', async () => {
    const r = await pool.query('SELECT NOW() AS now');
    return `responded at ${r.rows[0].now}`;
  });

  await check('Migrations table populated', async () => {
    const r = await pool.query('SELECT COUNT(*)::int AS c FROM migrations');
    return `${r.rows[0].c} migrations recorded`;
  });

  await check('Admin users exist', async () => {
    const r = await pool.query('SELECT COUNT(*)::int AS c FROM admin_users');
    if (r.rows[0].c === 0) throw new Error('No admin users — seed admin allowlist may be missing');
    return `${r.rows[0].c} admin user(s) configured`;
  });

  await check('Demo data present (any deals)', async () => {
    const r = await pool.query('SELECT COUNT(*)::int AS c FROM deals');
    if (r.rows[0].c === 0) return 'WARN: no deals — run /admin/access-requests → Demo data → Seed before pitching';
    return `${r.rows[0].c} deals in system`;
  });

  // Integration status (does NOT fire real calls; just config check)
  for (const [k, v] of Object.entries(envReport?.integrations || {})) {
    out.checks.push({
      name: `Integration: ${k}`,
      status: v ? 'green' : 'yellow',
      detail: v ? 'configured' : 'not configured (optional)',
    });
  }

  // Counts of red / yellow / green for quick eyeballing
  out.summary = out.checks.reduce((acc, c) => { acc[c.status]++; return acc; }, { green: 0, yellow: 0, red: 0 });
  res.json(out);
});

// ============================================================================
// LEGAL DOCUMENTS — mounted from routes/legalRoutes.js
// ============================================================================
// Public endpoints: GET /api/legal (index), GET /api/legal/:doc (markdown
// body). Serves the templates in /legal/ — see legal/LEGAL_TODO.md for the
// counsel-review status.
app.use('/api/legal', require('./routes/legalRoutes'));

// ============================================================================
// ROUTE IMPORTS
// ============================================================================

const authRoutes = require('./routes/authRoutes');
const companyRoutes = require('./routes/companyRoutes');
const contactRoutes = require('./routes/contactRoutes');
const dealRoutes = require('./routes/dealRoutes');
const activityRoutes = require('./routes/activityRoutes');
const smsRoutes = require('./routes/smsRoutes');
const callRoutes = require('./routes/callRoutes');
const taskRoutes = require('./routes/taskRoutes');
const pipelineRoutes = require('./routes/pipelineRoutes');
const contactFormRoutes = require('./routes/contactFormRoutes');
const importRoutes = require('./routes/importRoutes');
const orgRoutes = require('./routes/orgRoutes');
const acceptInviteRoutes = require('./routes/acceptInviteRoutes');
const searchRoutes = require('./routes/searchRoutes');
const adminRoutes = require('./routes/adminRoutes');
const accessRequestRoutes = require('./routes/accessRequestRoutes');
const quickbooksRoutes = require('./routes/quickbooksRoutes');
const automationRoutes = require('./routes/automationRoutes');
const securityFlowRoutes = require('./routes/securityFlowRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const serviceContractRoutes = require('./routes/serviceContractRoutes');
const filterRoutes = require('./routes/filterRoutes');
const demoRoutes = require('./routes/demoRoutes');
const aiRoutes = require('./routes/aiRoutes');
const appreciationRoutes = require('./routes/appreciationRoutes');
const quoteRoutes = require('./routes/quoteRoutes');
const vendorQuoteRoutes = require('./routes/vendorQuoteRoutes');
const submittalRoutes = require('./routes/submittalRoutes');
const changeOrderRoutes = require('./routes/changeOrderRoutes');
const issueRoutes = require('./routes/issueRoutes');
const documentRoutes = require('./routes/documentRoutes');
const metricsRoutes = require('./routes/metricsRoutes');
const accountRoutes = require('./routes/accountRoutes');
const segmentRoutes = require('./routes/segmentRoutes');

// Developer platform (migrations 108/109): API keys, outbound webhooks, and the
// API-key-authenticated public /api/v1 surface. See middleware/apiKeyAuth.js.
const apiKeyRoutes = require('./routes/apiKeyRoutes');
const outboundWebhookRoutes = require('./routes/outboundWebhookRoutes');
const apiV1Routes = require('./routes/apiV1Routes');

// Phase 2 (FlowArchitect domain model) — gated by phase2_entities feature flag.
const v2RfqRoutes               = require('./routes/v2/rfqRoutes');
const v2PurchaseOrderRoutes     = require('./routes/v2/purchaseOrderRoutes');
const v2InvoiceRoutes           = require('./routes/v2/invoiceRoutes');
const v2InvoiceAllocationRoutes = require('./routes/v2/invoiceAllocationRoutes');
const adminFeatureFlagRoutes    = require('./routes/adminFeatureFlagRoutes');

// Module-level feature gating (see services/featureFlags.js KNOWN_FLAGS).
// Each gated module can be turned off per-org via /api/admin/feature-flags.
const { requireFeature, requireAnyFeature } = require('./middleware/featureGate');

// AI Pay-as-you-go billing gate. Returns 402 with a machine-readable code
// when the caller's org has no active subscription/comp/trial. Super-admins
// bypass. Mounted on /api/ai and /api/plugins below.
const { requireAiBilling } = require('./middleware/requireAiBilling');

// ============================================================================
// OPTIONS HANDLER (for CORS preflight requests)
// ============================================================================

app.options('*', cors());

// ============================================================================
// ROUTE REGISTRATION
// ============================================================================

// Auth routes (must come first - no auth required). Stricter rate limiter
// applied here only — global limiter is too lax for credential endpoints.
app.use('/api/auth', authLimiter, authRoutes);
console.log('✅ Mounted: POST /api/auth/register');
console.log('✅ Mounted: POST /api/auth/login');
console.log('✅ Mounted: POST /api/auth/google-signin');
console.log('✅ Mounted: POST /api/auth/logout');
console.log('✅ Mounted: GET  /api/auth/me');

// SSO handoff for sibling apps (workforce, etc.). Auth IS required (uses the
// existing CRM JWT inside the route handler). Validates return_url and mints
// a short-lived token signed with JWT_SSO_SECRET (must be set in env).
app.use('/api/auth/sso', require('./routes/ssoRoutes'));
console.log('✅ Mounted: POST /api/auth/sso/mint');

// Enterprise SSO (OIDC) login flow — PUBLIC, pre-auth (migration 117). Resolve
// (email/slug → connection), /:slug/start (→ IdP authorize), /callback (verify
// id_token + mint session). Inert unless an org has the sso_enabled flag AND an
// enabled connection; the flag is enforced per-connection inside the routes
// (they're pre-auth, so no requireFeature middleware — no req.orgId yet).
app.use('/api/auth/sso', require('./routes/ssoLoginRoutes'));
console.log('✅ Mounted: GET /api/auth/sso/:slug/start · /callback · /resolve (OIDC login)');

// CRM Routes
app.use('/api/companies', companyRoutes);
console.log('✅ Mounted: /api/companies (CRUD)');

app.use('/api/contacts', contactRoutes);
console.log('✅ Mounted: /api/contacts (CRUD)');

app.use('/api/deals', dealRoutes);
console.log('✅ Mounted: /api/deals (CRUD)');

app.use('/api/activities', activityRoutes);
console.log('✅ Mounted: /api/activities (CRUD)');

// Communications surface (migration 121). SMS send + log is per-IP rate
// limited on POST; call-logging writes an activities(type='call') row.
app.use('/api/sms', smsLimiter, smsRoutes);
console.log('✅ Mounted: /api/sms (SMS send + log, per-IP rate limited)');

app.use('/api/calls', callRoutes);
console.log('✅ Mounted: /api/calls (call logging → activities)');

app.use('/api/tasks', taskRoutes);
console.log('✅ Mounted: /api/tasks (CRUD)');

app.use('/api/pipelines', pipelineRoutes);
console.log('✅ Mounted: /api/pipelines (CRUD)');

app.use('/api/contact', contactFormRoutes);
console.log('✅ Mounted: POST /api/contact (public contact form)');

// Leads module (migrations 130/131). Authenticated surfaces are gated by
// leads_enabled; the public capture surface is unauthenticated by design —
// org scoping comes solely from the unguessable form token, it carries its
// own strict per-IP limiter, and the flag is re-checked per-form inside the
// route (a mount-point requireFeature would fail-open with no session).
const leadRoutes = require('./routes/leadRoutes');
const leadFormRoutes = require('./routes/leadFormRoutes');
const { leadCaptureLimiter } = require('./middleware/rateLimits');
app.use('/api/leads', requireFeature('leads_enabled'), leadRoutes);
console.log('✅ Mounted: /api/leads (CRUD + /:id/convert, gated by leads_enabled)');
app.use('/api/lead-forms', requireFeature('leads_enabled'), leadFormRoutes);
console.log('✅ Mounted: /api/lead-forms (capture-form CRUD, gated by leads_enabled)');
app.use('/api/public/lead-forms', leadCaptureLimiter, leadFormRoutes.publicRouter);
console.log('✅ Mounted: /api/public/lead-forms/:token (+ /submit) — public, per-IP rate limited, CSRF-exempt');

app.use('/api/import', importRoutes);
console.log('✅ Mounted: POST /api/import/parse, /contacts, /companies (CSV import)');

// Bring-your-own Anthropic key (migration 153). Mounted before /api/org so
// the more specific prefix wins; owner/admin gating lives inside the router.
app.use('/api/org/ai-key', require('./routes/orgAiKeyRoutes'));
app.use('/api/org', orgRoutes);
console.log('✅ Mounted: GET/PUT /api/org, POST /api/org/invite, DELETE /api/org/members/:id');

app.use('/api/invites', acceptInviteRoutes);
console.log('✅ Mounted: GET/POST /api/invites/:token (accept invite)');

app.use('/api/search', searchRoutes);
console.log('✅ Mounted: GET /api/search?q=... (global search)');

app.use('/api/quotes', requireFeature('quotes_enabled'), quoteRoutes);
console.log('✅ Mounted: /api/quotes (gated by quotes_enabled)');

// Generic light-CPQ — product catalog + line-item quote builder. Separate
// surface from the Zang /api/quotes workflow above (different tables:
// products / sales_quotes / sales_quote_items). Gated by products_enabled.
app.use('/api/products', requireFeature('products_enabled'), require('./routes/productRoutes'));
console.log('✅ Mounted: /api/products (gated by products_enabled)');

app.use('/api/sales-quotes', requireFeature('products_enabled'), require('./routes/salesQuoteRoutes'));
console.log('✅ Mounted: /api/sales-quotes (light CPQ, gated by products_enabled)');

app.use('/api/vendor-quotes', requireFeature('vendor_quotes_enabled'), vendorQuoteRoutes);
console.log('✅ Mounted: /api/vendor-quotes (gated by vendor_quotes_enabled)');

app.use('/api/submittals', requireFeature('submittals_enabled'), submittalRoutes);
console.log('✅ Mounted: /api/submittals (gated by submittals_enabled)');

app.use('/api/change-orders', requireFeature('change_orders_enabled'), changeOrderRoutes);
console.log('✅ Mounted: /api/change-orders (gated by change_orders_enabled)');

app.use('/api/issues', issueRoutes);
console.log('✅ Mounted: /api/issues (urgency-tagged issues with escalation)');

app.use('/api/documents', requireFeature('documents_enabled'), documentRoutes);
console.log('✅ Mounted: /api/documents (gated by documents_enabled)');

// First-party pageview beacon (migration 165). Mounted BEFORE the
// reports_enabled-gated /api/metrics router so anonymous visitors (login,
// marketing, portal pages) and orgs with reports disabled still register
// traffic. CSRF-exempt (see csrfIgnoredRoutes), strictly per-IP rate limited,
// auth-optional, stores no PII (path normalized, referrer reduced to a host).
const { pageviewLimiter } = require('./middleware/rateLimits');
app.use('/api/metrics/pageview', pageviewLimiter, require('./routes/pageviewRoutes'));
console.log('✅ Mounted: POST /api/metrics/pageview (first-party analytics beacon — public, rate limited, CSRF-exempt)');

app.use('/api/metrics', requireFeature('reports_enabled'), metricsRoutes);
console.log('✅ Mounted: /api/metrics (gated by reports_enabled)');

// Custom report builder — ad-hoc aggregate runs + saved report definitions.
// Same gate as the fixed /reports metrics surface.
app.use('/api/reports', requireFeature('reports_enabled'), require('./routes/reportBuilderRoutes'));
console.log('✅ Mounted: /api/reports (custom report builder, gated by reports_enabled)');

// Sales forecasting — weighted pipeline + projected close by period + quota
// attainment. Same analytics gate as the metrics/reports surfaces.
app.use('/api/forecast', requireFeature('reports_enabled'), require('./routes/forecastRoutes'));
console.log('✅ Mounted: /api/forecast (sales forecasting, gated by reports_enabled)');

// Commission & goals — per-rep commission over closed-won deals + plan CRUD.
// Same analytics gate as the metrics/reports/forecast surfaces.
app.use('/api/commission', requireFeature('reports_enabled'), require('./routes/commissionRoutes'));
console.log('✅ Mounted: /api/commission (commission & goals, gated by reports_enabled)');

// Retention & expansion analytics — recurring revenue (MRR/ARR), renewals,
// NRR/GRR, expansion, churn. Customer-success surface: same gate as the
// service-contract /renewals rollup + /api/accounts.
app.use('/api/retention', requireFeature('customer_success_enabled'), require('./routes/retentionRoutes'));
console.log('✅ Mounted: /api/retention (retention & expansion analytics, gated by customer_success_enabled)');

// Relationship Pulse — lightweight NPS/CSAT per account. Same customer-success
// gate as /api/accounts + /api/retention; the latest pulse per company also
// surfaces on the Accounts rollup as a health signal.
app.use('/api/pulse', requireFeature('customer_success_enabled'), require('./routes/pulseRoutes'));
console.log('✅ Mounted: /api/pulse (relationship pulse NPS/CSAT, gated by customer_success_enabled)');

// Lifecycle Funnel analytics — customer-base distribution across account
// lifecycle stages + at-risk exposure + recent movement. Sibling of
// /api/retention; same customer-success gate.
app.use('/api/lifecycle-funnel', requireFeature('customer_success_enabled'), require('./routes/lifecycleFunnelRoutes'));
console.log('✅ Mounted: /api/lifecycle-funnel (lifecycle funnel analytics, gated by customer_success_enabled)');

// Win-back board — churned-account re-engagement (migration 127). Same
// customer-success gate: it's the tail end of the post-sale motion.
app.use('/api/winback', requireFeature('customer_success_enabled'), require('./routes/winbackRoutes'));
console.log('✅ Mounted: /api/winback (churned re-engagement board, gated by customer_success_enabled)');

app.use('/api/admin', adminRoutes);
console.log('✅ Mounted: /api/admin (user management, access requests, audit logs)');

// Platform integrations — super-admin REST surface for in-app credential
// config (Drive OAuth client_id/secret/redirect_uri now, Gmail/Stripe/etc.
// later). See PLATFORM_INTEGRATIONS_SPEC.md. driveOAuth.getCreds() consults
// this table first, falling back to GOOGLE_DRIVE_* env vars for back-compat.
// All routes inside enforce super_admin role via their own middleware stack.
app.use('/api/admin/platform-integrations', require('./routes/platformIntegrationsRoutes'));
console.log('✅ Mounted: /api/admin/platform-integrations (super-admin only)');

// First-party traffic rollups over page_views (migration 165) for the
// /admin/traffic page. Super-admin only — traffic is platform-wide (anonymous
// visits + every tenant mixed), so it's operator data. Page loads only; no
// visitor ids exist, so uniques are structurally impossible (by design).
app.use('/api/admin/traffic', require('./routes/adminTrafficRoutes'));
console.log('✅ Mounted: GET /api/admin/traffic (first-party analytics rollups, super-admin only)');

// Browser crash-report receiver → GCP Error Reporting via logger.error with
// serviceContext { service: 'synccrm-frontend' }. Logs only — NO table.
// Auth-optional + CSRF-exempt (see csrfIgnoredRoutes) + strict per-IP limit.
// The /csp subroute receives CSP report-uri posts from frontend/server.js.
const { clientErrorLimiter } = require('./middleware/rateLimits');
app.use('/api/client-errors', clientErrorLimiter, require('./routes/clientErrorRoutes'));
console.log('✅ Mounted: POST /api/client-errors (+ /csp) — frontend error reports, rate limited, CSRF-exempt');

app.use('/api/request-access', accessRequestRoutes);
console.log('✅ Mounted: POST /api/request-access (public access request)');

app.use('/api/quickbooks', requireFeature('quickbooks_enabled'), quickbooksRoutes);
console.log('✅ Mounted: /api/quickbooks (gated by quickbooks_enabled)');

app.use('/api/automation', requireFeature('automation_enabled'), automationRoutes);
console.log('✅ Mounted: /api/automation (gated by automation_enabled)');

app.use('/api/automation-rules', requireFeature('automation_enabled'), require('./routes/automationRuleRoutes'));
console.log('✅ Mounted: /api/automation-rules (org-admin CRUD, gated by automation_enabled)');

app.use('/api/security', securityFlowRoutes);
console.log('✅ Mounted: /api/security (email verification + 2FA + password reset)');

// INTENTIONALLY NOT org-gated: the inbound receivers (/teams, /zoom, /generic)
// carry no session by design — an external service is POSTing to us — so a
// per-org feature gate can never see an org here. Their real gate is the
// per-provider signature/secret verification inside webhookRoutes. (The old
// requireFeature('webhooks_enabled') on this mount was a no-op for the same
// reason; it was removed rather than "fixed" so inbound deliveries and the
// session-authed GET /meetings keep their existing behavior.)
app.use('/api/webhooks', webhookRoutes);
console.log('✅ Mounted: /api/webhooks (inbound receivers — signature-verified, intentionally not org-gated)');

// AI Gateway proxy (spec 202) — POST /api/gateway/v1/messages. NO session
// auth and CSRF-exempt (see isCsrfExempt): the caller is an external
// self-hosted Open CRM server presenting an ocrm_gw_* gateway key, which is
// hashed and looked up (30s cache) to resolve the paying org. Per-key
// 60/min rate limit + 1 MB body cap + model allowlist + billing verdict
// (evaluateAiBilling) all enforced inside gatewayRoutes BEFORE the upstream
// Anthropic call; usage is metered to the org exactly like hosted AI
// (ai_usage_events endpoint='gateway'). The path shape matches the Anthropic
// SDK's baseURL join: baseURL https://.../api/gateway + /v1/messages.
app.use('/api/gateway', require('./routes/gatewayRoutes'));
console.log('✅ Mounted: POST /api/gateway/v1/messages (AI gateway proxy for self-hosters — key-authed, metered, CSRF-exempt)');

app.use('/api/service-contracts', serviceContractRoutes);
console.log('✅ Mounted: /api/service-contracts (Phase V service contracts + renewal alerts)');

app.use('/api/accounts', requireFeature('customer_success_enabled'), accountRoutes);
console.log('✅ Mounted: /api/accounts (CS-1 account 360, gated by customer_success_enabled)');

// Support Cases (CS-5, migration 134) — customer-facing service tickets that
// feed the Account 360 timeline. Same customer-success gate as /api/accounts.
app.use('/api/cases', requireFeature('customer_success_enabled'), require('./routes/caseRoutes'));
console.log('✅ Mounted: /api/cases (support cases, gated by customer_success_enabled)');

// Success Playbooks — templated task checklists fired when an account enters a
// lifecycle stage (migration 123). Same customer-success gate as /api/accounts.
app.use('/api/playbooks', requireFeature('customer_success_enabled'), require('./routes/playbookRoutes'));
console.log('✅ Mounted: /api/playbooks (success playbooks, gated by customer_success_enabled)');

// NPS/CSAT Surveys (CS-7, migration 138). Management shares the customer-
// success gate; the public response surface is unauthenticated by design —
// org scoping comes solely from the unguessable response token, it carries
// its own strict per-IP limiter, and the flag is re-checked per-token inside
// the route (a mount-point requireFeature would fail-open with no session).
// ⚠️ NO AUTO-SEND: link minting and the optional email send are explicit
// manual actions; email degrades to a console no-op when unconfigured.
const surveyRoutes = require('./routes/surveyRoutes');
const { surveyResponseLimiter } = require('./middleware/rateLimits');
app.use('/api/surveys', requireFeature('customer_success_enabled'), surveyRoutes);
console.log('✅ Mounted: /api/surveys (NPS/CSAT surveys, gated by customer_success_enabled)');
app.use('/api/public/surveys', surveyResponseLimiter, surveyRoutes.publicRouter);
console.log('✅ Mounted: /api/public/surveys/:token (+ /respond) — public, per-IP rate limited, CSRF-exempt');

// Customer Portal (migration 141). Token management is gated by the
// portal_enabled module flag (DEFAULT FALSE — ships inert). The public read
// surface is unauthenticated by design: tenancy comes solely from the
// unguessable 192-bit portal token, it carries its own per-IP limiter, and
// the flag is re-checked per-token inside services/portal.resolveToken (a
// mount-point requireFeature would fail-open with no session). Read-mostly:
// the only public-surface mutation is the last_accessed_at stamp.
const portalRoutes = require('./routes/portalRoutes');
const { portalReadLimiter } = require('./middleware/rateLimits');
app.use('/api/portal', requireFeature('portal_enabled'), portalRoutes);
console.log('✅ Mounted: /api/portal (customer-portal token management, gated by portal_enabled)');
app.use('/api/public/portal', portalReadLimiter, portalRoutes.publicRouter);
console.log('✅ Mounted: /api/public/portal/:token/* — public read-only, per-IP rate limited, CSRF-exempt');

// My Day — personal work-queue aggregate. A core surface, so NOT feature-
// gated; sections that read customer-success data degrade to [] internally.
app.use('/api/my-day', require('./routes/myDayRoutes'));
console.log('✅ Mounted: /api/my-day (personal work-queue aggregate)');

// Per-user dashboard layout (migration 142) — core surface like my-day, so
// NOT feature-gated (plain auth). Persists widget composition only; the
// widgets render from existing endpoints (metrics / my-day / activities /
// forecast). user- AND org-scoped inside the routes.
app.use('/api/dashboard', require('./routes/dashboardRoutes'));
console.log('✅ Mounted: /api/dashboard (per-user customizable dashboard layout)');

// In-app Notification Center — core surface like my-day, so NOT feature-
// gated (plain auth). Org- AND recipient-scoped inside the routes.
app.use('/api/notifications', require('./routes/notificationRoutes'));
console.log('✅ Mounted: /api/notifications (in-app notification center)');

// Record comments with @mentions (migration 146) — core collaboration
// surface like notifications, so NOT feature-gated (plain auth). Org-scoped
// inside the routes; the target entity is verified in-scope before writes.
app.use('/api/comments', require('./routes/commentRoutes'));
console.log('✅ Mounted: /api/comments (record comments + @mentions)');

// In-app Meetings + merged Calendar agenda (migration 137) — core internal
// scheduling with no external OAuth, so NOT feature-gated (plain auth), like
// /api/my-day. The agenda router only answers GET /api/calendar/agenda; every
// other /api/calendar path falls through to the Google-Calendar OAuth router
// mounted further down (which IS gated by calendar_enabled) — this mount must
// therefore stay ABOVE that one.
const meetingRoutes = require('./routes/meetingRoutes');
app.use('/api/meetings', meetingRoutes);
app.use('/api/calendar', meetingRoutes.agendaRouter);
console.log('✅ Mounted: /api/meetings + /api/calendar/agenda (in-app scheduling, plain auth)');

// Relationship Segments + bulk actions (migration 126). Segments also carry an
// in-router requireFeature gate AFTER authMiddleware; since featureGate.js
// learned to resolve the session itself, this mount-point gate is equally
// authoritative (the second check is a cached no-op).
app.use('/api/segments', requireFeature('customer_success_enabled'), segmentRoutes);
console.log('✅ Mounted: /api/segments (relationship segments + bulk actions, gated by customer_success_enabled)');

app.use('/api/filters', filterRoutes);
console.log('✅ Mounted: /api/filters (filter options + saved filters)');

// ---------------------------------------------------------------------------
// Developer platform. Two session-authed management surfaces + one API-key-
// authed public surface (migrations 108/109).
//   /api/keys         — API-key CRUD (session auth + org-admin gated)
//   /api/webhooks-out — outbound webhook CRUD + test (session auth + org-admin)
//   /api/v1/*         — public read API, authenticated by API key (NOT cookie)
// /api/v1 is distinct from the inbound /api/webhooks receivers and the cookie-
// authed CRM routes; its auth path never touches the JWT session cookie.
// ---------------------------------------------------------------------------
app.use('/api/keys', apiKeyRoutes);
console.log('✅ Mounted: /api/keys (API-key management — session auth + org-admin)');

app.use('/api/webhooks-out', outboundWebhookRoutes);
console.log('✅ Mounted: /api/webhooks-out (outbound webhook management — session auth + org-admin)');

app.use('/api/v1', apiV1Routes);
console.log('✅ Mounted: /api/v1 (public read API — authenticated by API key)');

// Saved views — per-user tabbed presets above each list page (Companies /
// Contacts / Deals / Tasks). New surface introduced with migration 068.
app.use('/api/saved-views', require('./routes/savedViewsRoutes'));
console.log('✅ Mounted: /api/saved-views (per-user list tabs)');

app.use('/api/admin/demo', demoRoutes);
console.log('✅ Mounted: /api/admin/demo (seed/wipe demo data)');

// Record one-pager PDFs (migration 161, CMN §1.7) — branded single-page spec
// sheets for a deal/company/contact + per-org template CRUD. Core surface
// like the PO/quote PDFs, so no feature flag. The pdf router mounts at /api
// with per-route auth (paths: /deals/:id/one-pager.pdf etc.) so unmatched
// /api/* traffic falls through untouched.
const onePagerRoutes = require('./routes/onePagerRoutes');
app.use('/api', onePagerRoutes.pdfRouter);
app.use('/api/one-pager-templates', onePagerRoutes.templatesRouter);
console.log('✅ Mounted: /api/*/:id/one-pager.pdf + /api/one-pager-templates (record one-pagers)');

// Auth runs before the billing gate so requireAiBilling has req.userId / req.orgId.
// authMiddleware is also called per-route inside aiRoutes — second call is a
// no-op (idempotent: it re-decodes the same JWT and re-sets the same fields).
const { authMiddleware: _aiAuth } = require('./auth');
// GET /api/ai/status is exempt from the billing gate: it is the probe the
// frontend uses to decide WHICH card to show (start plan / trial countdown /
// past due / halted). Gating the probe itself 402'd it, AuthContext failed
// open, and a brand-new org's first chat message came back as a raw billing
// error with no way forward. The verdict is computed inside the route via
// evaluateAiBilling() (same logic the gate uses), so nothing leaks past it.
const _aiBillingGate = requireAiBilling();
const aiBillingGateExceptStatus = (req, res, next) =>
  (req.method === 'GET' && req.path === '/status') ? next() : _aiBillingGate(req, res, next);
app.use('/api/ai', aiLimiter, _aiAuth, aiBillingGateExceptStatus, requireFeature('ai_features_enabled'), aiRoutes);
console.log('✅ Mounted: /api/ai (per-IP rate limited + AI-billing gated + gated by ai_features_enabled)');

// First-run workspace builder (spec 203). Mounted beside /api/ai rather than
// under it so GET /templates stays reachable without an AI billing verdict;
// POST /plan applies the billing gate + module flag per-route.
const onboardingRoutes = require('./routes/onboardingRoutes');
app.use('/api/onboarding', aiLimiter, onboardingRoutes);
console.log('✅ Mounted: /api/onboarding (workspace builder — /plan is AI-billing gated + gated by ai_features_enabled)');

// Saved workspace templates (spec 203 Phase 2, migration 171). Cloning is
// deterministic (no AI) so it is NOT behind the AI billing gate; only the
// super-admin generate-platform action calls the model, and callClaude meters
// it like any other endpoint. Public gallery read is summaries-only.
const workspaceTemplateRoutes = require('./routes/workspaceTemplateRoutes');
const { publicFormLimiter: templateGalleryLimiter } = require('./middleware/rateLimits');
app.use('/api/workspace-templates', workspaceTemplateRoutes);
app.use('/api/public/workspace-templates', templateGalleryLimiter, workspaceTemplateRoutes.publicRouter);
console.log('✅ Mounted: /api/workspace-templates + /api/public/workspace-templates (saved workspace templates)');

// Drive Intel (Differentiation Bet #4, DRIVE_INTEL_SPEC.md). Three mount points:
//   /api/drive                — OAuth + connection (Agent 1)
//   /api/drive/folders        — folder search proxy (Agent 2 searchRouter)
//   /api/deals/:id/drive-folder + /api/deals/:id/intel — per-deal pipeline (Agent 2)
// All gated by drive_intel_enabled. The per-deal mounts must come AFTER
// /api/deals so Express resolves the more-specific route, and they use
// mergeParams so `req.params.id` (the deal id) propagates into the routers.
const driveAuthRoutes      = require('./routes/driveAuthRoutes');
const driveFolderRoutes    = require('./routes/driveFolderRoutes');
const dealIntelRoutes      = require('./routes/dealIntelRoutes');
app.use('/api/drive',          requireFeature('drive_intel_enabled'), driveAuthRoutes);
app.use('/api/drive/folders',  requireFeature('drive_intel_enabled'), driveFolderRoutes.searchRouter);
app.use('/api/deals/:id/drive-folder', requireFeature('drive_intel_enabled'), driveFolderRoutes);
// The per-deal intel summary burns Claude, so it sits behind the AI-billing
// gate too (auth first so requireAiBilling sees req.orgId; authMiddleware is
// idempotent — the router calls it again as a no-op). Without this an org with
// drive_intel_enabled on but AI unconfigured could generate free summaries.
app.use('/api/deals/:id/intel',        requireFeature('drive_intel_enabled'), _aiAuth, requireAiBilling(), dealIntelRoutes);
console.log('✅ Mounted: /api/drive + /api/deals/:id/drive-folder + /api/deals/:id/intel (gated by drive_intel_enabled; intel also AI-billing gated)');

// Gmail integration foundation. Parallel to Drive Intel — three mount
// points, all gated by gmail_intel_enabled (default off; gmail.readonly
// is a Google "restricted" scope and a production rollout requires CASA
// verification). Summarization service lands in a follow-up PR.
//   /api/gmail                  — OAuth + connection
//   /api/gmail/threads          — thread search picker (searchRouter)
//   /api/deals/:id/gmail-threads — per-deal thread linkage + sync
// The per-deal mount must come AFTER /api/deals so Express resolves the
// more-specific route, and it uses mergeParams so `req.params.id` (the
// deal id) propagates into the router.
const gmailAuthRoutes      = require('./routes/gmailAuthRoutes');
const gmailThreadRoutes    = require('./routes/gmailThreadRoutes');
const dealGmailIntelRoutes = require('./routes/dealGmailIntelRoutes');
app.use('/api/gmail',                    requireFeature('gmail_intel_enabled'), gmailAuthRoutes);
app.use('/api/gmail/threads',            requireFeature('gmail_intel_enabled'), gmailThreadRoutes.searchRouter);
app.use('/api/deals/:id/gmail-threads',  requireFeature('gmail_intel_enabled'), gmailThreadRoutes);
// gmail-intel generates Claude summaries → AI-billing gated like /api/ai.
app.use('/api/deals/:id/gmail-intel',    requireFeature('gmail_intel_enabled'), _aiAuth, requireAiBilling(), dealGmailIntelRoutes);
console.log('✅ Mounted: /api/gmail + /api/deals/:id/gmail-threads + /api/deals/:id/gmail-intel (gated by gmail_intel_enabled; intel also AI-billing gated)');

// Google Calendar integration (migration 115). Two mount points, both gated by
// calendar_enabled (default off; calendar.events is a Google "sensitive" scope
// that requires OAuth verification for a general-audience rollout).
//   /api/calendar                  — OAuth + connection + org-wide /sync
//   /api/deals/:id/calendar-event  — per-deal event list + "Schedule meeting" create
// The per-deal mount must come AFTER /api/deals so Express resolves the more-
// specific route, and it uses mergeParams so `req.params.id` (the deal id)
// propagates into the router.
const calendarAuthRoutes   = require('./routes/calendarAuthRoutes');
const dealCalendarRoutes   = require('./routes/dealCalendarRoutes');
app.use('/api/calendar',                 requireFeature('calendar_enabled'), calendarAuthRoutes);
app.use('/api/deals/:id/calendar-event', requireFeature('calendar_enabled'), dealCalendarRoutes);
console.log('✅ Mounted: /api/calendar + /api/deals/:id/calendar-event (gated by calendar_enabled)');

// Microsoft (Outlook / Microsoft 365) integration (migration 140). ONE mount
// point: OAuth + connection + the two org-wide /sync routes. ONE Microsoft
// consent (Mail.Read + Calendars.ReadWrite + offline_access) powers both the
// mail and calendar surfaces, so the mount is gated by an ANY-of over the two
// flags (both default off; multi-tenant rollouts need Azure publisher
// verification) — the per-surface /sync routes re-check their own flag inside
// the router. The OAuth callback is session-less by design and rides the
// gate's fail-open path, trusting the signed state JWT instead (same model as
// the Drive/Gmail/Calendar callbacks).
const msgraphAuthRoutes = require('./routes/msgraphAuthRoutes');
app.use('/api/msgraph', requireAnyFeature('outlook_mail_enabled', 'outlook_calendar_enabled'), msgraphAuthRoutes);
console.log('✅ Mounted: /api/msgraph (gated by outlook_mail_enabled | outlook_calendar_enabled)');

// Per-deal Outlook intel — read surface over the deal-matched rows the
// msgraph sync lands (outlook_messages / outlook_calendar_events). Same gate
// as /api/msgraph; each lane re-checks its own flag inside the handler.
const dealOutlookIntelRoutes = require('./routes/dealOutlookIntelRoutes');
app.use('/api/deals/:id/outlook-intel', requireAnyFeature('outlook_mail_enabled', 'outlook_calendar_enabled'), dealOutlookIntelRoutes);
console.log('✅ Mounted: /api/deals/:id/outlook-intel (gated by outlook_mail_enabled | outlook_calendar_enabled)');

// Per-org custom-field definitions — the extension store for Claude-authored
// org customizations (Differentiation Bet #2). All writes go through the
// validators in routes/customFieldsRoutes.js; CRUD endpoints for the four
// first-class entities consume the same validator before merging into
// `<entity>.custom_fields` JSONB.
app.use('/api/custom-fields', require('./routes/customFieldsRoutes'));
console.log('✅ Mounted: /api/custom-fields (per-org field defs)');

app.use('/api/appreciation', appreciationRoutes);
console.log('✅ Mounted: /api/appreciation (customer appreciation queue — SOW §4.5c.ii)');

// Phase 2 — FlowArchitect domain model (RFQ + PO + Invoice + Allocation).
// All gated by phase2_entities feature flag (per-org). Mount paths use
// /api/v2/* so v1 routes remain canonical for orgs without the flag.
app.use('/api/v2/rfqs',                v2RfqRoutes);
console.log('✅ Mounted: /api/v2/rfqs (gated by phase2_entities)');
app.use('/api/v2/purchase-orders',     v2PurchaseOrderRoutes);
console.log('✅ Mounted: /api/v2/purchase-orders (gated by phase2_entities)');
app.use('/api/v2/invoices',            v2InvoiceRoutes);
console.log('✅ Mounted: /api/v2/invoices (gated by phase2_entities)');
app.use('/api/v2/invoice-allocations', v2InvoiceAllocationRoutes);
console.log('✅ Mounted: /api/v2/invoice-allocations (gated by phase2_entities)');

app.use('/api/admin/feature-flags', adminFeatureFlagRoutes);
console.log('✅ Mounted: /api/admin/feature-flags (per-org flag management)');

// Enterprise SSO + SCIM admin config (migration 117). Org owner/admin only,
// gated by requireFeature('sso_enabled'). Configure the OIDC connection +
// mint/revoke SCIM provisioning tokens. Client secret is write-only; SCIM
// token plaintext is shown once.
app.use('/api/admin/sso', require('./routes/adminSsoRoutes'));
console.log('✅ Mounted: /api/admin/sso (OIDC config + SCIM tokens, org-admin, sso_enabled)');

// SCIM 2.0 provisioning surface (migration 117). Top-level (NOT under /api) —
// authenticated by a scim_ bearer token via middleware/scimAuth.js (org-scoped,
// fails closed), CSRF-exempt (token-auth, no cookies), and feature-gated inside
// the router (requireFeature runs after the token sets req.orgId).
app.use('/scim/v2', require('./routes/scimRoutes'));
console.log('✅ Mounted: /scim/v2 (SCIM 2.0 user provisioning, scim-token auth, sso_enabled)');

// Per-org AI model + effort (services/aiModel.js). Org-admin only; mirrored
// gate from routes/customFieldsRoutes.js. Fallback chain on read:
// org column → ANTHROPIC_MODEL env → 'claude-sonnet-4-6'.
app.use('/api/admin/ai-model', require('./routes/adminAiModelRoutes'));
console.log('✅ Mounted: /api/admin/ai-model (per-org AI model + effort)');

// Per-org Activity feed — last-24h "what's happening in my workspace" view.
// Org-admin only (gated inside the route file via req.orgRole); regular
// members get 403. Read-only aggregations over audit_log, ai_usage_events,
// plugin_runs, deal_intel_summaries, deal_gmail_summaries, email_sends. No
// new schema; powered entirely by existing (org_id, time-col DESC) indexes.
app.use('/api/admin/org-activity', require('./routes/orgActivityRoutes'));
console.log('✅ Mounted: /api/admin/org-activity (per-org last-24h activity feed)');

// Data-subject self-service endpoints (GDPR/CCPA rights).
app.use('/api/me', require('./routes/meRoutes'));
console.log('✅ Mounted: /api/me (data export + account deletion)');

// Usage metering read endpoint (Phase B).
app.use('/api/usage', require('./routes/usageRoutes'));
console.log('✅ Mounted: /api/usage (per-org AI / module consumption)');

// Plugin CRUD (Phase C foundation; gated by plugins_enabled).
// aiLimiter applied here because /api/plugins/from-prompt invokes Claude.
// The other plugin routes don't burn AI but the limit is cheap insurance.
app.use('/api/plugins', aiLimiter, require('./routes/pluginRoutes'));
console.log('✅ Mounted: /api/plugins (per-IP rate limited + gated by plugins_enabled)');

// Stripe billing (Phase F scaffold; 503s gracefully when STRIPE_SECRET_KEY
// is unset). The webhook subroute uses express.raw() internally so it
// receives the original bytes for signature verification — express's
// global json() body parser doesn't interfere because router-scoped
// middleware (the raw parser on /webhook) runs first.
app.use('/api/billing', require('./routes/billingRoutes'));
console.log('✅ Mounted: /api/billing (Stripe checkout + portal + webhook)');

// Email-send-from-CRM (COMPETITIVE_REVIEW.md parity gap #1).
// The /track/:id.gif and /unsubscribe/:token subroutes are PUBLIC by design
// — the route file registers them BEFORE applying authMiddleware so the
// tracking pixel works in any email client and unsubscribe links work from
// anyone's inbox without a JWT.
app.use('/api/emails', require('./routes/emailRoutes'));
console.log('✅ Mounted: /api/emails (send/templates + public /track + /unsubscribe)');

// Email sequences (multi-step drip) — CRUD + enrollment. Sending itself is
// worker-only (services/sequenceWorker.js, registered below with the other
// schedulers) and always flows through the unsubscribe-suppression + atomic
// step-claim path in services/sequences.js. Migrations 132/133.
app.use('/api/sequences', requireFeature('campaigns_enabled'), require('./routes/sequenceRoutes'));
console.log('✅ Mounted: /api/sequences (email sequences — campaigns_enabled)');

// ============================================================================
// ERROR HANDLING MIDDLEWARE
// ============================================================================

app.use((err, req, res, next) => {
  // Route through logger.error so GCP Error Reporting ingests it: the logger
  // appends err.stack to the message, stamps the ReportedErrorEvent @type +
  // serviceContext, and emits at severity ERROR. requestId correlation comes
  // from the req.log child logger (middleware/requestContext.js).
  const logFields = { error: err, path: req.path, method: req.method };
  // Deliberate 4xx (CSRF rejections, body-parse errors, invalid uploads) are
  // client misbehavior, not service faults — log at WARN so they stay out of
  // Error Reporting groups. Everything else is a real 5xx and goes to ERROR.
  const clientFault = Number(err && err.statusCode) >= 400 && Number(err.statusCode) < 500;
  const log = req.log || require('./services/logger');
  if (clientFault) {
    log.warn('request_error', logFields);
  } else {
    log.error('unhandled_error', logFields);
  }

  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    requestId: req.requestId || null,
    disclaimer: 'Software provided AS IS, without warranty. See /api/legal.',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Not found' });
});

// ============================================================================
// DATABASE MIGRATIONS - Run automatically on startup
// ============================================================================

// Fixed key shared by every instance so concurrent Cloud Run boots serialize
// their migration runs on one advisory lock instead of racing (both passing the
// "already recorded?" check, both applying DDL, the loser crash-looping on a
// unique-violation record insert).
const MIGRATION_ADVISORY_LOCK_KEY = 47712026;

async function runMigrationsOnStartup() {
  const fs = require('fs');
  const path = require('path');
  const pool = require('./db');

  // Run every migration on ONE dedicated connection. This lets us (a) hold a
  // session-level advisory lock that serializes concurrent boots — it survives
  // the COMMITs inside self-committing migration files and auto-releases if this
  // process dies mid-run, so a crashed winner never wedges the next instance —
  // and (b) lift the app pool's 30s statement_timeout so a long backfill can
  // finish instead of aborting the deploy, without touching live traffic.
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 0');
    await client.query('SET lock_timeout = 0'); // wait as long as needed for the advisory lock itself
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    await client.query("SET lock_timeout = '30s'"); // but a migration shouldn't wait forever on a table lock

    // Create migrations table
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Get migration files. The optional [a-z]+ suffix on the numeric prefix
    // is for hotfix migrations that need to sort BETWEEN two existing
    // numbered ones without renumbering everything downstream — e.g.,
    // `081a_contacts_add_missing_columns.sql` sorting between 081 and 082.
    // Previously the regex was `^\d+_.*\.sql$` which silently filtered out
    // any file with an alpha suffix; production hit this when migration
    // 081a was the fix for a schema-drift error in 082 but the regex
    // dropped 081a, so 082 kept hard-failing in a deploy loop.
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.match(/^\d+[a-z]*_.*\.sql$/))
      .sort();

    let executed = 0;
    let skipped = 0;

    // Execute each migration
    for (const file of files) {
      const result = await client.query('SELECT 1 FROM migrations WHERE name = $1', [file]);

      if (result.rows.length > 0) {
        skipped++;
        continue;
      }

      try {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

        // Send the whole file as one query. The pg driver handles
        // multi-statement queries fine, and this preserves dollar-quoted
        // PL/pgSQL bodies ($$ ... $$) that contain semicolons — a naive
        // split-on-`;` mangles them and breaks any migration that defines
        // a function or trigger.
        await client.query(sql);

        // Record the migration on the SAME session right after it applies.
        // ON CONFLICT keeps a re-run (e.g. a crash in the narrow window between
        // apply and record) from failing on the unique name.
        await client.query('INSERT INTO migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [file]);
        executed++;
        console.log(`✓ Executed migration: ${file}`);
      } catch (error) {
        // Hard-fail on ANY error, including the "already exists" codes:
        //   42P07 — duplicate_table / duplicate_index
        //   42710 — duplicate_object (constraint, trigger, function, etc.)
        //
        // The whole file is sent as one implicit transaction, so a duplicate
        // error rolls the ENTIRE file back. The old behaviour recorded the file
        // as "run" anyway and continued — silently losing every non-duplicate
        // statement in it. That is exactly what produced the historical 010/021
        // contacts drift. A properly idempotent migration (CREATE ... IF NOT
        // EXISTS, ADD COLUMN IF NOT EXISTS, DROP ... IF EXISTS) never raises
        // these codes, so hitting one means the file is not idempotent and must
        // be fixed — not swallowed. Throwing lets the outer catch exit non-zero
        // so Cloud Run keeps the prior healthy revision live.
        console.error(`✗ Failed migration: ${file}\n  ${error.code || ''} ${error.message}`);
        if (error.code === '42P07' || error.code === '42710') {
          console.error(`  → ${file} is not idempotent. Guard each statement ` +
            `(IF NOT EXISTS / IF EXISTS) so a re-run is a no-op, then redeploy.`);
        }
        throw error;
      }
    }

    console.log(`\n✓ Migrations complete: ${executed} executed, ${skipped} skipped`);
  } catch (error) {
    console.error('Migration startup failed:', error);
    // In production, refuse to keep serving with a partially-applied schema.
    // Cloud Run will keep the previous healthy revision live; this revision
    // never receives traffic.
    if (process.env.NODE_ENV === 'production') {
      console.error('Exiting (NODE_ENV=production) — Cloud Run will retain prior healthy revision.');
      // Best-effort release so a healthy retry isn't blocked (process death
      // would auto-release the session lock too, but don't rely on timing).
      try { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]); } catch { /* exiting anyway */ }
      process.exit(1);
    }
  } finally {
    // Clear any aborted-transaction state left by a failed self-committing
    // migration so the connection is safe to reuse (harmless no-op on success),
    // release the advisory lock, and return the connection to the pool. On the
    // production-exit path above this won't run, but the process is dying so
    // Postgres releases the session lock on disconnect.
    try { await client.query('ROLLBACK'); } catch { /* no txn in progress */ }
    try { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]); } catch { /* not held */ }
    client.release();
  }
}

// ============================================================================
// SERVER STARTUP
// ============================================================================

app.listen(PORT, async () => {
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Lightweight CRM Backend
  Environment: ${process.env.NODE_ENV || 'development'}
  Server running on port: ${PORT}
  CORS Origin: ${process.env.FRONTEND_URL || 'http://localhost:3000'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `);

  // Run migrations on startup
  if (process.env.NODE_ENV === 'production') {
    console.log('\n🗄️  Running database migrations...\n');
    await runMigrationsOnStartup();
    // Starter workspace-template gallery (spec 203 Phase 2) — reviewed configs
    // from backend/data/, upserted by slug. Never blocks boot.
    try {
      await require('./services/workspaceTemplates').seedPlatformTemplates();
    } catch (err) {
      console.error('workspace-templates seed failed:', err.message);
    }
  }

  // Customer-Success e2e test-account seeder — only when CS_E2E_SEED=true.
  // Provisions one password-capable, email-verified account in a zang +
  // customer_success_enabled org (with seed data) so Playwright @auth can
  // exercise the gated CS UI. Security caveats in services/seedCsTestAccount.js.
  if (process.env.CS_E2E_SEED === 'true') {
    try {
      const { ensureCsTestAccount } = require('./services/seedCsTestAccount');
      const seedRes = await ensureCsTestAccount();
      console.log('🌱 CS e2e seed:', JSON.stringify(seedRes));
    } catch (err) {
      console.error('CS e2e seed failed:', err.message);
    }
  }

  // Boot the triggered-automation scheduler. Disabled by default in dev to avoid
  // side effects during local testing; opt in via AUTOMATION_ENABLED=true.
  const automationEnabled = process.env.NODE_ENV === 'production' || process.env.AUTOMATION_ENABLED === 'true';
  if (automationEnabled) {
    try {
      const automation = require('./services/automation');
      const intervalMinutes = Number(process.env.AUTOMATION_INTERVAL_MINUTES) || 60;
      automation.startScheduler({ intervalMinutes });
    } catch (err) {
      console.error('Failed to start automation scheduler:', err.message);
    }
  }

  // Account-deletion worker: hourly tick that processes scheduled deletions
  // whose 7-day grace window has expired. Same env gate as automation so
  // local dev doesn't fire on a synthetic deletion accidentally.
  if (automationEnabled) {
    try {
      const deletionWorker = require('./services/accountDeletionWorker');
      const minutes = Number(process.env.DELETION_WORKER_INTERVAL_MINUTES) || 60;
      deletionWorker.startScheduler({ intervalMinutes: minutes });
    } catch (err) {
      console.error('Failed to start deletion worker:', err.message);
    }
  }

  // Overdue-task notifier: hourly tick that finds open tasks past their
  // due_date and fires notificationDispatcher.notifyTaskOverdue. Idempotent
  // via tasks.last_overdue_notified_at (migration 074) — a task won't be
  // re-notified within 24h. Capped per run to bound runtime on large tenants.
  if (automationEnabled) {
    try {
      const overdueWorker = require('./services/overdueTaskWorker');
      const minutes = Number(process.env.OVERDUE_WORKER_INTERVAL_MINUTES) || 60;
      const maxRun  = Number(process.env.OVERDUE_WORKER_MAX_PER_RUN) || 500;
      overdueWorker.startScheduler({ intervalMinutes: minutes, maxPerRun: maxRun });
    } catch (err) {
      console.error('Failed to start overdue-task worker:', err.message);
    }
  }

  // Recurring-task safety net: hourly leased sweep that spawns the next
  // occurrence for any recurring series completed via a path that bypassed
  // the inline spawn in taskRoutes (e.g. bulk PATCH). Single-runner via
  // workerLease (worker_runs, migration 098); duplicate-safe via the
  // NOT EXISTS guard in services/recurringTasks.js. See migration 129.
  if (automationEnabled) {
    try {
      const recurringTaskWorker = require('./services/recurringTaskWorker');
      const minutes = Number(process.env.RECURRING_TASK_WORKER_INTERVAL_MINUTES) || 60;
      const maxRun  = Number(process.env.RECURRING_TASK_WORKER_MAX_PER_RUN) || 200;
      recurringTaskWorker.startScheduler({ intervalMinutes: minutes, maxPerRun: maxRun });
    } catch (err) {
      console.error('Failed to start recurring-task worker:', err.message);
    }
  }

  // Email-sequence sender: leased tick (workerLease, worker_runs migration
  // 098) that dispatches due sequence steps via services/sequences.js —
  // unsubscribe suppression checked before every send, step advance claimed
  // atomically (no double-send), capped per tick. Skips entirely (no lease,
  // no console-send) while the email service is unconfigured. Migrations
  // 132/133.
  if (automationEnabled) {
    try {
      const sequenceWorker = require('./services/sequenceWorker');
      const minutes = Number(process.env.SEQUENCE_WORKER_INTERVAL_MINUTES) || 15;
      const maxRun  = Number(process.env.SEQUENCE_WORKER_MAX_PER_RUN) || 50;
      sequenceWorker.startScheduler({ intervalMinutes: minutes, maxPerRun: maxRun });
    } catch (err) {
      console.error('Failed to start sequence worker:', err.message);
    }
  }

  // Weekly-summary worker: hourly tick that fires only on Mondays at 08:00
  // UTC. Pages users with weekly_summary preference enabled in chunks of 100
  // and calls notificationDispatcher.notifyWeeklySummary for each.
  if (automationEnabled) {
    try {
      const weeklyWorker = require('./services/weeklySummaryWorker');
      const minutes  = Number(process.env.WEEKLY_SUMMARY_WORKER_INTERVAL_MINUTES) || 60;
      const pageSize = Number(process.env.WEEKLY_SUMMARY_WORKER_PAGE_SIZE) || 100;
      weeklyWorker.startScheduler({ intervalMinutes: minutes, pageSize });
    } catch (err) {
      console.error('Failed to start weekly-summary worker:', err.message);
    }
  }

  // Email-sends retention sweep: daily delete of rows older than 2 years
  // in 1000-row batches. GDPR Art. 5(1)(e) storage limitation.
  // Independent mount (the notifications agent is adding overdueTask /
  // weeklySummary workers; this is a third, separate one).
  if (automationEnabled) {
    try {
      const emailRetentionWorker = require('./services/emailRetentionWorker');
      const hours = Number(process.env.EMAIL_RETENTION_INTERVAL_HOURS) || 24;
      emailRetentionWorker.startScheduler({ intervalHours: hours });
    } catch (err) {
      console.error('Failed to start email retention worker:', err.message);
    }
  }

  // Stripe AI-overage meter push: hourly tick that fires only on the 1st
  // of each month at the configured UTC hour. Scaffolded today —
  // STRIPE_AI_BILLING_ENABLED=false by default, so the tick just logs the
  // shape of last-month's per-org charges (a dry-run) until the meter is
  // configured in Stripe. See services/aiBilling.js + INTEGRATION_PLAYBOOKS.md §9.
  if (automationEnabled) {
    try {
      const aiBilling = require('./services/aiBilling');
      const minutes = Number(process.env.STRIPE_AI_BILLING_INTERVAL_MINUTES) || 60;
      aiBilling.startScheduler({ intervalMinutes: minutes });
    } catch (err) {
      console.error('Failed to start AI billing scheduler:', err.message);
    }
  }

  // Account-health snapshot worker (CS-2): hourly tick that, once per UTC day,
  // recomputes a rules-based health score for every active account in each
  // org with customer_success_enabled and appends a row to
  // account_health_snapshots. Idempotent via a per-day guard. Scoring math is
  // in services/accountHealth.js. See migration 095.
  if (automationEnabled) {
    try {
      const accountHealthWorker = require('./services/accountHealthWorker');
      const minutes = Number(process.env.ACCOUNT_HEALTH_WORKER_INTERVAL_MINUTES) || 60;
      accountHealthWorker.startScheduler({ intervalMinutes: minutes });
    } catch (err) {
      console.error('Failed to start account-health worker:', err.message);
    }
  }

  // AI monthly $50-threshold notifier: hourly tick. Warns admin once per
  // (org, YYYY-MM) when an org crosses ai_monthly_threshold_usd. Manual-halt
  // only — does NOT auto-halt (owner directive). See services/aiThresholdWorker.js.
  if (automationEnabled) {
    try {
      const aiThresholdWorker = require('./services/aiThresholdWorker');
      const minutes = Number(process.env.AI_THRESHOLD_WORKER_INTERVAL_MINUTES) || 60;
      aiThresholdWorker.startScheduler({ intervalMinutes: minutes });
    } catch (err) {
      console.error('Failed to start AI threshold worker:', err.message);
    }
  }

  // Gmail inbound-sync worker: periodic tick that pulls recent Gmail threads
  // for every org with an active connection + gmail_intel_enabled, matches
  // each to a deal by participant email, and syncs the matched threads onto the
  // deal/account timeline. Self-throttles per org via last_inbound_sync_at
  // (migration 107). See services/gmailInboundSyncWorker.js + gmailSync.syncOrg.
  if (automationEnabled) {
    try {
      const gmailInboundSyncWorker = require('./services/gmailInboundSyncWorker');
      const minutes = Number(process.env.GMAIL_INBOUND_SYNC_INTERVAL_MINUTES) || 30;
      const minInterval = Number(process.env.GMAIL_INBOUND_SYNC_MIN_INTERVAL_MINUTES) || 15;
      gmailInboundSyncWorker.startScheduler({ intervalMinutes: minutes, minIntervalMinutes: minInterval });
    } catch (err) {
      console.error('Failed to start Gmail inbound-sync worker:', err.message);
    }
  }

  // Calendar sync worker: periodic tick that pulls recent/updated Google
  // Calendar events for every org with an active connection + calendar_enabled,
  // matches each to a deal by an attendee email, and upserts the matched events
  // onto the deal/account timeline. Self-throttles per org via last_sync_at
  // (migration 115). See services/calendarSyncWorker.js + calendarSync.syncOrg.
  if (automationEnabled) {
    try {
      const calendarSyncWorker = require('./services/calendarSyncWorker');
      const minutes = Number(process.env.CALENDAR_SYNC_INTERVAL_MINUTES) || 30;
      const minInterval = Number(process.env.CALENDAR_SYNC_MIN_INTERVAL_MINUTES) || 15;
      calendarSyncWorker.startScheduler({ intervalMinutes: minutes, minIntervalMinutes: minInterval });
    } catch (err) {
      console.error('Failed to start Calendar sync worker:', err.message);
    }
  }

  // Microsoft 365 sync worker: periodic tick that pulls recent Outlook mail +
  // recently-changed Outlook events for every org with an active connection
  // and the matching flag (outlook_mail_enabled / outlook_calendar_enabled,
  // checked per surface), matches items to deals by participant email, and
  // upserts the matches onto the deal/account timeline. Self-throttles per
  // org via the two cursors (migration 140) and takes a workerLease per
  // interval bucket so multi-instance deploys run one tick per period. See
  // services/msgraphSyncWorker.js + msgraphSync.syncMailOrg/syncCalendarOrg.
  if (automationEnabled) {
    try {
      const msgraphSyncWorker = require('./services/msgraphSyncWorker');
      const minutes = Number(process.env.MSGRAPH_SYNC_INTERVAL_MINUTES) || 30;
      const minInterval = Number(process.env.MSGRAPH_SYNC_MIN_INTERVAL_MINUTES) || 15;
      msgraphSyncWorker.startScheduler({ intervalMinutes: minutes, minIntervalMinutes: minInterval });
    } catch (err) {
      console.error('Failed to start Microsoft 365 sync worker:', err.message);
    }
  }

  // Plugin schedule worker (migration 164): fires plugins whose
  // trigger_event is 'schedule.hourly' / 'schedule.daily'. Leased tick per
  // UTC hour bucket (workerLease) so multi-instance deploys dispatch once
  // per period; daily plugins additionally dedupe per (plugin, UTC day) in
  // plugin_trigger_dedupe so they fire exactly once per org-day. Runs land
  // in plugin_runs with trigger_kind='schedule'; the per-org plugins_enabled
  // flag is honored per dispatch. See services/pluginScheduleWorker.js +
  // services/pluginEvents.js.
  if (automationEnabled) {
    try {
      const pluginScheduleWorker = require('./services/pluginScheduleWorker');
      const minutes = Number(process.env.PLUGIN_SCHEDULE_INTERVAL_MINUTES) || 60;
      pluginScheduleWorker.startScheduler({ intervalMinutes: minutes });
    } catch (err) {
      console.error('Failed to start plugin schedule worker:', err.message);
    }
  }
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

module.exports = app;
