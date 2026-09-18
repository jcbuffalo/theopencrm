// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Per-org feature flag service.
//
// Reads from organizations.features JSONB. 30-second in-process cache so the
// hot path doesn't query Postgres on every request. Cache is per-pod, which
// means a flag flip propagates within ~30s across all pods — acceptable for
// this use case.
//
// DEFAULTS ARE PROFILE-AWARE (Aug 2026). A flag's `defaultValue` is the
// default for a vanilla (generic / jcp / rin / NULL-profile) org. A flag may
// additionally carry `profileDefaults: { zang: true }` — the Zang
// manufacturer's-rep modules (customer quotes, vendor RFQs, submittals,
// change orders) default ON only for `zang` orgs and OFF for everyone else,
// so a fresh self-serve workspace starts lightweight. Existing orgs were
// pinned to their prior effective defaults by migration 153, so the flip
// only ever affects NEW orgs.

const pool = require('../db');

const TTL_MS = 30_000;
const cache = new Map(); // orgId → { features, profile, expiresAt }

// One cached read per org: the features JSONB plus the org's white-label
// profile (needed to resolve profile-aware defaults). Mocked pools in tests
// commonly return only `{ features }` — a missing profile resolves as generic.
async function getOrgFlagContext(orgId) {
  if (!orgId) return { features: {}, profile: null };
  const cached = cache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const r = await pool.query('SELECT features, profile FROM organizations WHERE id = $1', [orgId]);
  const row = r.rows[0] || {};
  const entry = {
    features: row.features || {},
    profile: row.profile || null,
    expiresAt: Date.now() + TTL_MS,
  };
  cache.set(orgId, entry);
  return entry;
}

async function getFeatures(orgId) {
  const ctx = await getOrgFlagContext(orgId);
  return ctx.features;
}

async function hasFeature(orgId, name) {
  if (!orgId) return false;
  const { features, profile } = await getOrgFlagContext(orgId);
  // Explicit setting wins. A MISSING key means "use the flag's registered
  // default for this org's profile" — NOT "off". This matches the
  // effective-value computation the admin Modules UI displays
  // (routes/adminFeatureFlagRoutes.js), so what the admin screen shows is
  // what the gates enforce. Unknown flag names resolve to false.
  if (Object.prototype.hasOwnProperty.call(features, name)) return Boolean(features[name]);
  return defaultFor(name, profile);
}

async function setFeature(orgId, name, value) {
  // jsonb_set takes a path array as text, e.g. '{phase2_entities}' for
  // top-level key. The third arg must be valid JSON; we serialize the value.
  await pool.query(
    `UPDATE organizations
        SET features = jsonb_set(COALESCE(features, '{}'::jsonb), $1::text[], $2::jsonb, TRUE),
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $3`,
    [[name], JSON.stringify(Boolean(value)), orgId]
  );
  cache.delete(orgId);
}

async function unsetFeature(orgId, name) {
  await pool.query(
    `UPDATE organizations
        SET features = features - $1,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $2`,
    [name, orgId]
  );
  cache.delete(orgId);
}

