// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// The information architecture for the authenticated app, in one place.
//
// `buildNavModel` turns (profile config, org feature flags, admin-ness) into
// the grouped top bar: a handful of primary entries (Chat · My Day · Pipeline
// · People · Customers · Reports, plus Ops for advanced-panel profiles) and
// the account menu that hangs off the avatar. Nav.js, the mobile sheet and
// the command palette all render from this model, so a page is never
// reachable from one surface and missing from another.
//
// Feature flags: a module whose flag is OFF is hidden here rather than left
// to 403 on click. `orgFeatures` is the effective map from /auth/me; when it
// is missing (older backend) every flag reads as ON so nothing disappears.
//
// Active state: pages pass `<Nav active="…" />` keys that predate this
// layout. Every key they already use is either an item `key` or listed in an
// item's `aliases`, so the right group lights up with zero page edits.

export function flagOn(orgFeatures, name) {
  if (!orgFeatures || typeof orgFeatures !== 'object') return true;
  if (!Object.prototype.hasOwnProperty.call(orgFeatures, name)) return true;
  return orgFeatures[name] !== false;
}

// { key, label, to, aliases?, keywords? } — `keywords` only feed the palette.
const item = (key, label, to, extra = {}) => ({ key, label, to, ...extra });

// `hasCustomers` (from /auth/me `org_has_customers`): false hides the
// post-sale Customers group and the lifecycle/retention reports until the org
// has its first customer-stage company or won deal — a day-one generic org
// otherwise shows five empty post-sale modules. null/undefined = unknown =
// show everything (older backend, personal workspace). Accounts stays under
// People because that is where the first account gets made.
export function buildNavModel({ cfg, orgFeatures, isAdmin, hasCustomers = null }) {
  const on = (name) => flagOn(orgFeatures, name);
  const advanced = !!cfg?.showAdvancedPanels;
  const cs = !!cfg?.showAccountManagement && on('customer_success_enabled');
  const postSale = cs && hasCustomers !== false;
  const reports = on('reports_enabled');

  const pipeline = [
    item('deals', 'Deals', '/deals', { keywords: 'pipeline kanban opportunities' }),
    on('leads_enabled') && item('leads', 'Leads', '/leads', { keywords: 'lead forms capture' }),
    item('tasks', 'Tasks', '/tasks', { keywords: 'todo follow-ups reminders' }),
    advanced
      ? on('quotes_enabled') && item('quotes', 'Quotes', '/quotes', { keywords: 'customer quotes rfq' })
      : on('products_enabled') && item('quote-builder', 'Quotes', '/quote-builder', { keywords: 'sales quote builder cpq' }),
    reports && item('forecast', 'Forecast', '/forecast', { keywords: 'projection weighted pipeline' }),
    on('products_enabled') && item('products', 'Products', '/products', { keywords: 'catalog price list' }),
    on('campaigns_enabled') && item('sequences', 'Email sequences', '/sequences', { keywords: 'campaigns drip outreach' }),
  ].filter(Boolean);

  const people = [
    item('contacts', 'Contacts', '/contacts', { keywords: 'people duplicates' }),
    item('companies', 'Companies', '/companies', { keywords: 'organizations vendors customers' }),
    cs && item('accounts', 'Accounts', '/accounts', { keywords: 'account 360 health' }),
    item('import', 'Import CSV', '/import', { keywords: 'upload spreadsheet migrate' }),
  ].filter(Boolean);

  const customers = postSale ? [
    item('renewals', 'Renewals & Contracts', '/renewals', { aliases: advanced ? [] : ['service-contracts'], keywords: 'service contracts expiring' }),
    item('cases', 'Cases', '/cases', { keywords: 'support tickets issues' }),
    item('playbooks', 'Playbooks', '/playbooks', { keywords: 'success onboarding steps' }),
    item('surveys', 'Surveys', '/surveys', { keywords: 'nps csat feedback' }),
    item('segments', 'Segments', '/segments', { keywords: 'cohorts bulk actions' }),
  ] : [];

  const reportsGroup = [
    item('dashboard', 'Dashboard', '/dashboard', { keywords: 'home widgets metrics' }),
    reports && item('reports', 'Reports', '/reports', { keywords: 'report builder commission analytics' }),
    postSale && item('lifecycle-funnel', 'Lifecycle', '/lifecycle-funnel', { keywords: 'funnel stages' }),
    postSale && item('retention', 'Retention & Win-back', '/retention', { aliases: ['winback'], keywords: 'churn winback' }),
  ].filter(Boolean);

  const ops = advanced ? [
    item('issues', 'Issues', '/issues', { keywords: 'urgency red yellow green' }),
    // Vendor quotes have no standalone route (they live inside the deal
    // panel + /quotes), so there is deliberately no entry for them here.
    item('service-contracts', 'Contracts', '/service-contracts', { keywords: 'service contracts' }),
    item('appreciation', 'Appreciation', '/appreciation', { keywords: 'gifts thank you customers' }),
  ].filter(Boolean) : [];

  const primary = [
    { type: 'link', key: 'chat', label: 'Chat', to: '/chat', primary: true, keywords: 'copilot ai assistant home' },
    { type: 'link', key: 'today', label: 'My Day', to: '/today', keywords: 'today agenda due' },
    { type: 'group', key: 'pipeline', label: 'Pipeline', items: pipeline },
    { type: 'group', key: 'people', label: 'People', items: people },
    { type: 'group', key: 'customers', label: 'Customers', items: customers },
    { type: 'group', key: 'reports', label: 'Reports', items: reportsGroup },
    { type: 'group', key: 'ops', label: 'Ops', items: ops },
  ]
    .filter((g) => g.type === 'link' || g.items.length > 0)
    // A group with a single surviving item is just a link — no empty chevron.
    .map((g) => (g.type === 'group' && g.items.length === 1
      ? { type: 'link', key: g.items[0].key, label: g.items[0].label, to: g.items[0].to, aliases: g.items[0].aliases, groupKey: g.key }
      : g));

  // Avatar menu — the "me and my workspace" surfaces. Ordered by frequency.
  const account = [
    item('settings', 'Settings', '/settings', { keywords: 'profile privacy legal notifications developer' }),
    item('team', 'Team', '/team', { keywords: 'members invite roles' }),
    item('usage', 'Usage & billing', '/usage', { keywords: 'ai spend stripe plan' }),
    on('plugins_enabled') && item('plugins', 'Plugins & automations', '/plugins', { keywords: 'tools library runs' }),
    item('calendar', 'Calendar', '/calendar', { keywords: 'meetings agenda' }),
    item('activities', 'Activities', '/activities', { keywords: 'log calls emails notes' }),
    item('notifications', 'Notifications', '/notifications', { keywords: 'inbox alerts' }),
    isAdmin && item('admin', 'Admin', '/admin', { aliases: ['email-templates'], keywords: 'feature flags branding access requests' }),
  ].filter(Boolean);

  return { primary, account };
}

