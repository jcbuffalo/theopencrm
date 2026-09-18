// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Dashboard — the post-sign-in landing, now CUSTOMIZABLE per user.
//
// Design intent is unchanged: every user, every visit, the screen should
// answer "do I have something urgent?" and "what's my pipeline doing?" in the
// first 5 seconds. What changed: the page is now a per-user COMPOSITION of
// widgets persisted at /api/dashboard/layout (migration 142). Users with no
// saved layout get the server's DEFAULT_LAYOUT, which mirrors the old fixed
// page — attention panel, pipeline strip, CTAs, then the old detail-metrics
// content as individual widgets — so existing users lose nothing.
//
// Architecture:
//   * GET /api/dashboard/layout → { layout, saved, defaultLayout, widgets }.
//     `widgets` is the backend's allowlisted catalog (title / description /
//     source / defaultSize) — the "Add widget" picker renders from it, so the
//     frontend can never offer a key the backend would reject.
//   * Widgets render from EXISTING endpoints, fetched ONCE per source:
//       metrics    → GET /metrics/dashboard
//       myday      → GET /my-day
//       activities → GET /activities?limit=8
//       forecast   → GET /forecast
//     Only sources required by the current layout are fetched.
//   * Customize mode uses simple, reliable controls (move up/down, resize
//     half/full, remove, add) instead of drag — @dnd-kit/sortable isn't a dep
//     and the Kanban's core-only drag doesn't fit a reorder list.
//   * PUT /api/dashboard/layout persists; "Reset to default" restores the
//     server's defaultLayout.
//   * Lightweight profiles (everything without the manufacturer's-rep panels)
//     get the DEFAULT layout capped at DEFAULT_WIDGET_CAP widgets so a fresh
//     workspace reads as one calm screen — the rest stay one click away in
//     Customize. A user's SAVED layout is never trimmed.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../AuthContext';
import Nav from '../components/Nav';
import { getStageConfig } from '../stages';
import { Alert, Button, Card, Container, EmptyState, Icon, PageHeader, Skeleton, Spinner } from '../components/ui';

// How many widgets a never-customised lightweight (non-advanced) org sees by
// default. The server's DEFAULT_LAYOUT stays the source of truth for ORDER;
// this only trims the tail.
export const DEFAULT_WIDGET_CAP = 5;