// Used by the admin UI / scripts to discover registered flag names.
//
// Every entry carries:
//   name          — the JSONB key in organizations.features
//   category      — legacy grouping used by chat tooling:
//                     "platform"  internal phase rollouts / architecture toggles
//                     "module"    user-facing modules an org admin can turn on/off
//                     "tier"      features historically gated by plan
//   scope         — WHO may toggle it:
//                     "org"       any org owner/admin (their own org) or a super-admin
//                     "platform"  platform super-admins only; hidden from org admins
//   group         — the plain-English section on the Modules page:
//                     Sell · Customers · Insights · Integrations · Platform
//   label         — plain-English name shown to org owners
//   oneLiner      — one plain-English sentence: what turning it on gives you
//   description   — the engineer-facing detail (routes, migrations, caveats)
//   defaultValue  — default for a vanilla org (generic / jcp / rin / no profile)
//   profileDefaults (optional) — per-profile default overrides, e.g. { zang: true }
//
// When adding a flag here: also add a `requireFeature(<name>)` gate on the
// corresponding backend route(s) so disabling it actually hides the surface.
const KNOWN_FLAGS = [
  // ---- PLATFORM ----------------------------------------------------------
  {
    name: 'phase2_entities',
    category: 'platform',
    scope: 'platform',
    group: 'Platform',
    label: 'Phase-2 order entities',
    oneLiner: 'Adds RFQ, purchase-order, invoice and allocation records (advanced rollout).',
    description: 'Enable RFQ, Purchase Order, Invoice, and Invoice Allocation entities (FlowArchitect domain model).',
    defaultValue: false,
  },
  {
    name: 'v2_dual_write_enabled',
    category: 'platform',
    scope: 'platform',
    group: 'Platform',
    label: 'Phase-2 dual write',
    oneLiner: 'Mirrors deal lifecycle changes into the phase-2 entities in the same transaction.',
    description: 'When deals move through their lifecycle, populate the matching v2 entities (RFQ/PO/Invoice) inside the same transaction. Default off — flip after backfill + 1 night of clean reconciliation.',
    defaultValue: false,
  },

  // ---- MODULES (org admin can toggle) ------------------------------------
  // -- Sell ---------------------------------------------------------------
  {
    name: 'leads_enabled',
    category: 'module',
    scope: 'org',
    group: 'Sell',
    label: 'Leads & capture forms',
    oneLiner: 'A pre-qualification lead board, round-robin assignment, and public web forms that feed it.',
    description: 'Leads module (/api/leads, /api/lead-forms): pre-qualification lead board, round-robin assignment, lead→contact/deal conversion, and public lead-capture forms (/api/public/lead-forms/:token). Disabling also 404s the org\'s public capture forms.',
    defaultValue: true,
  },
  {
    name: 'products_enabled',
    category: 'module',
    scope: 'org',
    group: 'Sell',
    label: 'Products & quotes',
    oneLiner: 'A product catalog and a line-item quote builder with branded PDF quotes.',
    description: 'Generic product catalog + light-CPQ line-item quote builder (/api/products, /api/sales-quotes). The vanilla quoting surface for generic/jcp/rin orgs — separate from the bespoke Zang quotes workflow. Server-authoritative totals + branded PDF.',
    defaultValue: true,
  },
  {
    name: 'documents_enabled',
    category: 'module',
    scope: 'org',
    group: 'Sell',
    label: 'Documents & attachments',
    oneLiner: 'Upload files against deals and companies and share them by secure link.',
    description: 'Document upload + GCS storage module (/api/documents). Disable if your tier does not include attachments.',
    defaultValue: true,
  },
  {
    name: 'quotes_enabled',
    category: 'module',
    scope: 'org',
    group: 'Sell',
    label: 'Rep-agency customer quotes',
    oneLiner: 'The manufacturer\'s-rep customer-quote workflow with revisions and quote PDFs (Zang-style).',
    description: 'Customer quote module (/api/quotes). Generates branded quote PDFs, tracks revisions. Part of the manufacturer\'s-rep (Zang) workflow — default ON for zang orgs only.',
    defaultValue: false,
    profileDefaults: { zang: true },
  },
  {
    name: 'vendor_quotes_enabled',
    category: 'module',
    scope: 'org',
    group: 'Sell',
    label: 'Vendor RFQs & quote comparison',
    oneLiner: 'Send RFQs to multiple vendors and compare their pricing side by side (Zang-style).',
    description: 'Vendor RFQ + quote comparison module (/api/vendor-quotes). Multi-vendor pricing with selected-winner workflow. Part of the manufacturer\'s-rep (Zang) workflow — default ON for zang orgs only.',
    defaultValue: false,
    profileDefaults: { zang: true },
  },
  {
    name: 'submittals_enabled',
    category: 'module',
    scope: 'org',
    group: 'Sell',
    label: 'Submittals',
    oneLiner: 'Track drawing and spec approval cycles between vendor, rep and customer (Zang-style).',
    description: 'Submittals module (/api/submittals). Drawing/spec approval cycles between vendor → Zang → customer. Part of the manufacturer\'s-rep (Zang) workflow — default ON for zang orgs only.',
    defaultValue: false,
    profileDefaults: { zang: true },
  },
  {
    name: 'change_orders_enabled',
    category: 'module',
    scope: 'org',
    group: 'Sell',
    label: 'Change orders',
    oneLiner: 'Approval-gated price and scope changes after an order is placed (Zang-style).',
    description: 'Change orders module (/api/change-orders). Approval-gated price/scope adjustments after order. Part of the manufacturer\'s-rep (Zang) workflow — default ON for zang orgs only.',
    defaultValue: false,
    profileDefaults: { zang: true },
  },

  // -- Customers ----------------------------------------------------------
  {
    name: 'customer_success_enabled',
    category: 'module',
    scope: 'org',
    group: 'Customers',
    label: 'Customer success',
    oneLiner: 'Account 360, health scores, renewals, playbooks, cases, surveys and segments for the post-sale side.',
    description: 'Post-sale customer-success module (CS-1..CS-10): account-360 timeline (/api/accounts/:id/360), rules-based account health scoring, and the service-contract renewals pipeline. Aggregates activities, tasks, deals, issues, emails, and Gmail intel by company. Core to full-lifecycle relationship management — default ON.',
    defaultValue: true,
  },
  {
    name: 'campaigns_enabled',
    category: 'tier',
    scope: 'org',
    group: 'Customers',
    label: 'Email sequences',
    oneLiner: 'Multi-step drip emails with per-step delays, enrollment and unsubscribe handling.',
    description: 'Email sequences (multi-step drip campaigns) — /api/sequences + the leased sequenceWorker sender. Ordered steps with per-step delays, contact enrollment, unsubscribe suppression, and email_sends tracking. See migrations 132/133.',
    defaultValue: true,
  },
  {
    name: 'portal_enabled',
    category: 'module',
    scope: 'org',
    group: 'Customers',
    label: 'Customer portal',
    oneLiner: 'Share a secure link so a customer can see their own deals, quotes, documents and open a support case.',
    description: 'Customer Portal (migration 141): token-scoped read-only external account view. Org admins mint shareable 192-bit-token links (/portal/:token) that let a customer contact see ONE company\'s whitelisted data — profile basics, deal names/stages/values, quotes/invoices, and document downloads via signed URLs. No internal notes or AI scores ever leave. Default OFF — ships inert; flipping it on exposes both the admin token-management surface (/api/portal) and the org\'s public portal links.',
    defaultValue: false,
  },

  // -- Insights -----------------------------------------------------------
  {
    name: 'reports_enabled',
    category: 'module',
    scope: 'org',
    group: 'Insights',
    label: 'Reports & forecasting',
    oneLiner: 'Hit rate, funnel, forecast, commission and the custom report builder.',
    description: 'Advanced reports (/api/metrics/reports, /api/reports, /api/forecast, /api/commission): hit-rate, funnel, per-salesman, per-vendor leaderboard, custom report builder.',
    defaultValue: true,
  },
  {
    name: 'ai_features_enabled',
    category: 'module',
    scope: 'org',
    group: 'Insights',
    label: 'AI copilot',
    oneLiner: 'The chat copilot, deal summaries and follow-up drafts. Billed by usage (or bring your own key).',
    description: 'Claude-powered AI features (/api/ai): chat copilot, summarize activities, draft follow-up emails. Counts against the org\'s AI usage.',
    defaultValue: true,
  },
  {
    name: 'automation_enabled',
    category: 'module',
    scope: 'org',
    group: 'Insights',
    label: 'Automations',
    oneLiner: '"When this happens, do that" rules plus the built-in stale-deal and renewal alerts.',
    description: 'Triggered automation engine (/api/automation, /api/automation-rules). Auto-fires rules on stage transitions, schedules, etc.',
    defaultValue: true,
  },
  {
    name: 'plugins_enabled',
    category: 'tier',
    scope: 'org',
    group: 'Insights',
    label: 'Plugins',
    oneLiner: 'Build small sandboxed tools for your workspace in plain English, or pick one from the library.',
    description: 'User-built plugins. See PLUGIN_PLATFORM_VISION.md. Default off.',
    defaultValue: false,
  },

  // -- Integrations -------------------------------------------------------
  {
    name: 'quickbooks_enabled',
    category: 'module',
    scope: 'org',
    group: 'Integrations',
    label: 'QuickBooks Online',
    oneLiner: 'Create QuickBooks invoices when a deal is invoiced.',
    description: 'QuickBooks Online integration (/api/quickbooks). Creates invoices in QB on INVOICED transition.',
    defaultValue: false,
  },
  {
    name: 'webhooks_enabled',
    category: 'module',
    scope: 'org',
    group: 'Integrations',
    label: 'Meeting webhooks (Teams / Zoom)',
    oneLiner: 'Receive meeting logs from Teams, Zoom or a generic webhook and attach them to deals.',
    description: 'Inbound webhook receivers (/api/webhooks) for Teams / Zoom / generic meeting logs.',
    defaultValue: false,
  },
  {
    name: 'calendar_enabled',
    category: 'module',
    scope: 'org',
    group: 'Integrations',
    label: 'Google Calendar',
    oneLiner: 'Sync Google Calendar meetings onto the deal timeline and create events from deals.',
    description: 'Google Calendar integration (migration 115): syncs meetings to the deal/account timeline (matched by attendee email) and creates calendar events from deals (POST /api/deals/:id/calendar-event). Requests the calendar.events OAuth scope — a Google "sensitive" (not "restricted") scope, so it needs OAuth verification but NOT the annual CASA assessment Gmail requires. Default off — flip on for orgs whose OAuth client has cleared Google verification, or single-tenant deployments that own the Google Cloud project.',
    defaultValue: false,
  },
  {
    name: 'gmail_intel_enabled',
    category: 'module',
    scope: 'org',
    group: 'Integrations',
    label: 'Gmail deal intel',
    oneLiner: 'Link Gmail threads to deals and summarize them. Needs a verified Google OAuth client.',
    description: 'Per-deal Gmail thread linkage + Claude-authored thread summarization. The gmail.readonly scope is a Google "restricted" scope: a production rollout to a general audience requires CASA verification (Tier 2 minimum), which takes 6–12 weeks and runs $4K–$15K through a Google-approved assessor. Default off — only flip on for orgs that have already cleared verification, or for single-tenant deployments where the org owns the Google Cloud project the OAuth client lives in.',
    defaultValue: false,
  },
  {
    name: 'drive_intel_enabled',
    category: 'module',
    scope: 'org',
    group: 'Integrations',
    label: 'Google Drive deal intel',
    oneLiner: 'Read a per-deal Drive folder and produce an AI status summary. Needs a verified Google OAuth client.',
    description: 'Google Drive opportunity-intel summarization (DRIVE_INTEL_SPEC.md). Reads documents in a per-deal Drive folder and produces a Claude-authored deal-status summary. Default off — Google verification of the drive.readonly scope is a prerequisite for any production org.',
    defaultValue: false,
  },
  {
    name: 'drive_intel_writeback_enabled',
    category: 'module',
    scope: 'org',
    group: 'Integrations',
    label: 'Drive intel write-back suggestions',
    oneLiner: 'Let Drive intel propose deal-field updates you apply or reject one by one. Needs Drive deal intel.',
    description: 'Drive-intel write-back-to-CRM suggestions (migration 090). After a deal_intel_summaries row is generated, a follow-on Claude pass proposes per-field updates against an ALLOWLIST of writeable deal fields (stage, notes, expected_close_date). Users Apply/Reject per row; applied writes are auditable and undoable for 7 days. Default off — requires drive_intel_enabled and AI quota headroom.',
    defaultValue: false,
  },
  {
    name: 'outlook_mail_enabled',
    category: 'module',
    scope: 'org',
    group: 'Integrations',
    label: 'Outlook mail',
    oneLiner: 'Match Outlook / Microsoft 365 email to deals and show it on the timeline.',
    description: 'Outlook / Microsoft 365 inbound-mail sync (migration 140): matches recent Outlook messages to deals by participant email and lands them on the deal/account timeline (outlook_messages). Shares one Microsoft Graph consent (Mail.Read + Calendars.ReadWrite + offline_access) with outlook_calendar_enabled — either flag exposes /api/msgraph connection management. Default off — external OAuth against the Microsoft identity platform; multi-tenant rollouts need Azure publisher verification before users in other tenants can consent.',
    defaultValue: false,
  },
  {
    name: 'outlook_calendar_enabled',
    category: 'module',
    scope: 'org',
    group: 'Integrations',
    label: 'Outlook calendar',
    oneLiner: 'Match Outlook / Microsoft 365 meetings to deals and create meetings from deals.',
    description: 'Outlook / Microsoft 365 calendar sync (migration 140): matches recently-changed Outlook events to deals by attendee email (outlook_calendar_events) and provides the Graph events client for creating meetings from deals. Shares one Microsoft Graph consent with outlook_mail_enabled — either flag exposes /api/msgraph connection management. Default off — external OAuth against the Microsoft identity platform; multi-tenant rollouts need Azure publisher verification.',
    defaultValue: false,
  },
  {
    name: 'enrichment_enabled',
    category: 'module',
    scope: 'org',
    group: 'Integrations',
    label: 'Contact & company enrichment',
    oneLiner: 'An "Enrich" button that fills in title, company, industry and more from a data provider.',
    description: 'Contact / company data enrichment (migration 118, services/enrichment.js). Adds an "Enrich" action on the contact + company lists that fetches title/company/LinkedIn/location (contacts) or industry/employees/website/description (companies) from a pluggable HTTP provider and proposes them for the user to apply into custom_fields. Inert until ENRICHMENT_API_KEY (+ ENRICHMENT_PROVIDER_URL) are set — the endpoint degrades to a graceful "not configured" state. Default off.',
    defaultValue: false,
  },

  // ---- PLATFORM — enterprise auth + AI billing gate -----------------------
  {
    name: 'sso_enabled',
    category: 'platform',
    scope: 'platform',
    group: 'Platform',
    label: 'Enterprise SSO (OIDC + SCIM)',
    oneLiner: 'Single sign-on through your identity provider plus SCIM user provisioning (enterprise).',
    description: 'Enterprise SSO (OIDC) single sign-on + SCIM 2.0 user provisioning (migration 117). When on, an org admin configures an OIDC identity provider at /admin/sso (login via /api/auth/sso/:slug/start) and mints SCIM bearer tokens so an IdP can provision/deprovision users into the org. Default OFF — it is an auth path, inert until an org both flips this flag AND configures + enables a connection. Platform-scoped: enabled by a super-admin as part of an enterprise arrangement. See services/ssoOidc.js, routes/scimRoutes.js.',
    defaultValue: false,
  },
  {
    name: 'ai_billing_required',
    category: 'platform',
    scope: 'platform',
    group: 'Platform',
    label: 'AI billing gate',
    oneLiner: 'Require an active (or comped) AI subscription before AI and plugin calls are allowed.',
    description: 'When true, the requireAiBilling middleware enforces a paid (or comped/trial) AI subscription before allowing any /api/ai or /api/plugins request. Default true in production for general orgs; super-admin orgs are always exempt regardless of this flag.',
    defaultValue: true,
  },
];

