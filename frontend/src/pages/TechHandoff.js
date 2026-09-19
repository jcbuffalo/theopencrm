// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';
import Nav from '../components/Nav';
import DataTable from '../components/DataTable';
import { Alert, Card, Container, Icon, PageHeader } from '../components/ui';

const GITHUB_URL = process.env.REACT_APP_GITHUB_URL || '';
const REPO_LABEL = GITHUB_URL || 'Available on request — contact owner';
const FRONTEND_URL = 'https://app.theopencrm.com';
const BACKEND_URL = process.env.REACT_APP_API_URL?.replace(/\/api\/?$/, '') || 'https://synccrm-backend-615440681743.us-central1.run.app';

const STACK = {
  frontend: [
    ['React', '18.x', 'UI framework'],
    ['React Router DOM', '6.x', 'Client-side routing'],
    ['Tailwind CSS', '3.x', 'Utility-first styling'],
    ['Axios', '1.x', 'HTTP client w/ JWT interceptor'],
    ['@dnd-kit/core', '6.x', 'Kanban drag-and-drop'],
    ['Express + Node', '18 (Alpine)', 'Static SPA server in Cloud Run'],
  ],
  backend: [
    ['Node.js', '18 (Alpine)', 'Runtime'],
    ['Express', '4.x', 'HTTP framework'],
    ['pg (node-postgres)', '8.x', 'PostgreSQL client w/ pool'],
    ['jsonwebtoken', '9.x', 'JWT auth'],
    ['bcryptjs', '2.x', 'Password hashing'],
    ['google-auth-library', '9.x', 'Google OAuth verify'],
    ['nodemailer', '6.x', 'Email send (Gmail/SendGrid)'],
    ['multer', '1.x (LTS)', 'Multipart upload parser'],
    ['csv-parse', '5.x', 'CSV import parsing'],
    ['pdfkit', '0.15.x', 'Branded quote PDF generation'],
    ['@google-cloud/storage', '7.x', 'GCS object storage for documents'],
    ['helmet', '8.x', 'Security headers'],
    ['express-rate-limit', '8.x', 'Rate limiting'],
  ],
  infra: [
    ['Google Cloud Run', '—', 'Container hosting (auto-scale, 2 services: backend + frontend)'],
    ['Cloud SQL (PostgreSQL)', '15', 'Managed Postgres — instance: xfte-postgres'],
    ['Cloud Storage (GCS)', '—', 'Document storage bucket: xfte-platform-zangflow-docs'],
    ['Cloud Build', '—', 'CI image build (gcloud builds submit)'],
    ['Container Registry (gcr.io)', '—', 'Image storage'],
    ['GCP Project', '—', 'xfte-platform / region us-central1'],
  ],
  externalIntegrations: [
    ['Google OAuth (Sign-in)', 'optional', 'GOOGLE_CLIENT_ID env var'],
    ['Gmail SMTP (RFQ + contact form)', 'optional', 'GMAIL_USER + GMAIL_APP_PASSWORD'],
    ['SendGrid (alt RFQ transport)', 'optional', 'SENDGRID_API_KEY'],
  ],
};

const SCHEMA = [
  { table: 'users',           note: 'Auth identities, with org_id + org_role' },
  { table: 'organizations',   note: 'Tenancy unit — every data row scoped here' },
  { table: 'org_invites',     note: 'Token-based teammate invites (7-day expiry)' },
  { table: 'companies',       note: 'Customers, vendors, end users (type column)' },
  { table: 'contacts',        note: 'People at companies' },
  { table: 'deals',           note: 'Umbrella opportunity record — phase + stage (stage set is profile-driven)' },
  { table: 'quotes / quote_revisions / quote_line_items', note: 'Customer-facing quote with full revision history' },
  { table: 'vendor_quotes',   note: 'Per-vendor RFQ + response, comparison, selection' },
  { table: 'submittals',      note: 'Drawing/spec approval cycles with version chain' },
  { table: 'change_orders',   note: 'Post-PO scope changes with approval status' },
  { table: 'issues',          note: 'Cross-cutting issue tracker — urgency, blocking flag, escalation' },
  { table: 'documents',       note: 'File attachments — GCS-backed with DB metadata' },
  { table: 'activities',      note: 'Call/email/meeting log' },
  { table: 'tasks',           note: 'Personal/team to-dos' },
  { table: 'pipelines',       note: 'Configurable stage pipelines (future use)' },
];

