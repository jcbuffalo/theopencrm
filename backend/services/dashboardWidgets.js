// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Dashboard widget registry — the single source of truth for which widgets a
// user may place on their /dashboard, and what each one renders FROM.
//
// Design rule (per the dashboard-customization slice): widgets COMPOSE
// existing, already-org-scoped endpoints — they never introduce new
// aggregation. `source` names the shared data fetch the frontend performs
// once per source and hands to every widget that declares it:
//
//   metrics    → GET /api/metrics/dashboard   (totals / issues / counts / funnel)
//   myday      → GET /api/my-day              (tasksDue / renewals / atRiskAccounts)
//   activities → GET /api/activities?limit=8  (recent activity feed)
//   forecast   → GET /api/forecast            (weighted pipeline + by-period)
//
// Adding a widget = add an entry here + a renderer in
// frontend/src/pages/Dashboard.js WIDGET_RENDERERS. No migration needed —
// user_dashboards.layout is opaque JSONB validated against this allowlist
// (schemas/dashboard.js imports WIDGET_KEYS).

const WIDGETS = {
  attention: {
    title: 'Needs your attention',
    description: 'Blocking issues, overdue tasks, and hot deals ranked by urgency.',
    source: 'metrics',
    defaultSize: 'full',
  },
  pipeline_value: {
    title: 'Pipeline',
    description: 'Active deal count, total pipeline value, and hot-deal count.',
    source: 'metrics',
    defaultSize: 'half',
  },
  hit_rate: {
    title: 'Hit rate (YTD)',
    description: 'Win percentage with won/lost counts and YTD won value.',
    source: 'metrics',
    defaultSize: 'half',
  },
  quick_links: {
    title: 'Quick links',
    description: 'One-tap paths to the Kanban and your contacts & companies.',
    source: 'metrics',
    defaultSize: 'full',
  },
  funnel: {
    title: 'Deal funnel',
    description: 'Open deals by stage (Zang orgs see the pre-sale funnel buckets).',
    source: 'metrics',
    defaultSize: 'half',
  },
  issues_breakdown: {
    title: 'Open issues by urgency',
    description: 'Red / yellow / green open-issue counts.',
    source: 'metrics',
    defaultSize: 'half',
  },
  record_counts: {
    title: 'Record counts',
    description: 'Customers, vendors, contacts, and quotes at a glance.',
    source: 'metrics',
    defaultSize: 'half',
  },
  my_tasks: {
    title: 'My tasks',
    description: 'Your open tasks due today or overdue.',
    source: 'myday',
    defaultSize: 'half',
  },
  renewals_due: {
    title: 'Renewals due',
    description: 'Active service contracts ending within 30 days.',
    source: 'myday',
    defaultSize: 'half',
  },
  at_risk_accounts: {
    title: 'At-risk accounts',
    description: 'Customer accounts flagged at_risk in the lifecycle.',
    source: 'myday',
    defaultSize: 'half',
  },
  recent_activity: {
    title: 'Recent activity',
    description: 'The latest logged calls, emails, meetings, and notes.',
    source: 'activities',
    defaultSize: 'half',
  },
  forecast: {
    title: 'Forecast',
    description: 'Weighted pipeline and open amount from the forecast engine.',
    source: 'forecast',
    defaultSize: 'half',
  },
};

const WIDGET_KEYS = Object.keys(WIDGETS);

// What a user with no saved row sees. Mirrors (and slightly extends) the old
// fixed dashboard so existing users lose nothing on day one: attention panel,
// the at-a-glance strip (pipeline + hit rate), the CTA cards, then the old
// "detail metrics" disclosure content (funnel / issues / counts) plus tasks.
const DEFAULT_LAYOUT = [
  { widgetKey: 'attention', size: 'full' },
  { widgetKey: 'pipeline_value', size: 'half' },
  { widgetKey: 'hit_rate', size: 'half' },
  { widgetKey: 'quick_links', size: 'full' },
  { widgetKey: 'my_tasks', size: 'half' },
  { widgetKey: 'issues_breakdown', size: 'half' },
  { widgetKey: 'funnel', size: 'half' },
  { widgetKey: 'record_counts', size: 'half' },
];

// Catalog shape the API returns to the frontend (array, stable order).
function catalog() {
  return WIDGET_KEYS.map((key) => ({ key, ...WIDGETS[key] }));
}

// Normalize a validated layout item to exactly what we persist. Unknown extra
// props are dropped; size falls back to the widget's registered default.
function sanitizeItem(item) {
  const def = WIDGETS[item.widgetKey];
  const size = item.size === 'full' || item.size === 'half' ? item.size : def.defaultSize;
  return { widgetKey: item.widgetKey, size };
}

module.exports = { WIDGETS, WIDGET_KEYS, DEFAULT_LAYOUT, catalog, sanitizeItem };