// Which primary entry (and which item within it) is active for a page key.
export function resolveActive(model, activeKey) {
  if (!activeKey) return { groupKey: null, itemKey: null };
  const matches = (it) => it.key === activeKey || (it.aliases || []).includes(activeKey);
  for (const entry of model.primary) {
    if (entry.type === 'link') {
      if (matches(entry)) return { groupKey: entry.groupKey || entry.key, itemKey: entry.key };
      continue;
    }
    const hit = entry.items.find(matches);
    if (hit) return { groupKey: entry.key, itemKey: hit.key };
  }
  const acct = model.account.find(matches);
  if (acct) return { groupKey: 'account', itemKey: acct.key };
  return { groupKey: null, itemKey: null };
}

// Admin destinations. `superAdmin` marks pages that gate to platform staff;
// the hub shows them with a badge, the palette hides them from org admins.
export const ADMIN_PAGES = [
  { key: 'access-requests',       label: 'Access requests',       to: '/admin/access-requests',       description: 'Approve or decline people asking to join.',                 keywords: 'signup approve pending' },
  { key: 'users',                 label: 'Users',                 to: '/admin/users',                 description: 'Every user across the platform, with roles and status.',     keywords: 'members roles' },
  { key: 'feature-flags',         label: 'Feature flags',         to: '/admin/feature-flags',         description: 'Turn modules on or off for this org.',                       keywords: 'modules toggles enable disable' },
  { key: 'branding',              label: 'Branding',              to: '/admin/branding',              description: 'Display name, logo, primary color and label overrides.',     keywords: 'white label logo colors' },
  { key: 'customizations',        label: 'Customizations',        to: '/admin/customizations',        description: 'Custom fields and Claude-proposed org tweaks.',              keywords: 'custom fields ai proposals' },
  { key: 'email-templates',       label: 'Email templates',       to: '/admin/email-templates',       description: 'Templates used by sends, sequences and notifications.',      keywords: 'email copy' },
  { key: 'automation',            label: 'Automation rules',      to: '/admin/automation',            description: 'When X happens, do Y — org-defined rules.',                  keywords: 'triggers workflows' },
  { key: 'integrations',          label: 'Integrations',          to: '/admin/integrations',          description: 'QuickBooks, Teams, Zoom, Drive, Gmail and Outlook.',        keywords: 'quickbooks teams zoom drive gmail outlook connect' },
  { key: 'sso',                   label: 'Enterprise SSO',        to: '/admin/sso',                   description: 'OIDC login and SCIM provisioning.',                          keywords: 'oidc scim saml' },
  { key: 'ai-model',              label: 'AI model',              to: '/admin/ai-model',              description: 'Which Claude model and reasoning effort this org uses.',     keywords: 'claude model effort' },
  { key: 'activity',              label: 'Activity (24h)',        to: '/admin/activity',              description: 'What your org did in the last day.',                         keywords: 'audit log recent' },
  { key: 'pitch-readiness',       label: 'Pitch readiness',       to: '/admin/pitch-readiness',       description: 'Live green / yellow / red feature health.',                   keywords: 'health demo status' },
  { key: 'platform-integrations', label: 'Platform integrations', to: '/admin/platform-integrations', description: 'OAuth client credentials for Drive, Gmail and friends.',     keywords: 'oauth credentials client id', superAdmin: true },
  { key: 'provision-org',         label: 'Provision org',         to: '/admin/provision-org',         description: 'Onboard a brand-new customer organization.',                 keywords: 'new org tenant onboard', superAdmin: true },
  { key: 'ai-billing',            label: 'AI billing',            to: '/admin/ai-billing',            description: 'Pay-as-you-go AI status and month-to-date usage per org.',   keywords: 'stripe overage comp trial', superAdmin: true },
  { key: 'traffic',               label: 'Traffic',               to: '/admin/traffic',               description: 'First-party page-load analytics — no third-party trackers.', keywords: 'analytics pageviews visitors referrers', superAdmin: true },
];