function fmtMoney(n) {
  if (!n) return '$0';
  const num = Number(n);
  if (num >= 1000000) return `$${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `$${(num / 1000).toFixed(0)}K`;
  return `$${num.toLocaleString()}`;
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Time-of-day greeting — the same treatment as My Day so the two "landing"
// pages read as one system.
function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/** Build a ranked attention list. Returns 0-3 items, most urgent first. */
function buildAttentionItems({ totals, issues, tasks }) {
  const items = [];
  if ((issues?.blocking_open || 0) > 0) {
    items.push({
      tone: 'red',
      title: `${issues.blocking_open} blocking issue${issues.blocking_open > 1 ? 's' : ''} need triage`,
      hint: 'Issues marked "blocks workflow" — deals can\'t advance until these clear.',
      cta: { label: 'Open Issues', to: '/issues' },
    });
  }
  if ((tasks?.overdue_tasks || 0) > 0) {
    items.push({
      tone: 'amber',
      title: `${tasks.overdue_tasks} overdue task${tasks.overdue_tasks > 1 ? 's' : ''}`,
      hint: 'Things scheduled to be done by now that aren\'t.',
      cta: { label: 'Open Tasks', to: '/tasks' },
    });
  }
  if ((issues?.red_open || 0) > 0) {
    items.push({
      tone: 'red',
      title: `${issues.red_open} red-urgency issue${issues.red_open > 1 ? 's' : ''}`,
      hint: 'High-impact issues open across deals.',
      cta: { label: 'Open Issues', to: '/issues' },
    });
  }
  if ((totals?.hot_count || 0) > 0 && items.length < 3) {
    items.push({
      tone: 'amber',
      icon: 'flame',
      title: `${totals.hot_count} hot deal${totals.hot_count > 1 ? 's' : ''} in pipeline`,
      hint: 'Marked hot — high priority for the next conversation.',
      cta: { label: 'Open Kanban', to: '/deals?hot=true' },
    });
  }
  return items.slice(0, 3);
}

const ATTENTION_TONES = {
  red:   { bg: 'bg-danger-50',  border: 'border-danger-200',  title: 'text-danger-900',  sub: 'text-danger-800',  btn: 'bg-danger-600 hover:bg-danger-700',   icon: 'text-danger-600' },
  amber: { bg: 'bg-warning-50', border: 'border-warning-200', title: 'text-warning-900', sub: 'text-warning-800', btn: 'bg-warning-600 hover:bg-warning-700', icon: 'text-warning-600' },
};

function AttentionPanel({ items }) {
  if (items.length === 0) {
    return (
      <Card className="h-full border-success-200 bg-success-50">
        <div className="flex items-center gap-3">
          <Icon name="check-circle" size={28} className="text-success-600 flex-shrink-0" />
          <div>
            <h2 className="text-base font-semibold text-success-900">All clear</h2>
            <p className="text-sm text-success-800">No blocking issues, no overdue tasks. Open the Kanban to keep moving deals forward.</p>
          </div>
        </div>
        <Button as={Link} to="/deals" size="sm" iconRight="arrow-right" className="mt-3">Open Kanban</Button>
      </Card>
    );
  }
  return (
    <Card title="Needs your attention" className="h-full">
      <div className="space-y-2">
        {items.map((it, i) => {
          const t = ATTENTION_TONES[it.tone] || ATTENTION_TONES.amber;
          return (
            <div key={i} className={`${t.bg} ${t.border} border rounded p-3 flex items-center justify-between gap-3 flex-wrap`}>
              <div className="min-w-0 flex-1 flex items-start gap-2">
                {it.icon && <Icon name={it.icon} size={16} className={`mt-0.5 flex-shrink-0 ${t.icon}`} />}
                <div className="min-w-0">
                  <div className={`font-semibold text-sm ${t.title}`}>{it.title}</div>
                  <div className={`text-xs ${t.sub}`}>{it.hint}</div>
                </div>
              </div>
              <Link to={it.cta.to} className={`${t.btn} text-white text-sm font-semibold px-3 py-1.5 rounded-md flex-shrink-0 inline-flex items-center gap-1`}>
                {it.cta.label}
                <Icon name="arrow-right" size={14} />
              </Link>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** A single metric in a strip. Tappable when `to` is provided. */
function Metric({ label, value, sub, tone = 'gray', to, icon }) {
  const tones = {
    gray:    'text-gray-900',
    green:   'text-success-600',
    blue:    'text-brand-blue',
    red:     'text-danger-600',
    amber:   'text-warning-600',
    purple:  'text-purple-600',
  };
  const Wrapper = to ? Link : 'div';
  const wrapperProps = to ? { to, className: 'block hover:bg-gray-50 transition' } : {};
  return (
    <Wrapper {...wrapperProps} className={`${wrapperProps.className || ''} p-4 border-r last:border-r-0 border-gray-100`}>
      <div className="text-xs uppercase tracking-wider text-gray-500 font-semibold flex items-center gap-1">
        {icon && <Icon name={icon} size={12} className={tones[tone]} />}
        {label}
      </div>
      <div className={`text-2xl font-semibold tracking-tight mt-1 ${tones[tone]}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </Wrapper>
  );
}