// name → flag definition lookup.
const FLAG_BY_NAME = new Map(KNOWN_FLAGS.map((f) => [f.name, f]));

// The order the Modules page shows groups in.
const FLAG_GROUPS = ['Sell', 'Customers', 'Insights', 'Integrations', 'Platform'];

function getFlag(name) {
  return FLAG_BY_NAME.get(name) || null;
}

// Profile-aware default. Unknown flags → false.
function defaultFor(name, profile) {
  const flag = FLAG_BY_NAME.get(name);
  if (!flag) return false;
  const p = profile || 'generic';
  if (flag.profileDefaults && Object.prototype.hasOwnProperty.call(flag.profileDefaults, p)) {
    return Boolean(flag.profileDefaults[p]);
  }
  return Boolean(flag.defaultValue);
}

function isPlatformScoped(name) {
  const flag = FLAG_BY_NAME.get(name);
  return !!flag && flag.scope === 'platform';
}

// The per-flag view the Modules page renders: registry metadata + the org's
// effective value. `features` is the raw JSONB; `profile` drives defaults.
function describeFlags(features, profile, { includePlatform = true } = {}) {
  const f = features || {};
  return KNOWN_FLAGS
    .filter((flag) => includePlatform || flag.scope !== 'platform')
    .map((flag) => {
      const isOverride = Object.prototype.hasOwnProperty.call(f, flag.name);
      const defaultValue = defaultFor(flag.name, profile);
      return {
        name: flag.name,
        label: flag.label,
        oneLiner: flag.oneLiner,
        description: flag.description,
        category: flag.category,
        scope: flag.scope,
        group: flag.group,
        defaultValue,
        currentValue: isOverride ? Boolean(f[flag.name]) : defaultValue,
        isOverride,
      };
    });
}

// Test-only escape hatch: drop the per-org cache.
function _clearCache() {
  cache.clear();
}

module.exports = {
  getFeatures,
  getOrgFlagContext,
  hasFeature,
  setFeature,
  unsetFeature,
  defaultFor,
  getFlag,
  isPlatformScoped,
  describeFlags,
  KNOWN_FLAGS,
  FLAG_GROUPS,
  _clearCache,
};