const ENV_VARS = {
  backend: [
    ['NODE_ENV', 'production', 'Triggers auto-migration on startup'],
    ['DB_USER', 'synccrm_user', 'Cloud SQL user'],
    ['DB_PASSWORD', '(secret)', 'Cloud SQL password'],
    ['DB_NAME', 'lightweight_crm', 'Database name'],
    ['INSTANCE_CONNECTION_NAME', 'xfte-platform:us-central1:xfte-postgres', 'Cloud SQL socket'],
    ['JWT_SECRET', '(generate)', 'JWT signing key — rotate periodically'],
    ['GOOGLE_CLIENT_ID', '(optional)', 'For verifying Google ID tokens'],
    ['GMAIL_USER / GMAIL_APP_PASSWORD', '(optional)', 'Outbound email via Gmail'],
    ['SENDGRID_API_KEY', '(optional)', 'Alt transport — preferred over Gmail at scale'],
    ['GCP_PROJECT_ID', 'xfte-platform', 'For GCS client'],
    ['GCS_DOCUMENTS_BUCKET', 'xfte-platform-zangflow-docs', 'Object storage bucket'],
    ['FRONTEND_URL', 'https://app.theopencrm.com', 'CORS allow-list'],
  ],
  frontend: [
    ['REACT_APP_API_URL', 'https://synccrm-backend-…/api', 'Backend base URL — baked at build time'],
    ['REACT_APP_GOOGLE_CLIENT_ID', '(your Google client ID)', 'For Google sign-in button'],
    ['REACT_APP_GITHUB_URL', '(your repo URL)', 'Shown on this handoff page'],
  ],
};

const FEATURES_BUILT = [
  ['§4.1 Flow', 'Global search across companies/contacts/deals · Phase auto-shift on stage change · Shallow-click drawer-based detail panels'],
  ['§4.2 Issues / Tasks', 'Issues entity with red/yellow/green urgency, category, sub-category, financial impact, blocks_workflow flag, escalation, status workflow'],
  ['§4.3 Pre-Sale', 'Vendor quote table with multi-vendor comparison + selection · Customer quotes with line items + revisions · Branded customer-quote PDF generation · Vendor RFQ email send (Gmail/SendGrid)'],
  ['§4.4 Post-Sale', 'PO #, ship-to, POC, target ship date · Submittals with version chain + approval flow · Change orders with +/- amount + approval · Release/hold toggle with reason · Document storage by type (BOL/packing/closeout)'],
  ['§4.5 Post-Shipment', 'Stages tracked: TBI, INVOICED, COMM_WATCH, SERVICE, CLOSEOUTS, CUSTOMER_EXPERIENCE, WARRANTY, MARKETING, END_USER'],
  ['§4.6 Reporting', 'Hit rate · Pre-sale funnel · Vendor performance leaderboard (RFQs sent/received/won, avg lead time, won value) · Open-issue urgency breakdown · Phase totals'],
  ['Stages of an Order', 'All 28 stages from Exhibit A live in 3-phase Kanban (Pre-Sale / Post-Sale / Post-Shipment)'],
  ['Documents', 'GCS-backed object storage with signed-URL downloads (15-min expiry); 50MB upload limit; per-org/per-record paths'],
  ['Multi-tenancy', 'Organizations + invite tokens; every data row scoped by org_id'],
];

const FEATURES_TODO = [
  ['Branded quote PDF', '✅ DONE — pdfkit-based, downloadable from any quote, with embedded liability footer'],
  ['Vendor RFQ email', '✅ DONE — Gmail / SendGrid via nodemailer; logs in dev when not configured; audit-logged'],
  ['GCS document storage', '✅ DONE — auto-creates bucket, signed-URL downloads (15-min expiry), 50MB limit, DB-blob fallback for small files in dev'],
  ['Structured logging', '✅ DONE — JSON to Cloud Logging, redacted secrets, per-request correlation ID'],
  ['Audit log', '✅ DONE — auth events, RFQ sends, document downloads, PDF generation persisted with actor + IP'],
  ['Password policy', '✅ DONE — 10-char minimum, 3 of 4 character classes, common-pattern blocklist'],
  ['Liability disclaimers', '✅ DONE — LICENSE file, /api/legal endpoint, terms-acceptance modal, PDF footer, response-body disclaimer on errors'],
  ['QuickBooks Online integration', 'TODO — OAuth + invoice creation on INVOICED stage transition (~3-5 days)'],
  ['Triggered automation', 'TODO — vendor-price-validation alerts at 30 days, hot-deal logic, customer surveys on shipment (~1-2 days)'],
  ['Salesman dashboards', 'TODO — per-user pipeline views + EOY commission reports'],
  ['Teams / Zoom / Call log integration', 'TODO — §4.1d.ii (multi-week, requires Microsoft Graph + Zoom API)'],
  ['Email verification on signup', '✅ DONE — token-based verification email required before first login'],
  ['Two-factor auth (TOTP)', '✅ DONE — speakeasy + QR enrollment, with recovery codes'],
  ['Customer appreciation queue', 'TODO — criteria-based gift trigger + manual queue'],
  ['Eaton / APC design-build forms', 'TODO — vendor-specific UI per §4.3a.iii'],
];