// Every authenticated destination, flat, for the command palette's "Go to"
// matcher. Includes pages demoted out of the bar (Duplicates, Handoff, the
// report builder, …) so they stay one keystroke away.
export function buildDestinations({ cfg, orgFeatures, isAdmin, isSuperAdmin }) {
  const model = buildNavModel({ cfg, orgFeatures, isAdmin });
  const out = [];
  const push = (d, group) => out.push({ ...d, group });
  for (const entry of model.primary) {
    if (entry.type === 'link') push(entry, null);
    else entry.items.forEach((it) => push(it, entry.label));
  }
  model.account.forEach((it) => push(it, 'Account'));

  const extras = [
    item('duplicates', 'Find duplicates', '/duplicates', { keywords: 'merge dedupe contacts companies' }),
    flagOn(orgFeatures, 'reports_enabled') && item('report-builder', 'Report builder', '/reports/builder', { keywords: 'custom report' }),
    item('security', 'Security settings', '/security', { keywords: '2fa two-factor password verify email' }),
    item('developer', 'Developer settings', '/settings/developer', { keywords: 'api keys webhooks pat' }),
    item('handoff', 'Tech handoff', '/handoff', { keywords: 'architecture docs schema' }),
    item('privacy-data', 'Privacy & data', '/settings#privacy', { keywords: 'export delete account gdpr' }),
    flagOn(orgFeatures, 'plugins_enabled') && item('plugin-library', 'Plugin library', '/plugins/library', { keywords: 'curated plugins' }),
    flagOn(orgFeatures, 'plugins_enabled') && item('plugin-new', 'New plugin', '/plugins/new', { keywords: 'build tool from prompt' }),
  ].filter(Boolean);
  extras.forEach((it) => push(it, 'More'));

  if (isAdmin) {
    ADMIN_PAGES
      .filter((p) => !p.superAdmin || isSuperAdmin)
      .forEach((p) => push(item(`admin-${p.key}`, p.label, p.to, { keywords: p.keywords }), 'Admin'));
  }
  return out;
}

// Quick-add commands — surfaced at the top of the command palette (as a
// "Create" section, always visible with an empty query) and behind the '+'
// button in the top bar / the mobile sheet. Kept here, not in
// CommandPalette.js, so Nav.js and MobileSheet.js can render them as plain
// links without importing the palette.
export const CREATE_COMMANDS = [
  { key: 'new-contact', label: 'New contact', to: '/contacts?new=1', keywords: 'add create contact person' },
  { key: 'new-deal',    label: 'New deal',    to: '/deals?new=1',    keywords: 'add create deal opportunity pipeline' },
  { key: 'new-task',    label: 'New task',    to: '/tasks?new=1',    keywords: 'add create task todo followup' },
  { key: 'log-call',    label: 'Log a call',  to: '/activities?new=call', keywords: 'add create call log activity phone' },
];

// Tiny scorer for the palette: every whitespace token of the query must
// appear in the label or keywords; label-prefix matches rank first.
export function matchDestinations(destinations, query, limit = 6) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const d of destinations) {
    const label = d.label.toLowerCase();
    const hay = `${label} ${(d.keywords || '')} ${(d.group || '')}`.toLowerCase();
    if (!tokens.every((t) => hay.includes(t))) continue;
    let score = 0;
    if (label === q) score += 100;
    else if (label.startsWith(q)) score += 60;
    else if (label.includes(q)) score += 40;
    else if (tokens.every((t) => label.includes(t))) score += 25;
    scored.push({ d, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.d);
}