/** Shared card chrome for list-style widgets. */
function WidgetCard({ title, linkTo, linkLabel, children }) {
  return (
    <Card
      title={title}
      className="h-full"
      actions={linkTo && (
        <Link to={linkTo} className="inline-flex items-center gap-1 text-xs text-brand-blue font-semibold hover:underline flex-shrink-0">
          {linkLabel || 'View all'}
          <Icon name="arrow-right" size={12} />
        </Link>
      )}
    >
      {children}
    </Card>
  );
}

function EmptyNote({ children }) {
  return <p className="text-sm text-gray-400 py-2">{children}</p>;
}

function LoadingNote() {
  return <Skeleton lines={3} className="py-1" />;
}

function CaughtUp({ children }) {
  return (
    <p className="text-sm text-gray-400 py-2 inline-flex items-center gap-1.5">
      <Icon name="check-circle" size={14} className="text-success-600" />
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Widget renderers — one per allowlisted widgetKey. Each receives the shared
// `data` map (keyed by source) + orgProfile and renders purely from it.
// ---------------------------------------------------------------------------

function AttentionWidget({ data }) {
  const m = data.metrics;
  if (!m) return <WidgetCard title="Needs your attention"><LoadingNote /></WidgetCard>;
  return <AttentionPanel items={buildAttentionItems({ totals: m.totals || {}, issues: m.issues || {}, tasks: m.tasks || {} })} />;
}

function PipelineValueWidget({ data }) {
  const t = data.metrics?.totals || {};
  const totalPipelineValue = Number(t.pre_sale_value || 0) + Number(t.post_sale_value || 0);
  const totalActiveDeals = Number(t.pre_sale_count || 0) + Number(t.post_sale_count || 0);
  return (
    <Card padding="none" className="overflow-hidden h-full">
      <div className="grid grid-cols-2 divide-x divide-gray-100">
        <Metric label="Active deals" value={totalActiveDeals} sub={fmtMoney(totalPipelineValue)} tone="blue" to="/deals" />
        <Metric label="Hot" icon="flame" value={t.hot_count || 0} tone="red" to="/deals?hot=true" />
      </div>
    </Card>
  );
}

function HitRateWidget({ data }) {
  const t = data.metrics?.totals || {};
  const wonCount = Number(t.won_count || 0);
  const lostCount = Number(t.lost_count || 0);
  const hitRate = (wonCount + lostCount) > 0 ? Math.round((wonCount / (wonCount + lostCount)) * 100) : null;
  return (
    <Card padding="none" className="overflow-hidden h-full">
      <div className="grid grid-cols-2 divide-x divide-gray-100">
        <Metric label="Hit rate (YTD)" value={hitRate !== null ? `${hitRate}%` : '—'} sub={`${wonCount} won · ${lostCount} lost`} tone={hitRate >= 50 ? 'green' : 'amber'} />
        <Metric label="YTD won" value={fmtMoney(t.won_value)} tone="green" />
      </div>
    </Card>
  );
}

function QuickLinksWidget({ data }) {
  const c = data.metrics?.counts || {};
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 h-full">
      <Link to="/deals" className="bg-brand-blue hover:bg-brand-blue-dark text-white rounded p-5 transition flex items-center justify-between gap-3 shadow-card">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider opacity-80">Where work happens</div>
          <div className="text-lg font-semibold mt-1">Open the Kanban</div>
          <div className="text-xs opacity-80 mt-0.5">Drag deals between stages, add notes, review next steps.</div>
        </div>
        <Icon name="arrow-right" size={22} className="flex-shrink-0" />
      </Link>
      <Link to="/contacts" className="bg-white hover:bg-gray-50 border border-gray-200 rounded p-5 transition flex items-center justify-between gap-3 shadow-card">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-gray-500">Your network</div>
          <div className="text-lg font-semibold mt-1 text-gray-900">Contacts &amp; Companies</div>
          <div className="text-xs text-gray-500 mt-0.5">{c.contacts || 0} contacts · {c.customers || 0} customers · {c.vendors || 0} vendors</div>
        </div>
        <Icon name="arrow-right" size={22} className="flex-shrink-0 text-gray-400" />
      </Link>
    </div>
  );
}

function FunnelWidget({ data, orgProfile }) {
  const m = data.metrics;
  // Zang orgs get the SOW pre-sale funnel buckets; everyone else gets their
  // open deals by stage from the same /metrics/dashboard payload.
  if (orgProfile === 'zang' && m?.pre_sale_funnel) {
    const f = m.pre_sale_funnel;
    return (
      <WidgetCard title="Pre-sale funnel" linkTo="/deals" linkLabel="Open Kanban">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            ['Triage', f.triage],
            ['Vendor Quoting', f.vendor_quoting],
            ['Customer Quoting', f.customer_quoting],
            ['Follow Up', f.follow_up],
          ].map(([label, val]) => (
            <Link key={label} to="/deals" className="text-center hover:bg-gray-50 rounded-md p-2 border border-gray-100">
              <div className="text-xl font-semibold text-gray-900">{val || 0}</div>
              <div className="text-[10px] text-gray-500 uppercase">{label}</div>
            </Link>
          ))}
        </div>
      </WidgetCard>
    );
  }
  const stages = (m?.by_stage || []).filter(s => Number(s.count) > 0).slice(0, 6);
  return (
    <WidgetCard title="Deal funnel" linkTo="/deals" linkLabel="Open Kanban">
      {!m ? <LoadingNote /> : stages.length === 0 ? (
        <EmptyNote>No deals yet — the funnel fills in as deals move through stages.</EmptyNote>
      ) : (
        <div className="space-y-1.5">
          {stages.map(s => (
            <Link key={s.stage} to="/deals" className="flex items-center justify-between gap-2 hover:bg-gray-50 rounded-md px-2 py-1.5">
              <span className="text-xs font-semibold text-gray-600 uppercase truncate">{String(s.stage).replace(/_/g, ' ')}</span>
              <span className="text-sm font-semibold text-gray-900 flex-shrink-0">{s.count} <span className="text-xs font-normal text-gray-500">· {fmtMoney(s.value)}</span></span>
            </Link>
          ))}
        </div>
      )}
    </WidgetCard>
  );
}