const SECURITY_CONTROLS = [
  ['Authentication', 'JWT (HS256) with 24h expiry. Bcrypt-hashed passwords. Google OAuth verified server-side via google-auth-library. Tokens carry only userId; org_id is re-fetched from DB on every request to prevent stale-claim escalation.'],
  ['Password policy', 'Minimum 10 chars; must include 3 of {lowercase, uppercase, digit, symbol}; common-pattern blocklist (password, qwerty, 123456, etc.). Enforced server-side on register.'],
  ['Multi-tenancy isolation', 'Every data query goes through the qs(req) helper, which scopes by org_id (preferred) or user_id. No route bypasses it. Cross-org access is structurally impossible without a code change.'],
  ['Transport security', 'HTTPS-only — Cloud Run serves TLS 1.2+. HSTS via helmet. CORS allow-list to FRONTEND_URL.'],
  ['HTTP hardening', 'helmet (CSP, X-Frame-Options, X-Content-Type-Options, etc.). Rate limiter at 500/15min/IP. Trust-proxy enabled so rate limits key by real client IP behind Cloud Run.'],
  ['Input validation', 'Body size capped at 10MB (50MB for document upload). CSV uploads parse with relax_quotes + bom for safety. SQL queries are parameterised throughout — no string concatenation into queries.'],
  ['Secrets', 'JWT_SECRET, DB_PASSWORD, GMAIL_APP_PASSWORD, SENDGRID_API_KEY all sourced from environment. Defaults are placeholders that print warnings. Logger redacts known-sensitive keys before emit.'],
  ['Audit log', 'Append-only audit_log table records auth events (login success/fail, register, logout, Google sign-in), RFQ sends, document downloads, PDF generation, and record deletions — with actor user, org, IP, user agent, and request correlation ID.'],
  ['Object storage', 'GCS bucket has uniform bucket-level access. Files served only via 15-minute signed URLs minted server-side after auth check — no public read access.'],
  ['Logging', 'Structured JSON to stdout → Cloud Logging. Sensitive fields (password, token, content, api_key) redacted in the log layer.'],
];

const SECURITY_KNOWN_GAPS = [
  ['Email verification', 'Not enforced on signup. Recommend adding a verification-token table and gating login on verified=true before exposing to untrusted users.'],
  ['Two-factor auth', 'Not implemented. For organisations handling regulated or financial data, add TOTP (otplib + QR via qrcode) and a recovery-code workflow.'],
  ['Session revocation', 'JWTs are stateless and live until expiry. There is no allow-list / revocation table. Forced logout requires waiting out the 24h TTL or rotating JWT_SECRET.'],
  ['Rate limit granularity', 'Currently a single global limiter. Auth endpoints should have a stricter limiter to slow credential-stuffing attempts (~5/min/IP).'],
  ['Content scanning', 'Document uploads are accepted without virus / malware scanning. For regulated environments, integrate Cloud DLP or a third-party scanner before serving signed URLs.'],
  ['Penetration test', 'No third-party pen test has been conducted on this codebase. Recommend before any production rollout that touches real customer data.'],
];

