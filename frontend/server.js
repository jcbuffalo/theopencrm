// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Express server for serving React SPA in Cloud Run
// Includes proper caching strategies and SPA routing

const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

// ---------------------------------------------------------------------------
// Per-route SEO meta for the public pages. The SPA ships ONE index.html; for
// crawlers/link previews every route would otherwise carry the homepage's
// title/description. We swap the literal default strings (kept in sync with
// index.html — see the comment there) per known public path. Unknown paths
// (the authenticated app) get the defaults, which is fine: they're noindexed
// by robots.txt where sensitive and behind auth regardless.
// ---------------------------------------------------------------------------
const DEFAULT_TITLE = 'The Open CRM — Open-Source CRM with an AI Copilot';
const DEFAULT_DESC = 'The open-source CRM that configures around how you sell. Describe your process; it proposes the pipeline, fields and follow-ups, and nothing changes until you approve. Self-host free (AGPL-3.0) or hosted from $15/seat.';
const DEFAULT_CANONICAL = 'https://app.theopencrm.com/';

const PUBLIC_META = {
  '/login': {
    title: 'Sign in — The Open CRM',
    desc: 'Sign in to The Open CRM — open-source CRM with an AI copilot. Email/password or Google.',
  },
  '/request-access': {
    title: 'Create your free account — The Open CRM',
    desc: 'Start free on The Open CRM: your own workspace in seconds, no credit card. Open-source CRM with an AI copilot, hosted from $15/seat when you grow.',
  },
  '/pitch': {
    title: 'Product tour — The Open CRM',
    desc: 'See The Open CRM in action: multi-pipeline deals, AI copilot, automation, reporting, and customer-success tooling.',
  },
  '/launch': {
    title: 'The Open CRM is now actually open — launch announcement',
    desc: 'The full source is public on GitHub under AGPL-3.0: self-host free, bring your own AI key with no markup, or use hosted from $15/seat. The whole business model, in the open.',
  },
  '/terms': {
    title: 'Terms of Service — The Open CRM',
    desc: 'Terms of Service for The Open CRM hosted service.',
  },
  '/privacy': {
    title: 'Privacy Policy — The Open CRM',
    desc: 'How The Open CRM collects, uses, and protects your data.',
  },
  '/data-deletion': {
    title: 'Data deletion — The Open CRM',
    desc: 'How to export and delete your data from The Open CRM.',
  },
  '/verify-email': {
    title: 'Verify your email — The Open CRM',
    desc: 'Confirm your email address to finish creating your Open CRM account.',
  },
  // --- Marketing surfaces (spec 203, Phase 3). Keep in step with
  // src/marketing/comparisons.js (metaTitle/metaDesc) and src/marketing/verticals.js.
  '/hubspot-alternative': {
    title: 'HubSpot alternative — The Open CRM',
    desc: 'A HubSpot Sales Hub alternative without contact-tier pricing or onboarding fees. Describe how you sell and the CRM builds your pipeline. $15/seat hosted or $0 self-hosted, open source.',
  },
  '/salesforce-alternative': {
    title: 'Salesforce alternative — The Open CRM',
    desc: 'A Salesforce Sales Cloud alternative for 10-100 person teams: describe how you sell and the CRM proposes your pipeline, fields and automations. No consultants, $15/seat hosted or $0 self-hosted.',
  },
  '/pipedrive-alternative': {
    title: 'Pipedrive alternative — The Open CRM',
    desc: 'A Pipedrive alternative that stays simple but does not stop at the pipeline: multiple pipelines, automation, account management, and an AI copilot that builds your setup from a description. $15/seat or $0 self-hosted.',
  },
  '/zoho-alternative': {
    title: 'Zoho CRM alternative — The Open CRM',
    desc: 'A Zoho CRM alternative that configures itself from a description of how you sell. Open source, $15/seat hosted or $0 self-hosted, with an AI copilot and confirm-first automation.',
  },
  '/spreadsheet-crm': {
    title: 'Spreadsheet CRM: move from Google Sheets or Excel — The Open CRM',
    desc: 'Running sales from a spreadsheet? Describe your columns and tabs and The Open CRM builds the matching pipeline, fields and follow-up rules. Import the sheet as CSV. Free to start, open source.',
  },
  '/custom-crm-alternative': {
    title: 'Custom CRM alternative — The Open CRM',
    desc: 'Thinking about building your own CRM? The Open CRM configures itself from a description of your process and is open source (AGPL-3.0) if you ever need to go further. $15/seat hosted or $0 self-hosted.',
  },
  '/crm-for/b2b-sales': {
    title: 'CRM for B2B sales teams — The Open CRM',
    desc: 'Lead to close with the fields you report on and a nudge when a deal goes quiet. Describe how you sell and the CRM builds it. Free to start, open source.',
  },
  '/crm-for/saas': {
    title: 'CRM for SaaS and software companies — The Open CRM',
    desc: 'Trial, demo, quote, security review, procurement, renewal. A pipeline built for software sales from a plain-English description. Free to start, open source.',
  },
  '/crm-for/professional-services': {
    title: 'CRM for consulting and professional services — The Open CRM',
    desc: 'Intro, discovery, scoping, SOW, signed. Track engagement value, start date, service line and referrer. Built from your description. Free to start, open source.',
  },
  '/crm-for/agency': {
    title: 'CRM for marketing and creative agencies — The Open CRM',
    desc: 'Briefs, chemistry calls, pitches, projects and retainers on one board. Describe how your agency sells and the CRM builds it. Free to start, open source.',
  },
  '/crm-for/recruiting': {
    title: 'CRM for recruiting and staffing agencies — The Open CRM',
    desc: 'Every open role is a deal: sourcing, screening, shortlist, interviews, offer, placement, with a reminder when a client goes quiet. Free to start, open source.',
  },
  '/crm-for/commercial-real-estate': {
    title: 'CRM for commercial real estate brokers — The Open CRM',
    desc: 'Inquiry, showing, LOI, negotiation, due diligence, closing. Property, square footage, commission and target close tracked. Free to start, open source.',
  },
  '/crm-for/construction': {
    title: 'CRM for construction contractors — The Open CRM',
    desc: 'Bid invitations to awards: site visit, estimating, submitted, awarded, contract, mobilized, with a reminder before every bid is due. Free to start, open source.',
  },
  '/crm-for/distribution': {
    title: 'CRM for wholesale distributors — The Open CRM',
    desc: 'Open the account, get the first order, then flag any account that stops reordering. Volume, category, territory and terms tracked. Free to start, open source.',
  },
  '/crm-for/equipment-sales': {
    title: 'CRM for equipment dealers — The Open CRM',
    desc: 'Inquiry, demo, quote with financing, negotiation, close, delivery. Open quotes get a follow-up rule. Built from your description. Free to start, open source.',
  },
  '/crm-for/manufacturer-rep': {
    title: "CRM for manufacturer's representatives — The Open CRM",
    desc: 'RFQ, vendor quoting, customer quote, follow up, PO. The rep-agency workflow with RFQ number, vendor, commission rate and ship date tracked. Free to start, open source.',
  },
  '/crm-for/field-service': {
    title: 'CRM for field and technical service companies — The Open CRM',
    desc: 'Request, site survey, proposal, approved, scheduled, complete, and a rule so nothing approved sits unscheduled. Free to start, open source.',
  },
  '/crm-for/nonprofit': {
    title: 'CRM for nonprofit fundraising — The Open CRM',
    desc: 'Prospect, cultivation, ask, pledge, gift. A development pipeline with ask amount, gift type and program tracked, and follow-ups on open proposals. Free to start, open source.',
  },
};