function IssuesBreakdownWidget({ data }) {
  const i = data.metrics?.issues || {};
  return (
    <WidgetCard title="Open issues by urgency" linkTo="/issues" linkLabel="Open Issues">
      <div className="grid grid-cols-3 gap-2">
        <Link to="/issues?urgency=red" className="bg-danger-50 border border-danger-200 rounded-md p-3 text-center hover:bg-danger-100">
          <div className="text-2xl font-semibold text-danger-700">{i.red_open || 0}</div>
          <div className="text-[10px] text-danger-700 uppercase font-semibold">Red</div>
        </Link>
        <Link to="/issues?urgency=yellow" className="bg-warning-50 border border-warning-200 rounded-md p-3 text-center hover:bg-warning-100">
          <div className="text-2xl font-semibold text-warning-700">{i.yellow_open || 0}</div>
          <div className="text-[10px] text-warning-700 uppercase font-semibold">Yellow</div>
        </Link>
        <Link to="/issues?urgency=green" className="bg-success-50 border border-success-200 rounded-md p-3 text-center hover:bg-success-100">
          <div className="text-2xl font-semibold text-success-700">{i.green_open || 0}</div>
          <div className="text-[10px] text-success-700 uppercase font-semibold">Green</div>
        </Link>
      </div>
    </WidgetCard>
  );
}