const TROUBLESHOOTING = [
  {
    problem: 'API returns 500 with `column ... does not exist`',
    diagnosis: 'A migration didn\'t run. Check Cloud Run startup logs for `Failed migration:` lines.',
    fix: 'Verify Cloud SQL connectivity (INSTANCE_CONNECTION_NAME), DB user permissions, and re-deploy. Migrations are idempotent — they run on every cold start in production.',
  },
  {
    problem: 'Frontend shows stale UI after deploy',
    diagnosis: 'Browser cached an old index.html. Should be impossible after the May 2026 cache-control fix, but possible on a private Cloudflare/CDN.',
    fix: 'Hard refresh (Cmd-Shift-R / Ctrl-F5). Confirm response header for /index.html is `Cache-Control: no-cache, no-store, must-revalidate`.',
  },
  {
    problem: 'Quote PDF download fails or is blank',
    diagnosis: 'pdfkit dependency missing or fonts not bundled. Less commonly, the quote has zero line items and the layout collapses.',
    fix: 'Check backend logs for `Quote PDF error`. Verify pdfkit is in package.json and node_modules. Add a line item if missing.',
  },
  {
    problem: 'Vendor RFQ email "sent" but never arrives',
    diagnosis: 'Email transport not configured — the API returns transport=`console` and only logs the payload.',
    fix: 'Set GMAIL_USER + GMAIL_APP_PASSWORD (Gmail) or SENDGRID_API_KEY (SendGrid) on the backend Cloud Run service. Restart so the email service re-reads env.',
  },
  {
    problem: 'Document upload fails with "Storage backend unavailable"',
    diagnosis: 'GCS bucket access denied — Cloud Run service account is missing storage.admin or signBlob permission.',
    fix: 'Run: `gcloud projects add-iam-policy-binding xfte-platform --member=serviceAccount:<sa-email> --role=roles/storage.admin` and grant `roles/iam.serviceAccountTokenCreator` on the SA on itself.',
  },
  {
    problem: 'Document download returns 403 from GCS',
    diagnosis: 'Signed URL was minted but the SA lacks signBlob permission, so the URL is not actually authorised.',
    fix: 'Grant `roles/iam.serviceAccountTokenCreator` to the Cloud Run SA on itself. This must be on the SA resource, not the project.',
  },
  {
    problem: 'Login returns 401 immediately for a user that just registered',
    diagnosis: 'Most likely the password policy rejected the password but the frontend showed a generic message. Or there\'s a clock skew issue with JWT.',
    fix: 'Check backend logs for the request ID returned in the response body. Verify the password meets the policy (10+ chars, 3 character classes). Check JWT_SECRET hasn\'t changed since the token was issued.',
  },
  {
    problem: 'CORS errors in browser console',
    diagnosis: 'FRONTEND_URL env var on backend doesn\'t match the actual frontend origin.',
    fix: 'Update FRONTEND_URL to the exact frontend origin (with protocol, no trailing slash) and redeploy.',
  },
  {
    problem: 'Migration logs show "duplicate key" errors',
    diagnosis: 'Two Cloud Run instances raced on cold start and tried to record the same migration. Harmless — one wins, the other logs the duplicate.',
    fix: 'No action needed unless you see actual data corruption. The migration was applied; only the bookkeeping insert failed.',
  },
  {
    problem: 'Drag-and-drop on Deals board feels laggy',
    diagnosis: '@dnd-kit re-renders all cards when one is being dragged. With 200+ cards this gets heavy.',
    fix: 'Use the search/filter bar to narrow the visible set. Longer term, virtualise with react-window inside each column.',
  },
];

const SUPPORT_CHECKLIST = [
  'Note the request ID from the error response (returned as `requestId` in the JSON body and X-Request-Id header).',
  'Look up the request ID in Cloud Logging — every log line for that request shares it. This pinpoints the exact failure path.',
  'For data issues, query the audit_log table by actor_user_id and time range to see what the user attempted.',
  'For deploy issues, check the most recent Cloud Build history and the backend service\'s Cloud Run revision list (`gcloud run revisions list --region us-central1`).',
  'For migration issues, run: `SELECT name, executed_at FROM migrations ORDER BY id DESC LIMIT 20;` against the prod DB to confirm what ran.',
];

const DATA_HANDLING = [
  ['Tenancy', 'All business data is isolated by org_id. Removing a user from an org sets their org_id=NULL — they retain login but see no records.'],
  ['Personally identifiable information', 'The system stores: user email/name (required for auth); contact email/phone/job title; customer/vendor company name + location + phone. No SSN, payment info, or health data is stored.'],
  ['Encryption at rest', 'Cloud SQL encrypts all data at rest with Google-managed keys (AES-256). GCS encrypts objects at rest the same way. For CMEK, switch the bucket and SQL instance to customer-managed keys (operator decision).'],
  ['Encryption in transit', 'TLS 1.2+ required by Cloud Run. Internal Cloud SQL connections use the Cloud SQL Auth Proxy.'],
  ['Backups', 'Cloud SQL automated backups are operator-configured. Recommend daily backups + 7-day point-in-time recovery for production.'],
  ['Data deletion', 'Deleting a record performs a hard delete. There is no soft-delete table. For regulated environments where deleted-data recoverability is needed, add a deleted_at column and update routes to filter on NULL.'],
];

