// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Extension library — the "app store shelf" for curated, one-click extensions.
//
// GET /api/plugins/library returns the catalog enriched with per-org install
// status (installed / active / installed_plugin_id). The primary CTA is
// **Enable** — POST /api/plugins/from-template { template_id, activate: true }
// installs AND activates atomically (idempotent server-side: an existing clone
// is turned on, never duplicated). A secondary "Customize in chat" flow clones
// as a draft and seeds the copilot, preserving the original template UX.

import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../AuthContext';
import Nav from '../components/Nav';
import { Alert, Button, Card, Container, EmptyState, Icon, PageHeader, Skeleton } from '../components/ui';

// Category display names + shelf order. Unknown categories render title-cased
// after the known ones, so a growing catalog never hides entries.
const CATEGORY_META = [
  ['sales',        'Sales'],
  ['data-hygiene', 'Data hygiene'],
  ['cx',           'Customer experience'],
  ['reporting',    'Reporting'],
  ['ops',          'Ops'],
  ['procurement',  'Procurement'],
  ['integrations', 'Integrations'],
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORY_META);
const CATEGORY_ORDER = CATEGORY_META.map(([k]) => k);

function categoryLabel(cat) {
  if (CATEGORY_LABEL[cat]) return CATEGORY_LABEL[cat];
  return String(cat || 'Other').replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// Human trigger badge — "when does this thing run?" at a glance.
function triggerBadge(ev) {
  if (!ev || ev === 'manual' || ev === 'chat.invoked') return { label: 'Run from chat', icon: 'sparkles' };
  if (ev === 'schedule.daily')  return { label: 'Runs daily',    icon: 'clock' };
  if (ev === 'schedule.weekly') return { label: 'Runs weekly',   icon: 'clock' };
  if (ev.startsWith('schedule.')) return { label: 'Runs on a schedule', icon: 'clock' };
  if (ev === 'deal.stage_changed') return { label: 'On deal stage change', icon: 'refresh' };
  if (ev === 'deal.created')       return { label: 'On new deal',          icon: 'plus' };
  if (ev === 'quote.sent')         return { label: 'When a quote is sent', icon: 'mail' };
  // Fallback: "On task overdue", "On contact created", …
  const [entity, verb] = ev.split('.');
  return { label: `On ${String(entity).replace(/_/g, ' ')} ${String(verb || '').replace(/_/g, ' ')}`.trim(), icon: 'bell' };
}

// Where "Needs setup" points for a requiredIntegration flag. Platform
// integrations (QuickBooks, Slack, email, …) are wired at /admin/integrations.
const INTEGRATION_SETUP = {
  quickbooks: { label: 'QuickBooks', to: '/admin/integrations' },
  slack:      { label: 'Slack',      to: '/admin/integrations' },
  email:      { label: 'Email',      to: '/admin/integrations' },
  gmail:      { label: 'Gmail',      to: '/admin/integrations' },
  calendar:   { label: 'Google Calendar', to: '/admin/integrations' },
  outlook:    { label: 'Outlook / Microsoft 365', to: '/admin/integrations' },
  stripe:     { label: 'Stripe',     to: '/admin/integrations' },
};
function integrationSetup(flag) {
  if (!flag) return null;
  return INTEGRATION_SETUP[String(flag).toLowerCase()]
    || { label: String(flag).replace(/[-_]/g, ' '), to: '/admin/integrations' };
}

function ExtensionCard({ item, state, isOrgAdmin, onEnable, onCustomize, onSetMode }) {
  const badge = triggerBadge(item.triggerEvent);
  const setup = integrationSetup(item.requiredIntegration);
  const enabled = state.active;
  const installed = state.installed;
  const busy = state.busy;
  const autonomous = state.runMode === 'autonomous';
  // "Run autonomously" opt-in for the Enable click. Default OFF, admin-only —
  // autonomous extensions apply their changes without a human Apply step.
  const [autoChecked, setAutoChecked] = useState(false);

  return (
    <Card className="flex flex-col h-full" bodyClassName="flex flex-col h-full">
      <div className="flex items-start gap-3">
        {/* Library entries ship their own glyph — catalog content, not chrome. */}
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-gray-100 text-2xl leading-none" aria-hidden="true">
          {item.icon || <Icon name="sparkles" size={20} className="text-brand-blue" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-gray-900 truncate">{item.name}</h3>
            {enabled ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-success-50 border border-success-300 px-2 py-0.5 text-[10px] font-semibold text-success-700 flex-shrink-0">
                <Icon name="check" size={10} /> Enabled
              </span>
            ) : installed ? (
              <span className="inline-flex items-center rounded-full bg-gray-100 border border-gray-200 px-2 py-0.5 text-[10px] font-semibold text-gray-600 flex-shrink-0">
                Installed
              </span>
            ) : null}
          </div>
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-brand-blue/10 px-2 py-0.5 text-[10px] font-medium text-brand-blue">
            <Icon name={badge.icon} size={10} /> {badge.label}
          </span>
        </div>
      </div>

      <p className="text-sm text-gray-700 mt-3 flex-1">{item.summary}</p>

      {item.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-3">
          {item.tags.map((t) => (
            <span key={t} className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded-md">{t}</span>
          ))}
        </div>
      )}

      {setup && (
        <p className="mt-3 text-[11px] text-warning-700 flex items-center gap-1">
          <Icon name="alert" size={12} />
          Needs setup: requires {setup.label} —{' '}
          <Link to={setup.to} className="underline font-medium">connect it in Integrations</Link>
        </p>
      )}
      {item.requiredConfig?.length > 0 && (
        <p className="mt-2 text-[11px] text-warning-700">Requires: {item.requiredConfig.join(', ')}</p>
      )}

      <div className="mt-4">
        {enabled ? (
          <>
            <Button
              variant="secondary"
              fullWidth
              icon="check"
              disabled
              className="!border-success-300 !bg-success-50 !text-success-700 !opacity-100"
            >
              Enabled{autonomous ? ' · autonomous' : ''}
            </Button>
            {isOrgAdmin && state.pluginId && (
              <label className="mt-2 flex items-start gap-2 text-[11px] text-gray-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={autonomous}
                  disabled={busy === 'mode'}
                  onChange={(e) => onSetMode(item, e.target.checked ? 'autonomous' : 'preview')}
                />
                <span>
                  <span className="font-medium text-gray-700">Run autonomously</span>
                  {' — '}applies its changes immediately (tasks created, fields updated) without an Apply step. Switch back any time.
                </span>
              </label>
            )}
          </>
        ) : (
          <>
            <Button fullWidth onClick={() => onEnable(item, autoChecked)} disabled={busy} loading={busy === 'enable'} loadingLabel="Enabling…">
              {installed ? 'Turn on' : 'Enable'}
            </Button>
            {isOrgAdmin && (
              <label className="mt-2 flex items-start gap-2 text-[11px] text-gray-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={autoChecked}
                  disabled={!!busy}
                  onChange={(e) => setAutoChecked(e.target.checked)}
                />
                <span>
                  <span className="font-medium text-gray-700">Run autonomously</span>
                  {' — '}autonomous extensions apply their changes immediately (tasks created, fields updated) without an Apply step. You can switch back any time.
                </span>
              </label>
            )}
          </>
        )}
        <div className="mt-1.5 flex items-center justify-center gap-1 text-[11px]">
          {enabled ? (
            state.pluginId ? (
              <Link to={`/plugins/${state.pluginId}`} className="text-brand-blue hover:underline">Manage</Link>
            ) : (
              <Link to="/plugins" className="text-brand-blue hover:underline">Manage in Plugins</Link>
            )
          ) : (
            <button
              type="button"
              onClick={() => onCustomize(item)}
              disabled={!!busy}
              className="text-gray-500 hover:text-brand-blue hover:underline disabled:opacity-50"
            >
              {busy === 'customize' ? 'Copying…' : 'or install as a draft & customize in chat'}
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function PluginLibrary() {
  const navigate = useNavigate();
  const { orgRole } = useAuth();
  const isOrgAdmin = ['owner', 'admin'].includes(orgRole);
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [featureDisabled, setFeatureDisabled] = useState(false);
  const [query, setQuery] = useState('');
  // Per-slug UI state overlaying the server-reported install status:
  // { [slug]: { installed, active, pluginId, busy: false|'enable'|'customize' } }
  const [cardState, setCardState] = useState({});
  const [toast, setToast] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get('/plugins/library');
        const list = r.data.data || [];
        setItems(list);
        const seeded = {};
        for (const it of list) {
          seeded[it.slug] = {
            installed: !!it.installed,
            active: !!it.active,
            pluginId: it.installed_plugin_id || null,
            runMode: it.installed_run_mode || 'preview',
            busy: false,
          };
        }
        setCardState(seeded);
      } catch (err) {
        if (err.response?.status === 403 && err.response.data?.code === 'FEATURE_DISABLED') {
          setFeatureDisabled(true);
        } else {
          setError(err.response?.data?.error || err.message);
        }
      }
    })();
  }, []);

  const setSlugState = (slug, patch) =>
    setCardState((prev) => ({ ...prev, [slug]: { ...(prev[slug] || {}), ...patch } }));

  // One-click Enable: install + activate atomically. Idempotent server-side —
  // an existing clone is activated in place, never duplicated.
  const enable = async (item, autonomous = false) => {
    setSlugState(item.slug, { busy: 'enable' });
    setError('');
    try {
      const body = { template_id: item.slug, activate: true };
      // Owner/admin opted into autonomous mode: the extension applies its
      // changes immediately, no Apply step. Server-side this is admin-gated
      // exactly like PATCH /plugins/:id/run-mode.
      if (autonomous) body.run_mode = 'autonomous';
      const r = await api.post('/plugins/from-template', body);
      const plugin = r.data?.plugin;
      setSlugState(item.slug, {
        busy: false,
        installed: true,
        active: plugin?.status === 'active',
        pluginId: plugin?.id || null,
        runMode: plugin?.run_mode || (autonomous ? 'autonomous' : 'preview'),
      });
      const modeNote = autonomous ? ' Autonomous: its changes apply immediately, no Apply step.' : '';
      setToast(r.data?.already_active && !r.data?.run_mode_changed
        ? `"${item.name}" was already on.`
        : `"${item.name}" is on. It runs ${triggerBadge(item.triggerEvent).label.toLowerCase().replace(/^runs /, '')} from now on.${modeNote}`);
    } catch (err) {
      setSlugState(item.slug, { busy: false });
      setError(err.response?.data?.error || err.message || 'Enable failed');
    }
  };

  // Flip an already-enabled extension between confirm-first preview and
  // autonomous (owner/admin only; PATCH /plugins/:id/run-mode, audited).
  const setMode = async (item, runMode) => {
    const st = cardState[item.slug];
    if (!st?.pluginId) return;
    setSlugState(item.slug, { busy: 'mode' });
    setError('');
    try {
      await api.patch(`/plugins/${st.pluginId}/run-mode`, { run_mode: runMode });
      setSlugState(item.slug, { busy: false, runMode });
      setToast(runMode === 'autonomous'
        ? `"${item.name}" now runs autonomously — its changes apply immediately, without an Apply step.`
        : `"${item.name}" is back to confirm-first — its changes wait for an Apply.`);
    } catch (err) {
      setSlugState(item.slug, { busy: false });
      setError(err.response?.data?.error || err.message || 'Mode change failed');
    }
  };

  // Secondary flow (the original template UX): clone as a DRAFT and hand off
  // to the copilot with a seed prompt so the customer can tailor it first.
  const customize = async (item) => {
    setSlugState(item.slug, { busy: 'customize' });
    setError('');
    try {
      const r = await api.post('/plugins/from-template', { template_id: item.slug });
      const plugin = r.data?.plugin;
      setSlugState(item.slug, { busy: false, installed: true, pluginId: plugin?.id || null });
      if (!plugin?.id) {
        setToast(`Copied "${item.name}" into your workspace as a draft.`);
        return;
      }
      setToast(`Copied "${item.name}" into your workspace. Let's customize it.`);
      const params = new URLSearchParams({
        seed: 'customize_plugin',
        plugin_id: String(plugin.id),
        template_name: item.name,
      });
      // Tiny delay so the toast paints before the page navigates.
      setTimeout(() => navigate(`/chat?${params.toString()}`), 250);
    } catch (err) {
      setSlugState(item.slug, { busy: false });
      setError(err.response?.data?.error || err.message || 'Copy failed');
    }
  };

  // Search over name / summary / tags / trigger, then group by category in
  // shelf order.
  const sections = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    const filtered = !q ? items : items.filter((i) =>
      [i.name, i.slug, i.summary, i.triggerEvent, ...(i.tags || [])]
        .join(' ')
        .toLowerCase()
        .includes(q));
    const byCat = new Map();
    for (const it of filtered) {
      const cat = it.category || 'other';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(it);
    }
    const cats = Array.from(byCat.keys()).sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a); const ib = CATEGORY_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    });
    return cats.map((cat) => ({ category: cat, label: categoryLabel(cat), items: byCat.get(cat) }));
  }, [items, query]);

  const enabledCount = useMemo(
    () => Object.values(cardState).filter((s) => s.active).length,
    [cardState]
  );

  if (featureDisabled) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Nav active="plugins" />
        <Container size="narrow">
          <Alert tone="warning" icon="lock" title="Extensions are not enabled for your organization">
            Ask your admin to flip <code className="bg-warning-100 px-1 rounded">plugins_enabled</code> at /admin/feature-flags —
            or just ask the copilot at /chat to propose it.
          </Alert>
        </Container>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="plugins" />
      <Container>
        <PageHeader
          breadcrumb={[{ label: 'Plugins', to: '/plugins' }, { label: 'Extensions' }]}
          title="Extension library"
          subtitle="Ready-made automations, curated and sandboxed. Enable turns one on in a single click — or ask the copilot: “what extensions do you have for follow-ups?”"
          primaryAction={{ label: 'Build your own', icon: 'sparkles', onClick: () => navigate('/plugins/new') }}
          secondaryActions={[
            { label: 'My plugins', icon: 'arrow-left', inline: true, onClick: () => navigate('/plugins') },
          ]}
        />

        <div className="space-y-8">
          {toast && <Alert tone="success" onDismiss={() => setToast('')}>{toast}</Alert>}
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          {items != null && items.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[220px] max-w-md">
                <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search extensions — follow-ups, digests, surveys…"
                  className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder-gray-400 focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue"
                  aria-label="Search extensions"
                />
              </div>
              <span className="text-xs text-gray-500">
                {items.length} extension{items.length === 1 ? '' : 's'}
                {enabledCount > 0 ? ` · ${enabledCount} enabled` : ''}
              </span>
            </div>
          )}

          {items == null ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[0, 1, 2].map((i) => <Card key={i}><Skeleton lines={5} /></Card>)}
            </div>
          ) : items.length === 0 ? (
            <Card padding="none">
              <EmptyState icon="inbox" title="No extensions yet" message="Curated extensions will appear here as they're published." />
            </Card>
          ) : sections && sections.length === 0 ? (
            <Card padding="none">
              <EmptyState
                icon="search"
                title="No matches"
                message={`Nothing in the library matches "${query}". Try a different word — or describe the tool you want at /plugins/new and we'll build it.`}
              />
            </Card>
          ) : (
            sections.map((section) => (
              <section key={section.category} aria-label={section.label}>
                <div className="flex items-baseline gap-2 mb-3">
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-700">{section.label}</h2>
                  <span className="text-xs text-gray-400">{section.items.length}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {section.items.map((item) => (
                    <ExtensionCard
                      key={item.slug}
                      item={item}
                      state={cardState[item.slug] || { installed: !!item.installed, active: !!item.active, pluginId: item.installed_plugin_id || null, runMode: item.installed_run_mode || 'preview', busy: false }}
                      isOrgAdmin={isOrgAdmin}
                      onEnable={enable}
                      onCustomize={customize}
                      onSetMode={setMode}
                    />
                  ))}
                </div>
              </section>
            ))
          )}

          <p className="text-xs text-gray-500">
            Enabled extensions run automatically on their trigger; drafts stay off until you activate them.
            Every run is sandboxed. By default an extension's CRM changes wait for an owner/admin to Apply them;
            an owner/admin can opt a specific extension into autonomous mode, where its changes apply immediately —
            and switch it back at any time.
          </p>
        </div>
      </Container>
    </div>
  );
}