// Vendors + Quotes tiles are manufacturer's-rep concepts (the /quotes page
// and the vendor company type only mean something with showAdvancedPanels);
// generic orgs get Customers + Contacts.
function RecordCountsWidget({ data, advanced }) {
  const c = data.metrics?.counts || {};
  const tiles = [
    { to: '/companies?type=customer', n: c.customers, label: 'Customers' },
    advanced && { to: '/companies?type=vendor', n: c.vendors, label: 'Vendors' },
    { to: '/contacts', n: c.contacts, label: 'Contacts' },
    advanced && { to: '/quotes', n: c.quotes, label: 'Quotes' },
  ].filter(Boolean);
  return (
    <WidgetCard title="Record counts">
      <div className={`grid grid-cols-2 ${tiles.length > 2 ? 'sm:grid-cols-4' : ''} gap-2 text-center`}>
        {tiles.map(t => (
          <Link key={t.label} to={t.to} className="hover:bg-gray-50 rounded-md p-2">
            <div className="text-lg font-semibold text-gray-900">{t.n || 0}</div>
            <div className="text-[10px] text-gray-500 uppercase">{t.label}</div>
          </Link>
        ))}
      </div>
    </WidgetCard>
  );
}

function MyTasksWidget({ data }) {
  const tasks = data.myday?.tasksDue;
  return (
    <WidgetCard title="My tasks" linkTo="/tasks" linkLabel="Open Tasks">
      {!tasks ? <LoadingNote /> : tasks.length === 0 ? (
        <CaughtUp>Nothing due today.</CaughtUp>
      ) : (
        <ul className="space-y-1.5">
          {tasks.slice(0, 6).map(t => (
            <li key={t.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-gray-900 truncate">{t.title}</span>
              {t.overdue_days > 0 ? (
                <span className="text-[10px] font-semibold text-danger-700 bg-danger-50 border border-danger-200 rounded-md px-1.5 py-0.5 flex-shrink-0">
                  {t.overdue_days}d overdue
                </span>
              ) : (
                <span className="text-xs text-gray-500 flex-shrink-0">{fmtDate(t.due_date)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

function RenewalsDueWidget({ data }) {
  const renewals = data.myday?.renewals;
  return (
    <WidgetCard title="Renewals due (30d)" linkTo="/service-contracts" linkLabel="Contracts">
      {!renewals ? <LoadingNote /> : renewals.length === 0 ? (
        <EmptyNote>No contracts ending in the next 30 days.</EmptyNote>
      ) : (
        <ul className="space-y-1.5">
          {renewals.slice(0, 6).map(r => (
            <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">
                <span className="text-gray-900">{r.name}</span>
                {r.customer_name && <span className="text-gray-500"> · {r.customer_name}</span>}
              </span>
              <span className="text-[10px] font-semibold text-warning-700 bg-warning-50 border border-warning-200 rounded-md px-1.5 py-0.5 flex-shrink-0">
                {r.days_to_end}d left
              </span>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

function AtRiskAccountsWidget({ data }) {
  const accounts = data.myday?.atRiskAccounts;
  return (
    <WidgetCard title="At-risk accounts" linkTo="/companies" linkLabel="Companies">
      {!accounts ? <LoadingNote /> : accounts.length === 0 ? (
        <CaughtUp>No accounts flagged at-risk.</CaughtUp>
      ) : (
        <ul className="space-y-1.5">
          {accounts.slice(0, 6).map(a => (
            <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-gray-900 truncate">{a.name}</span>
              <span className="text-xs text-gray-500 flex-shrink-0">{a.industry || ''}</span>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

function RecentActivityWidget({ data }) {
  const acts = data.activities;
  return (
    <WidgetCard title="Recent activity" linkTo="/activities" linkLabel="All activity">
      {!acts ? <LoadingNote /> : acts.length === 0 ? (
        <EmptyNote>No activity logged yet.</EmptyNote>
      ) : (
        <ul className="space-y-1.5">
          {acts.slice(0, 6).map(a => (
            <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">
                <span className="text-[10px] font-semibold text-gray-500 uppercase mr-1.5">{a.type}</span>
                <span className="text-gray-900">{a.title}</span>
              </span>
              <span className="text-xs text-gray-500 flex-shrink-0">{fmtDate(a.activity_date)}</span>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

function ForecastWidget({ data }) {
  const f = data.forecast;
  return (
    <WidgetCard title="Forecast" linkTo="/reports" linkLabel="Reports">
      {!f ? <LoadingNote /> : (
        <div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md border border-gray-100 p-3 text-center">
              <div className="text-xl font-semibold text-brand-blue">{fmtMoney(f.weighted_pipeline)}</div>
              <div className="text-[10px] text-gray-500 uppercase">Weighted pipeline</div>
            </div>
            <div className="rounded-md border border-gray-100 p-3 text-center">
              <div className="text-xl font-semibold text-gray-900">{fmtMoney(f.open_amount)}</div>
              <div className="text-[10px] text-gray-500 uppercase">{f.open_count || 0} open deals</div>
            </div>
          </div>
          {Array.isArray(f.by_period) && f.by_period.length > 0 && (
            <div className="mt-3 space-y-1">
              {f.by_period.slice(0, 3).map(p => (
                <div key={p.period} className="flex items-center justify-between text-xs">
                  <span className="text-gray-500">{p.period}</span>
                  <span className="font-semibold text-gray-900">{fmtMoney(p.weighted)} <span className="font-normal text-gray-500">weighted</span></span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </WidgetCard>
  );
}

// Widgets that only make sense for profiles with the advanced (manufacturer's
//-rep) panels — filtered out of the layout, catalog and add-tray otherwise.
const ADVANCED_ONLY_WIDGETS = new Set(['issues_breakdown']);

const WIDGET_RENDERERS = {
  attention: AttentionWidget,
  pipeline_value: PipelineValueWidget,
  hit_rate: HitRateWidget,
  quick_links: QuickLinksWidget,
  funnel: FunnelWidget,
  issues_breakdown: IssuesBreakdownWidget,
  record_counts: RecordCountsWidget,
  my_tasks: MyTasksWidget,
  renewals_due: RenewalsDueWidget,
  at_risk_accounts: AtRiskAccountsWidget,
  recent_activity: RecentActivityWidget,
  forecast: ForecastWidget,
};

// How each source is fetched (once) when any active widget needs it.
const SOURCE_FETCHERS = {
  metrics:    () => api.get('/metrics/dashboard').then(r => r.data),
  myday:      () => api.get('/my-day').then(r => r.data),
  activities: () => api.get('/activities?limit=8').then(r => r.data),
  forecast:   () => api.get('/forecast').then(r => r.data),
};

// Small square icon button for the per-widget customize controls.
function WidgetControl({ icon, label, onClick, disabled, danger }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`w-7 h-7 inline-flex items-center justify-center rounded-md disabled:opacity-30 ${danger ? 'text-danger-600 hover:bg-danger-50' : 'text-gray-600 hover:bg-gray-100'}`}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const { user, orgProfile } = useAuth();
  const cfg = getStageConfig(orgProfile);
  const advanced = !!cfg.showAdvancedPanels;
  const keepWidget = useCallback(
    (key) => advanced || !ADVANCED_ONLY_WIDGETS.has(key),
    [advanced],
  );

  const [layout, setLayout] = useState(null);          // saved/live layout
  const [defaultLayout, setDefaultLayout] = useState([]);
  const [widgetCatalog, setWidgetCatalog] = useState([]); // [{key,title,description,source,defaultSize}]
  const [data, setData] = useState({});                // source → payload
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);              // working copy in edit mode
  const [saving, setSaving] = useState(false);

  const fetchedSources = useRef(new Set());

  const catalogByKey = useMemo(() => {
    const m = {};
    for (const w of widgetCatalog) m[w.key] = w;
    return m;
  }, [widgetCatalog]);

  // 1. Load the layout (+ catalog + default) once. Lightweight profiles get
  //    the server default trimmed to DEFAULT_WIDGET_CAP; a saved layout is
  //    the user's own and is never trimmed.
  useEffect(() => {
    api.get('/dashboard/layout')
      .then(r => {
        const cap = (items) => (advanced ? items : items.slice(0, DEFAULT_WIDGET_CAP));
        const serverDefault = (r.data.defaultLayout || []).filter(it => keepWidget(it.widgetKey));
        const live = (r.data.layout || []).filter(it => keepWidget(it.widgetKey));
        setLayout(r.data.saved ? live : cap(live));
        setDefaultLayout(cap(serverDefault));
        setWidgetCatalog((r.data.widgets || []).filter(w => keepWidget(w.key)));
      })
      .catch(e => setError(e.response?.data?.error || 'Failed to load dashboard layout'))
      .finally(() => setLoading(false));
  }, [keepWidget, advanced]);

  // 2. Fetch each data source at most once, only when some visible widget
  //    needs it (edit-mode draft counts, so newly added widgets hydrate live).
  const activeLayout = editing ? draft : layout;
  useEffect(() => {
    if (!activeLayout || widgetCatalog.length === 0) return;
    const needed = new Set(
      activeLayout.map(it => catalogByKey[it.widgetKey]?.source).filter(Boolean)
    );
    for (const source of needed) {
      if (fetchedSources.current.has(source) || !SOURCE_FETCHERS[source]) continue;
      fetchedSources.current.add(source);
      SOURCE_FETCHERS[source]()
        .then(payload => setData(prev => ({ ...prev, [source]: payload })))
        .catch(() => {
          // Leave the slot empty — widgets render their own empty states. A
          // feature-gated source (e.g. forecast without reports_enabled)
          // shouldn't take down the whole dashboard.
          setData(prev => ({ ...prev, [source]: prev[source] ?? null }));
        });
    }
  }, [activeLayout, catalogByKey, widgetCatalog]);

  // --- edit-mode actions -----------------------------------------------------
  const startEditing = () => { setDraft(layout.map(it => ({ ...it }))); setEditing(true); };
  const cancelEditing = () => { setEditing(false); setDraft([]); };

  const move = (idx, dir) => {
    setDraft(d => {
      const next = [...d];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return d;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };
  const removeWidget = (idx) => setDraft(d => d.filter((_, i) => i !== idx));
  const toggleSize = (idx) => setDraft(d => d.map((it, i) => (
    i === idx ? { ...it, size: it.size === 'full' ? 'half' : 'full' } : it
  )));
  const addWidget = (key) => {
    const def = catalogByKey[key];
    setDraft(d => (d.some(it => it.widgetKey === key) ? d : [...d, { widgetKey: key, size: def?.defaultSize || 'half' }]));
  };
  const resetToDefault = () => setDraft(defaultLayout.map(it => ({ ...it })));

  const saveLayout = useCallback(async () => {
    setSaving(true);
    setError('');
    try {
      const r = await api.put('/dashboard/layout', { layout: draft.map(({ widgetKey, size }) => ({ widgetKey, size })) });
      setLayout(r.data.layout || draft);
      setEditing(false);
      setDraft([]);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save dashboard layout');
    } finally {
      setSaving(false);
    }
  }, [draft]);

  // --- render ------------------------------------------------------------------
  const firstName = (user?.name || '').split(' ')[0];
  const todayLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const shown = activeLayout || [];
  const availableToAdd = widgetCatalog.filter(w => !shown.some(it => it.widgetKey === w.key));

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="dashboard" />
      <Container>
        <PageHeader
          title={`${greeting()}${firstName ? `, ${firstName}` : ''}`}
          subtitle={`${todayLabel} · Your pipeline at a glance.`}
          primaryAction={editing ? { label: 'Save layout', icon: 'check', onClick: saveLayout, loading: saving, loadingLabel: 'Saving…' } : undefined}
          secondaryActions={editing ? [
            { label: 'Cancel', inline: true, onClick: cancelEditing },
            { label: 'Reset to default', icon: 'refresh', onClick: resetToDefault },
          ] : [
            { label: 'Customize', icon: 'settings', inline: true, onClick: startEditing, disabled: loading },
          ]}
        />

        <div className="space-y-6">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          {editing && (
            <Alert tone="info" title="Customize mode">
              Reorder with the arrows, resize with Half / Full, remove with ×, and add widgets from the tray below. Nothing is saved until you hit <span className="font-semibold">Save layout</span>.
            </Alert>
          )}

          {loading ? (
            <Spinner size="lg" label="Loading your dashboard…" />
          ) : shown.length === 0 ? (
            /* Widget grid — full = span 2, half = span 1 (stacks to 1 col on phones) */
            <Card padding="none" className="border-dashed">
              <EmptyState
                icon="inbox"
                title="Your dashboard is empty"
                message={editing ? 'Add widgets from the tray below.' : 'Hit Customize to add widgets.'}
                action={!editing && <Button variant="secondary" icon="settings" onClick={startEditing}>Customize</Button>}
              />
            </Card>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {shown.map((item, idx) => {
                const Renderer = WIDGET_RENDERERS[item.widgetKey];
                if (!Renderer) return null; // unknown key from a future version — skip quietly
                const meta = catalogByKey[item.widgetKey];
                const span = item.size === 'full' ? 'sm:col-span-2' : '';
                return (
                  <div key={item.widgetKey} className={`${span} relative min-w-0`}>
                    {editing && (
                      <div className="absolute -top-3 right-2 z-10 flex items-center gap-0.5 bg-white border border-gray-200 rounded-md shadow-card px-1.5 py-1">
                        <span className="text-[10px] font-semibold text-gray-500 uppercase px-1 max-w-[10rem] truncate">{meta?.title || item.widgetKey}</span>
                        <WidgetControl icon="chevron-up" label="Move up" onClick={() => move(idx, -1)} disabled={idx === 0} />
                        <WidgetControl icon="chevron-down" label="Move down" onClick={() => move(idx, 1)} disabled={idx === shown.length - 1} />
                        <button
                          type="button"
                          onClick={() => toggleSize(idx)}
                          title={item.size === 'full' ? 'Make half width' : 'Make full width'}
                          className="h-7 px-1.5 rounded-md text-[11px] font-semibold text-gray-600 hover:bg-gray-100"
                        >
                          {item.size === 'full' ? 'Half' : 'Full'}
                        </button>
                        <WidgetControl icon="x" label="Remove widget" onClick={() => removeWidget(idx)} danger />
                      </div>
                    )}
                    <div className={editing ? 'ring-2 ring-brand-blue/30 rounded h-full' : 'h-full'}>
                      <Renderer data={data} orgProfile={orgProfile} advanced={advanced} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Add-widget tray (edit mode only) */}
          {editing && (
            <Card title="Add widgets" subtitle="Everything below can be added to your dashboard.">
              {availableToAdd.length === 0 ? (
                <p className="text-sm text-gray-400">Everything is already on your dashboard.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {availableToAdd.map(w => (
                    <button
                      key={w.key}
                      type="button"
                      onClick={() => addWidget(w.key)}
                      className="text-left border border-gray-200 hover:border-brand-blue hover:bg-info-50 rounded p-3 transition flex items-start gap-2"
                    >
                      <Icon name="plus" size={14} className="mt-0.5 text-brand-blue flex-shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-gray-900">{w.title}</span>
                        <span className="block text-xs text-gray-500 mt-0.5">{w.description}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </Card>
          )}

          {!editing && !loading && (
            <p className="text-xs text-gray-400 text-center">
              Looking for per-salesman and per-vendor performance tables? See <Link to="/reports" className="text-brand-blue underline">/reports</Link>.
            </p>
          )}
        </div>
      </Container>
    </div>
  );
}