function downloadMarkdown() {
  const md = generateMarkdown();
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `theopencrm-tech-handoff-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

function generateMarkdown() {
  const ts = new Date().toISOString().slice(0, 10);
  let md = `# The Open CRM — Technical Handoff\n\n`;
  md += `Generated: ${ts}\n\n`;
  md += `**Repository:** ${REPO_LABEL}\n`;
  md += `**Frontend (live):** ${FRONTEND_URL}\n`;
  md += `**Backend (live):** ${BACKEND_URL}\n\n`;
  md += `---\n\n## Stack\n\n### Frontend\n\n| Library | Version | Purpose |\n|---|---|---|\n`;
  STACK.frontend.forEach(([n, v, p]) => { md += `| ${n} | ${v} | ${p} |\n`; });
  md += `\n### Backend\n\n| Library | Version | Purpose |\n|---|---|---|\n`;
  STACK.backend.forEach(([n, v, p]) => { md += `| ${n} | ${v} | ${p} |\n`; });
  md += `\n### Infrastructure\n\n| Service | Version | Purpose |\n|---|---|---|\n`;
  STACK.infra.forEach(([n, v, p]) => { md += `| ${n} | ${v} | ${p} |\n`; });
  md += `\n### External Integrations (optional)\n\n| Service | Status | Configuration |\n|---|---|---|\n`;
  STACK.externalIntegrations.forEach(([n, v, p]) => { md += `| ${n} | ${v} | ${p} |\n`; });

  md += `\n---\n\n## Database Schema\n\n| Table | Purpose |\n|---|---|\n`;
  SCHEMA.forEach(({ table, note }) => { md += `| \`${table}\` | ${note} |\n`; });

  md += `\n---\n\n## Environment Variables\n\n### Backend\n\n| Var | Example | Notes |\n|---|---|---|\n`;
  ENV_VARS.backend.forEach(([n, v, p]) => { md += `| \`${n}\` | \`${v}\` | ${p} |\n`; });
  md += `\n### Frontend (baked at build time)\n\n| Var | Example | Notes |\n|---|---|---|\n`;
  ENV_VARS.frontend.forEach(([n, v, p]) => { md += `| \`${n}\` | \`${v}\` | ${p} |\n`; });

  md += `\n---\n\n## Deployment\n\n`;
  md += `Both services deploy via Cloud Build → Cloud Run.\n\n`;
  md += `### Backend\n\n\`\`\`bash\ncd backend\ngcloud builds submit --tag gcr.io/<PROJECT_ID>/<BACKEND_SERVICE>:latest . --project <PROJECT_ID>\ngcloud run deploy <BACKEND_SERVICE> \\\n  --image gcr.io/<PROJECT_ID>/<BACKEND_SERVICE>:latest \\\n  --region us-central1 --platform managed --project <PROJECT_ID>\n\`\`\`\n\n`;
  md += `### Frontend\n\n\`\`\`bash\ncd frontend\ngcloud builds submit --tag gcr.io/<PROJECT_ID>/<FRONTEND_SERVICE>:latest . --project <PROJECT_ID>\ngcloud run deploy <FRONTEND_SERVICE> \\\n  --image gcr.io/<PROJECT_ID>/<FRONTEND_SERVICE>:latest \\\n  --region us-central1 --platform managed --project <PROJECT_ID>\n\`\`\`\n\n`;

  md += `---\n\n## Migrations\n\n`;
  md += `SQL migrations live in \`backend/migrations/NNN_name.sql\`. They run automatically on backend startup in production (\`NODE_ENV=production\`). Each filename is recorded in the \`migrations\` table to prevent re-execution. To add a new schema change, drop a new file with a higher prefix.\n\n`;

  md += `---\n\n## Built (matched against contract Exhibit A)\n\n`;
  FEATURES_BUILT.forEach(([s, d]) => { md += `- **${s}** — ${d}\n`; });

  md += `\n## Known gaps\n\n`;
  FEATURES_TODO.forEach(([s, d]) => { md += `- **${s}** — ${d}\n`; });

  md += `\n---\n\n## Security Review\n\n### Controls in place\n\n`;
  SECURITY_CONTROLS.forEach(([area, desc]) => { md += `- **${area}** — ${desc}\n`; });
  md += `\n### Known security gaps\n\n`;
  SECURITY_KNOWN_GAPS.forEach(([area, desc]) => { md += `- **${area}** — ${desc}\n`; });

  md += `\n---\n\n## Data Handling\n\n| Topic | Notes |\n|---|---|\n`;
  DATA_HANDLING.forEach(([t, d]) => { md += `| ${t} | ${d} |\n`; });

  md += `\n---\n\n## Troubleshooting\n\n`;
  TROUBLESHOOTING.forEach(t => {
    md += `### ${t.problem}\n\n**Likely cause:** ${t.diagnosis}\n\n**Fix:** ${t.fix}\n\n`;
  });

  md += `## Support Checklist\n\n`;
  SUPPORT_CHECKLIST.forEach((item, i) => { md += `${i + 1}. ${item}\n`; });

  md += `\n---\n\n## Liability & License\n\n`;
  md += `This software is provided **AS IS, WITHOUT WARRANTY OF ANY KIND**, express or implied. The complete legal disclaimer is in the \`LICENSE\` file at the project root and is also surfaced:\n\n`;
  md += `- in the UI as a click-through Terms of Use modal on first authenticated session;\n`;
  md += `- in the public \`GET /api/legal\` endpoint (machine-readable);\n`;
  md += `- in the footer of every generated quote PDF;\n`;
  md += `- in the body of every error response.\n\n`;
  md += `**John Coles assumes no liability for damages arising from use, misuse, or inability to use this Software.** See LICENSE for the full text including indemnification, governing law (New York), and acceptance terms.\n\n`;

  md += `---\n\n## How to onboard a new contractor\n\n`;
  md += `1. **Read any deployment-specific SOW** in \`userrequirementsandfeedback/\` — for the Zang white-label deployment, that contract's Exhibit A is the source of truth for stage/feature names.\n`;
  md += `2. **Clone the repo** and bring up local Postgres (any 15+ instance). Run \`npm install\` in both \`backend/\` and \`frontend/\`.\n`;
  md += `3. **Backend dev:** copy env vars above into \`backend/.env\`. Use \`npm run dev\` (nodemon).\n`;
  md += `4. **Frontend dev:** copy \`REACT_APP_*\` into \`frontend/.env\`. Use \`npm start\`.\n`;
  md += `5. **Architecture mental model:** \`deals\` is the umbrella record; everything else (vendor_quotes, quotes, submittals, change_orders, issues, documents) hangs off of it. Org-scoping happens in every route via \`qs(req)\`.\n`;
  md += `6. **The next 3 high-leverage tasks** are listed in the "Known gaps" section above; QuickBooks is the largest.\n`;

  return md;
}

