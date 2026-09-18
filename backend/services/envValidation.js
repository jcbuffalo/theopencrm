// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Boot-time environment validation.
//
// Fail-fast principle: in production, the container should refuse to start if
// any required env var is missing. Better to crash the deploy than to ship a
// broken auth flow that only fails when someone tries to use it.
//
// `validateEnv()` is called from index.js startup. It:
//   • returns a status report of every var we care about
//   • throws (fails container boot) if a REQUIRED var is missing in production
//   • logs a clear warning for OPTIONAL integrations that aren't configured

const REQUIRED = [
  { name: 'JWT_SECRET',                purpose: 'JWT signing key — generate with `openssl rand -base64 64`' },
  { name: 'COOKIE_SECRET',             purpose: 'Cookie signing key for httpOnly auth cookie + CSRF — generate with `openssl rand -base64 64`' },
  { name: 'CSRF_SECRET',               purpose: 'csrf-csrf double-submit secret — generate with `openssl rand -base64 64`' },
  { name: 'JWT_2FA_SECRET',            purpose: 'Short-lived tempToken signing key for the 2FA challenge step — generate with `openssl rand -base64 64`' },
  { name: 'DB_USER',                   purpose: 'Cloud SQL user' },
  { name: 'DB_PASSWORD',               purpose: 'Cloud SQL password' },
  { name: 'DB_NAME',                   purpose: 'Database name' },
  { name: 'INSTANCE_CONNECTION_NAME',  purpose: 'Cloud SQL Auth Proxy connection (project:region:instance)' },
  { name: 'FRONTEND_URL',              purpose: 'CORS allow-list (comma-separated for multi-origin)' },
];

// Optional but heavily-used. Missing one of these doesn't fail boot, but we
// warn loudly so you know features are silently degraded.
const OPTIONAL = [
  { name: 'GOOGLE_CLIENT_ID',          purpose: 'Google Sign-In; without this, /api/auth/google-signin returns 500' },
  { name: 'GMAIL_USER',                purpose: 'Outbound email via Gmail (with GMAIL_APP_PASSWORD)' },
  { name: 'GMAIL_APP_PASSWORD',        purpose: 'Outbound email via Gmail (with GMAIL_USER)' },
  { name: 'SENDGRID_API_KEY',          purpose: 'Outbound email via SendGrid (alt to Gmail)' },
  { name: 'GCS_DOCUMENTS_BUCKET',      purpose: 'Document storage; missing → uploads only fall back to DB blobs' },
  { name: 'ANTHROPIC_API_KEY',         purpose: 'Claude AI features (summarize / draft); buttons return graceful "not configured" message when missing' },
  { name: 'QB_CLIENT_ID',              purpose: 'QuickBooks OAuth' },
  { name: 'QB_CLIENT_SECRET',          purpose: 'QuickBooks OAuth' },
  { name: 'QB_REDIRECT_URI',           purpose: 'QuickBooks OAuth callback URL' },
  // drive_intel — see DRIVE_INTEL_SPEC.md. All four must be present for the
  // Drive integration to enable; missing any one causes /api/drive/* routes
  // to 503 with a clear "not configured" message (graceful-degradation
  // pattern, mirror of email/QB).
  { name: 'GOOGLE_DRIVE_CLIENT_ID',       purpose: 'drive_intel — Google OAuth client ID for the Drive integration (separate from the Sign-In client)' },
  { name: 'GOOGLE_DRIVE_CLIENT_SECRET',   purpose: 'drive_intel — Google OAuth client secret for the Drive integration' },
  { name: 'GOOGLE_DRIVE_REDIRECT_URI',    purpose: 'drive_intel — OAuth callback URL, e.g. https://api.theopencrm.com/api/drive/auth/callback' },
  { name: 'DRIVE_TOKEN_ENCRYPTION_KEY',   purpose: 'drive_intel — 32-byte AES-256-GCM key (base64) for refresh-token encryption at rest; generate with `openssl rand -base64 32`' },
];

function validateEnv() {
  const isProduction = process.env.NODE_ENV === 'production';
  const report = {
    environment: process.env.NODE_ENV || 'development',
    required: {},
    optional: {},
    integrations: {},
  };

  // ----- REQUIRED -----
  const missing = [];
  for (const v of REQUIRED) {
    const value = process.env[v.name];
    const present = !!value && String(value).length > 0;
    report.required[v.name] = present;
    if (!present) missing.push(v);
  }

  // Special case: JWT_SECRET present but using the placeholder default
  if (process.env.JWT_SECRET === 'your-secret-key') {
    missing.push({ name: 'JWT_SECRET', purpose: 'JWT_SECRET is set to the placeholder default — replace with a real secret' });
    report.required.JWT_SECRET = false;
  }

  // ----- OPTIONAL -----
  for (const v of OPTIONAL) {
    const present = !!process.env[v.name];
    report.optional[v.name] = present;
  }

  // ----- INTEGRATION ROLLUP (what's actually working) -----
  report.integrations = {
    google_oauth:  !!process.env.GOOGLE_CLIENT_ID,
    email:         !!(process.env.SENDGRID_API_KEY || (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)),
    gcs:           !!process.env.GCS_DOCUMENTS_BUCKET,
    ai:            !!process.env.ANTHROPIC_API_KEY,
    quickbooks:    !!(process.env.QB_CLIENT_ID && process.env.QB_CLIENT_SECRET && process.env.QB_REDIRECT_URI),
    teams_webhook: !!process.env.TEAMS_WEBHOOK_SECRET,
    zoom_webhook:  !!process.env.ZOOM_WEBHOOK_SECRET_TOKEN,
    drive_intel:   !!(process.env.GOOGLE_DRIVE_CLIENT_ID && process.env.GOOGLE_DRIVE_CLIENT_SECRET && process.env.GOOGLE_DRIVE_REDIRECT_URI && process.env.DRIVE_TOKEN_ENCRYPTION_KEY),
  };

  // ----- DECIDE -----
  if (missing.length > 0 && isProduction) {
    const detail = missing.map(m => `  • ${m.name} — ${m.purpose}`).join('\n');
    const err = new Error(`FATAL: missing required env vars in production:\n${detail}\n\nFix with: gcloud run services update <service> --update-env-vars="VAR=value" --region us-central1`);
    err.report = report;
    err.missing = missing;
    throw err;
  } else if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`⚠️  Required env vars missing (running in dev — would refuse to boot in production):`);
    for (const m of missing) console.warn(`     • ${m.name} — ${m.purpose}`);
  }

  // Optional integrations: warn for the most-used ones if they're absent.
  const opticallyImportant = ['GOOGLE_CLIENT_ID'];
  for (const name of opticallyImportant) {
    if (!process.env[name]) {
      // eslint-disable-next-line no-console
      console.warn(`⚠️  ${name} not set — features that depend on it will fail gracefully but won't work.`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`✓ Env validation passed. Integrations: ${JSON.stringify(report.integrations)}`);
  return report;
}

module.exports = { validateEnv, REQUIRED, OPTIONAL };