let indexTemplate = null;
function renderIndex(reqPath) {
  if (indexTemplate === null) {
    indexTemplate = fs.readFileSync(path.join(__dirname, 'build', 'index.html'), 'utf8');
  }
  const meta = PUBLIC_META[reqPath];
  const canonical = `https://app.theopencrm.com${reqPath === '/' ? '/' : reqPath}`;
  // Needles are scoped to the canonical <link> and og:url so the JSON-LD's
  // application url (same literal) keeps pointing at the site root.
  let html = indexTemplate
    .split(`rel="canonical" href="${DEFAULT_CANONICAL}"`).join(`rel="canonical" href="${canonical}"`)
    .split(`property="og:url" content="${DEFAULT_CANONICAL}"`).join(`property="og:url" content="${canonical}"`);
  if (meta) {
    html = html.split(DEFAULT_TITLE).join(meta.title).split(DEFAULT_DESC).join(meta.desc);
  }
  return html;
}

// Compression middleware
app.use(compression());

// ---------------------------------------------------------------------------
// Security headers. The backend API has helmet; this SPA server previously
// sent NONE (2026-09-17 basics audit). Kept hand-rolled — a handful of
// headers doesn't justify a dependency here.
//   - Embeddable public surfaces (lead forms /f/, surveys /s/, customer
//     portal /portal/) must stay frameable on customers' own sites, so the
//     anti-clickjacking header is skipped there; everything else is DENY.
//     The CSP frame-ancestors directive mirrors the same split.
// ---------------------------------------------------------------------------
const EMBEDDABLE_PREFIXES = ['/f/', '/s/', '/portal/'];