function Section({ title, children }) {
  return (
    <Card title={title} padding="none" bodyClassName="p-5">
      {children}
    </Card>
  );
}

function Table({ headers, rows }) {
  return (
    <DataTable
      flush
      density="compact"
      stickyHeader={false}
      rowKey={(_, i) => i}
      columns={headers.map((h, j) => ({ key: String(j), label: h, render: (r) => r[j] }))}
      data={rows}
    />
  );
}

function StatList({ items, tone }) {
  const toneCls = tone === 'success' ? 'bg-success-50 border-success-200'
    : tone === 'warning' ? 'bg-warning-50 border-warning-200'
    : 'bg-white border-gray-200';
  return (
    <ul className="space-y-2">
      {items.map(([section, desc, itemTone], i) => {
        const cls = itemTone === 'success' ? 'bg-success-50 border-success-200' : toneCls;
        return (
          <li key={i} className={`border rounded p-3 ${cls}`}>
            <div className="font-semibold text-sm text-gray-900 flex items-center gap-1.5">
              {itemTone === 'success' && <Icon name="check-circle" size={14} className="text-success-600" />}
              {section}
            </div>
            <div className="text-sm text-gray-700 mt-0.5">{desc}</div>
          </li>
        );
      })}
    </ul>
  );
}

const CODE = 'text-xs bg-gray-100 px-1 py-0.5 rounded';

export default function TechHandoff() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="handoff" />
      <Container>
        <PageHeader
          title="Technical handoff"
          subtitle="Stack, schema, deployment, and gap analysis — share this with new contractors."
          primaryAction={{ label: 'Download as Markdown', icon: 'download', onClick: downloadMarkdown }}
        />

        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Card padding="sm">
              <p className="text-xs uppercase tracking-wider text-gray-500 font-semibold">Repository</p>
              {GITHUB_URL ? (
                <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="text-sm font-mono text-brand-blue truncate mt-1 block hover:underline">{GITHUB_URL}</a>
              ) : (
                <p className="text-sm text-gray-500 mt-1">{REPO_LABEL}</p>
              )}
            </Card>
            <Card as="a" padding="sm" href={FRONTEND_URL} target="_blank" rel="noreferrer" className="hover:border-brand-blue transition-colors">
              <p className="text-xs uppercase tracking-wider text-gray-500 font-semibold">Frontend (live)</p>
              <p className="text-sm font-mono text-brand-blue truncate mt-1">{FRONTEND_URL}</p>
            </Card>
            <Card as="a" padding="sm" href={BACKEND_URL} target="_blank" rel="noreferrer" className="hover:border-brand-blue transition-colors">
              <p className="text-xs uppercase tracking-wider text-gray-500 font-semibold">Backend (live)</p>
              <p className="text-sm font-mono text-brand-blue truncate mt-1">{BACKEND_URL}</p>
            </Card>
          </div>

          <Card title="Stack — Frontend" padding="none">
            <Table headers={['Library', 'Version', 'Purpose']} rows={STACK.frontend} />
          </Card>

          <Card title="Stack — Backend" padding="none">
            <Table headers={['Library', 'Version', 'Purpose']} rows={STACK.backend} />
          </Card>

          <Card title="Infrastructure" padding="none">
            <Table headers={['Service', 'Version', 'Purpose']} rows={STACK.infra} />
          </Card>

          <Card title="External Integrations (optional)" padding="none">
            <Table headers={['Service', 'Status', 'Configuration']} rows={STACK.externalIntegrations} />
          </Card>

          <Card title="Database Schema" padding="none">
            <Table headers={['Table', 'Purpose']} rows={SCHEMA.map(s => [s.table, s.note])} />
          </Card>

          <Card title="Environment Variables — Backend" padding="none">
            <Table headers={['Variable', 'Example', 'Notes']} rows={ENV_VARS.backend} />
          </Card>

          <Card title="Environment Variables — Frontend (baked at build time)" padding="none">
            <Table headers={['Variable', 'Example', 'Notes']} rows={ENV_VARS.frontend} />
          </Card>

          <Section title="Deployment">
            <div className="space-y-3 text-sm">
              <p className="text-gray-700">Both services build via Cloud Build and deploy to Cloud Run. Migrations run automatically on backend startup when <code className={CODE}>NODE_ENV=production</code>.</p>
              <pre className="bg-gray-900 text-gray-100 p-3 rounded text-xs overflow-x-auto">{`# Backend
cd backend
gcloud builds submit --tag gcr.io/<PROJECT_ID>/<BACKEND_SERVICE>:latest .
gcloud run deploy <BACKEND_SERVICE> \\
  --image gcr.io/<PROJECT_ID>/<BACKEND_SERVICE>:latest \\
  --region us-central1 --platform managed --project <PROJECT_ID>

# Frontend
cd frontend
gcloud builds submit --tag gcr.io/<PROJECT_ID>/<FRONTEND_SERVICE>:latest .
gcloud run deploy <FRONTEND_SERVICE> \\
  --image gcr.io/<PROJECT_ID>/<FRONTEND_SERVICE>:latest \\
  --region us-central1 --platform managed --project <PROJECT_ID>`}</pre>
            </div>
          </Section>

          <Section title="Built (matched against contract Exhibit A)">
            <StatList items={FEATURES_BUILT} />
          </Section>

          <Section title="Known gaps / next contractor work">
            <StatList
              items={FEATURES_TODO.map(([section, desc]) => {
                const done = desc.startsWith('✅');
                return [section, done ? desc.replace(/^✅\s*/, '') : desc, done ? 'success' : undefined];
              })}
            />
          </Section>

          <Card title="Security Review — Controls in place" padding="none">
            <Table headers={['Area', 'Implementation']} rows={SECURITY_CONTROLS} />
          </Card>

          <Section title="Security Review — Known gaps">
            <StatList items={SECURITY_KNOWN_GAPS} tone="warning" />
          </Section>

          <Card title="Data Handling" padding="none">
            <Table headers={['Topic', 'Notes']} rows={DATA_HANDLING} />
          </Card>

          <Section title="Troubleshooting Guide">
            <div className="space-y-3">
              {TROUBLESHOOTING.map((t, i) => (
                <details key={i} className="border border-gray-200 rounded p-3 group">
                  <summary className="cursor-pointer font-semibold text-sm text-gray-900 list-none flex items-center justify-between gap-2">
                    <span>{t.problem}</span>
                    <Icon name="chevron-down" size={16} className="text-gray-400 group-open:rotate-180 transition flex-shrink-0" />
                  </summary>
                  <div className="mt-3 space-y-2 text-sm">
                    <div><span className="font-semibold text-gray-700">Likely cause:</span> <span className="text-gray-600">{t.diagnosis}</span></div>
                    <div><span className="font-semibold text-gray-700">Fix:</span> <span className="text-gray-600">{t.fix}</span></div>
                  </div>
                </details>
              ))}
            </div>
          </Section>

          <Section title="Support Checklist">
            <ol className="list-decimal list-inside space-y-2 text-sm text-gray-700">
              {SUPPORT_CHECKLIST.map((item, i) => <li key={i}>{item}</li>)}
            </ol>
          </Section>

          <Section title="Google OAuth Publishing — copy/paste setup">
            <div className="text-sm space-y-3">
              <p className="text-gray-800">
                To move the OAuth consent screen out of "Testing" and let any Google user sign in, paste these URLs into the GCP Console at <strong>APIs &amp; Services → OAuth consent screen</strong>:
              </p>
              <div className="border border-gray-200 rounded overflow-hidden">
                <Table headers={['Field', 'Value']} rows={[
                  ['App name', 'The Open CRM'],
                  ['User support email', 'johnbcoles@gmail.com'],
                  ['Developer contact email', 'johnbcoles@gmail.com'],
                  ['App home page', 'https://app.theopencrm.com'],
                  ['Privacy policy', 'https://app.theopencrm.com/privacy'],
                  ['Terms of service', 'https://app.theopencrm.com/terms'],
                  ['Data deletion request URL', 'https://app.theopencrm.com/data-deletion'],
                  ['Authorized domain', 'theopencrm.com'],
                  ['Scopes', 'openid, email, profile (non-sensitive — no verification needed)'],
                ]} />
              </div>
              <ol className="list-decimal list-inside text-gray-700 space-y-1 pt-2">
                <li>In GCP Console, ensure the apex domain <code className={CODE}>theopencrm.com</code> is listed under <strong>Authorized domains</strong>. (It must be a domain you own and have verified in Google Search Console.)</li>
                <li>Set <strong>User type</strong> to <em>External</em> so any Google user can sign in.</li>
                <li>Add the three URLs above for Privacy, Terms, and Data Deletion.</li>
                <li>Upload an app logo (120×120px PNG, &lt;1MB) for the consent screen — recommended but not strictly required for non-sensitive scopes.</li>
                <li>Click <strong>Publish App</strong>. Because we only request non-sensitive scopes (<code className={CODE}>openid email profile</code>), no Google review is required and the app moves to production immediately.</li>
                <li>If you later add sensitive scopes (Gmail, Drive, Calendar etc.), Google will require a verification submission — budget 4–8 weeks.</li>
              </ol>
            </div>
          </Section>

          <Section title="Liability & License">
            <Alert tone="danger" title={'THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.'}>
              <div className="space-y-2">
                <p>The complete legal disclaimer is in the <code className="text-xs bg-danger-100 px-1 py-0.5 rounded">LICENSE</code> file at the project root. It is also surfaced:</p>
                <ul className="list-disc list-inside space-y-1">
                  <li>as a click-through Terms of Use modal on first authenticated session</li>
                  <li>at the public <code className="text-xs bg-danger-100 px-1 py-0.5 rounded">GET /api/legal</code> endpoint (machine-readable)</li>
                  <li>in the footer of every generated quote PDF</li>
                  <li>in the body of every error response (with a stable <code className="text-xs bg-danger-100 px-1 py-0.5 rounded">requestId</code> for support correlation)</li>
                </ul>
                <p className="font-medium pt-1">John Coles assumes no liability for damages arising from use, misuse, or inability to use this Software. See LICENSE for full text including indemnification, governing law (New York), and acceptance terms.</p>
              </div>
            </Alert>
          </Section>

          <Section title="Onboarding a new contractor">
            <ol className="list-decimal list-inside space-y-2 text-sm text-gray-700">
              <li>Read any deployment-specific SOW in <code className={CODE}>userrequirementsandfeedback/</code>. For the Zang white-label, that contract's Exhibit A is the source of truth for stage/feature names.</li>
              <li>Clone the repo, bring up local Postgres 15+, <code className={CODE}>npm install</code> in both <code className={CODE}>backend/</code> and <code className={CODE}>frontend/</code>.</li>
              <li>Backend dev: copy env vars into <code className={CODE}>backend/.env</code>, run <code className={CODE}>npm run dev</code>.</li>
              <li>Frontend dev: copy <code className={CODE}>REACT_APP_*</code> into <code className={CODE}>frontend/.env</code>, run <code className={CODE}>npm start</code>.</li>
              <li><strong>Architecture mental model:</strong> <code className={CODE}>deals</code> is the umbrella record; <code className={CODE}>vendor_quotes</code>, <code className={CODE}>quotes</code>, <code className={CODE}>submittals</code>, <code className={CODE}>change_orders</code>, <code className={CODE}>issues</code>, <code className={CODE}>documents</code> all hang off of it. Org-scoping happens in every route via the <code className={CODE}>qs(req)</code> helper.</li>
              <li>Highest-leverage outstanding work is in "Known gaps" above. QuickBooks is the largest single item.</li>
            </ol>
          </Section>
        </div>
      </Container>
    </div>
  );
}