// ---------------------------------------------------------------------------
// Content-Security-Policy — built from an inventory of what the app actually
// loads (2026-09 CSP pass). Applied on HTML responses only (the SPA shell is
// the document; subresources inherit its policy — putting CSP on JS/PNG
// responses is inert noise).
//
// External origins the SPA really uses:
//   script-src   accounts.google.com          Google Sign-In (gsi/client, Login.js)
//   frame-src    accounts.google.com          GSI renders its button/one-tap in an iframe
//   style-src    accounts.google.com          GSI injects a stylesheet (gsi/style)
//                'unsafe-inline'              GSI + leaflet setAttribute('style') +
//                                             the static-shell inline style attrs
//   connect-src  API_ORIGIN                   axios/fetch to the backend (REACT_APP_API_URL)
//                accounts.google.com          GSI status/token XHRs
//                storage.googleapis.com       document downloads: axios follows the
//                                             backend's 302 to the GCS signed URL
//                                             (documentRoutes.js), so the XHR's final
//                                             destination must be allowed
//   img-src      https: data: blob:           OSM tiles ({a,b,c}.tile.openstreetmap.org,
//                                             RecordMap.js), GCS-hosted images, and
//                                             admin-configurable org logo URLs
//                                             (/admin/branding accepts any https CDN) —
//                                             which is why img-src stays broad
//   font-src     'self' data:                 bundled fonts only (no Google Fonts)
//
// Notes from testing (see the CSP verification in the workstream report):
//   - The JSON-LD <script type="application/ld+json"> in index.html is
//     non-executable data — browsers do NOT block or report it under
//     script-src, so no hash/'unsafe-inline' is needed for scripts.
//   - Vite emits only external <script type="module" src=…> tags into the
//     built index.html — no inline bootstrap script — so script-src 'self'
//     holds for the bundle.
//   - Stripe checkout/portal are full-page redirects (window.location.href),
//     which CSP does not govern; Stripe.js is never loaded in-page.
//   - report-uri posts violation reports to the backend's rate-limited
//     /api/client-errors/csp receiver (logged, grouped in Cloud Logging).
//
// API_ORIGIN must match the origin baked into the bundle as
// REACT_APP_API_URL at build time. Override via env for self-hosters.
// ---------------------------------------------------------------------------
const API_ORIGIN = process.env.API_ORIGIN
  || 'https://synccrm-backend-615440681743.us-central1.run.app';
// Local dev convenience: also allow the default local backend when not in prod.
const DEV_CONNECT = process.env.NODE_ENV === 'production' ? '' : ' http://localhost:5001';

function buildCsp(frameAncestors) {
  return [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com",
    "style-src 'self' 'unsafe-inline' https://accounts.google.com",
    `connect-src 'self' ${API_ORIGIN}${DEV_CONNECT} https://accounts.google.com https://storage.googleapis.com`,
    "img-src 'self' https: data: blob:",
    "font-src 'self' data:",
    'frame-src https://accounts.google.com',
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
    `report-uri ${API_ORIGIN}/api/client-errors/csp`,
  ].join('; ');
}
// Two precomputed variants — the policy is static per request class.
const CSP_DEFAULT = buildCsp("'none'");
const CSP_EMBEDDABLE = buildCsp('*');

app.use((req, res, next) => {
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (!EMBEDDABLE_PREFIXES.some((p) => req.path.startsWith(p))) {
    res.set('X-Frame-Options', 'DENY');
  }
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Serve static files — hashed bundles get 1-year cache, index.html gets no-cache.
// `index: false` so `/` falls through to the SPA handler below (which injects
// per-route meta) instead of express.static short-circuiting with the raw file.
app.use(
  express.static(path.join(__dirname, 'build'), {
    maxAge: '1y',
    etag: false,
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  })
);

// Serve index.html with no-cache for SPA routing, with per-route SEO meta
// injected for the known public pages (see PUBLIC_META above).
// Use regex pattern instead of '*' to avoid "Missing parameter name" error in newer Express versions
app.get(/^\//, (req, res) => {
  res.set('Cache-Control', 'public, max-age=0, no-cache, no-store, must-revalidate');
  // CSP on the HTML document only. frame-ancestors mirrors the X-Frame-Options
  // split above: the embeddable public surfaces may be framed anywhere (they
  // live on customers' own sites), everything else may not be framed at all.
  const embeddable = EMBEDDABLE_PREFIXES.some((p) => req.path.startsWith(p));
  res.set('Content-Security-Policy', embeddable ? CSP_EMBEDDABLE : CSP_DEFAULT);
  res.type('html').send(renderIndex(req.path));
});

app.listen(PORT, () => {
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  The Open CRM — Frontend
  Server running on port: ${PORT}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `);
});
