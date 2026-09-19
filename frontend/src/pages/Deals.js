// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState, useMemo, useRef, Suspense } from 'react';
import { useLocation, Link } from 'react-router-dom';
import {
  DndContext, DragOverlay, closestCenter, PointerSensor,
  useSensor, useSensors, useDroppable, useDraggable,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import Nav from '../components/Nav';
import DealPanel from '../components/DealPanel';
import DealFilters from '../components/DealFilters';
import SavedViewsTabs from '../components/SavedViewsTabs';
import api, { downloadBlob } from '../api';
import TierLimitToast from '../components/TierLimitToast';
import { useAuth } from '../AuthContext';
import { getStageConfig } from '../stages';
import { getNextStep } from '../nextSteps';
import lazyWithRetry from '../lazyWithRetry';
import { hasMappableRecords, dealPinColor } from '../utils/recordGeo';
import {
  Alert, Button, EmptyState, Icon, Input, Modal, PageHeader, Select, Spinner, Tabs, Textarea,
} from '../components/ui';

// Map view (CMN_REQUIREMENTS 1.6) — lazy so leaflet stays out of the main
// bundle; only fetched when a user actually opens the Map view.
const RecordMap = lazyWithRetry(() => import('../components/RecordMap'));

function fmtAmount(amount) {
  const n = Number(amount);
  if (!n) return null;
  return n >= 1000 ? `$${(n / 1000).toFixed(0)}K` : `$${n.toLocaleString()}`;
}

function fmtDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function CardContent({ deal, profile = 'generic' }) {
  const nextStep = getNextStep(deal, profile);
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold text-gray-900 text-base leading-snug line-clamp-2">{deal.title}</p>
        {deal.hot_flag && <span className="text-[11px] px-1.5 py-0.5 bg-red-100 text-red-700 rounded font-semibold flex-shrink-0">HOT</span>}
      </div>
      {deal.customer_name && <p className="text-sm text-gray-600 mt-1 truncate">{deal.customer_name}</p>}
      {deal.vendor_name && <p className="text-xs text-purple-600 truncate mt-0.5">via {deal.vendor_name}</p>}
      {deal.po_number && <p className="text-xs text-gray-400 truncate">PO: {deal.po_number}</p>}
      <div className="flex justify-between items-center mt-2.5">
        <span className={`text-base font-bold ${deal.amount ? 'text-green-700' : 'text-gray-300'}`}>
          {fmtAmount(deal.amount) || '—'}
        </span>
        {deal.expected_close_date && (
          <span className="text-xs text-gray-500">{fmtDate(deal.expected_close_date)}</span>
        )}
      </div>
      {/* Record owner chip (migration 135) — owner_name is joined in by the
          deals list API when owner_user_id is set. */}
      {deal.owner_name && (
        <div className="flex items-center gap-1.5 mt-1.5" title={`Owner: ${deal.owner_name}`}>
          <span className="w-4 h-4 rounded-full bg-blue-100 text-brand-blue text-[9px] font-bold flex items-center justify-center flex-shrink-0">
            {deal.owner_name.trim().charAt(0).toUpperCase()}
          </span>
          <span className="text-[11px] text-gray-500 truncate">{deal.owner_name}</span>
        </div>
      )}
      {nextStep && (
        <div className="mt-2 pt-1.5 border-t border-gray-100 text-[11px] text-brand-blue truncate" title={nextStep.hint}>
          → {nextStep.label}
        </div>
      )}
    </>
  );
}

function DealCard({ deal, onClick, profile }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: String(deal.id) });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={transform ? { transform: CSS.Translate.toString(transform) } : undefined}
      onClick={() => onClick(deal)}
      className={`bg-white rounded-lg p-3 shadow-sm border border-gray-200 hover:shadow-md transition-shadow select-none cursor-grab active:cursor-grabbing ${isDragging ? 'opacity-20' : ''}`}
    >
      <CardContent deal={deal} profile={profile} />
    </div>
  );
}

function Column({ stage, deals, onDealClick, onAdd, stageColors, profile }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const colors = stageColors(stage.id);
  const total = deals.reduce((s, d) => s + (Number(d.amount) || 0), 0);

  return (
    <div className="flex flex-col w-72 xl:w-80 flex-shrink-0">
      <div className={`${colors.header} rounded-t-lg px-3 py-2.5 border border-b-0 ${colors.border}`}>
        <div className="flex justify-between items-center gap-2">
          <span className="font-semibold text-gray-800 text-sm flex items-baseline gap-2 min-w-0">
            <span className="truncate">{stage.label}</span>
            <span className="font-normal text-gray-500 text-xs flex-shrink-0">{deals.length}</span>
          </span>
          <div className="flex items-center gap-2 flex-shrink-0">
            {total > 0 && <span className="text-xs text-gray-600 font-medium">{fmtAmount(total)}</span>}
            <button
              onClick={() => onAdd(stage.id)}
              aria-label={`Add deal to ${stage.label}`}
              className="text-gray-400 hover:text-brand-blue hover:bg-blue-50 transition w-8 h-8 min-w-[32px] min-h-[32px] flex items-center justify-center rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:ring-offset-1"
              title={`Add deal to ${stage.label}`}
            ><Icon name="plus" size={16} /></button>
          </div>
        </div>
        <div className="text-[11px] text-gray-500 mt-1 line-clamp-1" title={stage.desc}>{stage.desc}</div>
      </div>
      <div
        ref={setNodeRef}
        className={`flex-1 min-h-32 rounded-b-lg border ${colors.border} p-2 space-y-2 transition-colors ${isOver ? 'bg-blue-50 border-blue-300' : colors.bg}`}
      >
        {deals.map(d => <DealCard key={d.id} deal={d} onClick={onDealClick} profile={profile} />)}
      </div>
    </div>
  );
}

// Sentinel option in the Customer select that reveals the inline "New
// company name" field (one-motion deal + company + contact creation).
const NEW_COMPANY = '__new__';

function AddModal({ stageId, onClose, onCreate, customers, vendors, stageLabel, profile, dealType = 'default', pipelineOptions = [], showAdvancedPanels = false }) {
  const [form, setForm] = useState({
    title: '', customer_id: '', vendor_id: '', vertical: '', amount: '',
    expected_close_date: '', notes: '', hot_flag: false, stage: stageId,
    deal_type: dealType,
    // One-motion create (Wave 3): a brand-new company typed inline and an
    // optional primary contact. The server finds-or-creates both by name
    // (services/recordUpsert.js — the same path the chat copilot uses).
    company_name: '', contact_name: '', contact_email: '',
  });
  const [saving, setSaving] = useState(false);
  const [withContact, setWithContact] = useState(false);
  // >1 pipeline (spec 201) → let the user pick which one the deal joins.
  const multiPipeline = pipelineOptions.length > 1;
  const newCompany = form.customer_id === NEW_COMPANY;

  const submit = async (e) => {
    e.preventDefault();
    if (!form.title) return;
    if (newCompany && !form.company_name.trim()) return;
    setSaving(true);
    try {
      const { company_name, contact_name, contact_email, ...rest } = form;
      const payload = { ...rest, amount: form.amount === '' ? null : Number(form.amount) };
      if (!multiPipeline) delete payload.deal_type; // single-pipeline orgs post exactly what they always did
      if (newCompany) { payload.customer_id = ''; payload.company_name = company_name.trim(); }
      if (withContact && (contact_name.trim() || contact_email.trim())) {
        if (contact_name.trim()) payload.contact_name = contact_name.trim();
        if (contact_email.trim()) payload.contact_email = contact_email.trim();
      }
      await onCreate(payload);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  // Switching pipeline moves the deal to that pipeline's first stage — the
  // clicked column only makes sense on the board it came from.
  const setDealType = (e) => {
    const next = e.target.value;
    const nextCfg = getStageConfig(profile, { dealType: next });
    setForm((f) => ({ ...f, deal_type: next, stage: next === dealType ? stageId : nextCfg.defaultStage }));
  };
  const activeCfg = form.deal_type === dealType ? null : getStageConfig(profile, { dealType: form.deal_type });
  const titleStageLabel = activeCfg ? activeCfg.stageLabel(form.stage) : stageLabel(form.stage);

  return (
    <Modal
      open
      onClose={onClose}
      title={`New deal — ${titleStageLabel}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="add-deal-form" loading={saving} loadingLabel="Creating…">Create deal</Button>
        </>
      }
    >
      <form id="add-deal-form" onSubmit={submit} className="space-y-4">
        <Input label="Deal title" placeholder="What are you working on?" value={form.title} onChange={set('title')} autoFocus required />
        {multiPipeline && (
          <Select label="Pipeline" value={form.deal_type} onChange={setDealType}>
            {pipelineOptions.map(p => <option key={p.deal_type} value={p.deal_type}>{p.name}</option>)}
          </Select>
        )}
        {/* Vendor + Vertical are Zang-only concepts (manufacturer's-rep
            RFQ/vendor workflow) — a generic or jcp org never sees them. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select label="Customer" value={form.customer_id} onChange={set('customer_id')}>
            <option value="">Customer…</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value={NEW_COMPANY}>+ New company…</option>
          </Select>
          {newCompany && (
            <Input
              label="New company name"
              value={form.company_name}
              onChange={set('company_name')}
              placeholder="e.g. Bravo LLC"
              autoFocus
              required
              hint="Created with the deal (or matched if it already exists)."
            />
          )}
          {showAdvancedPanels && (
            <Select label="Primary vendor" value={form.vendor_id} onChange={set('vendor_id')}>
              <option value="">Primary vendor…</option>
              {vendors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          )}
        </div>
        {/* Optional primary contact, created (or matched by email) in the
            same motion. Collapsed by default so the modal stays short on a
            phone. */}
        {withContact ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Primary contact" value={form.contact_name} onChange={set('contact_name')} placeholder="First Last" />
            <Input label="Contact email" type="email" value={form.contact_email} onChange={set('contact_email')} placeholder="name@company.com" hint="Matched to an existing contact by email, else created." />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setWithContact(true)}
            className="inline-flex min-h-[36px] items-center text-sm font-medium text-brand-blue hover:underline"
          >
            + Add a primary contact
          </button>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {showAdvancedPanels && <Input label="Vertical" value={form.vertical} onChange={set('vertical')} />}
          <Input label="Amount" type="number" value={form.amount} onChange={set('amount')} />
        </div>
        <Input label="Expected close date" type="date" value={form.expected_close_date} onChange={set('expected_close_date')} />
        <Textarea label="Notes" value={form.notes} onChange={set('notes')} rows={3} />
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={form.hot_flag} onChange={(e) => setForm({ ...form, hot_flag: e.target.checked })} className="h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue" />
          Mark as HOT
        </label>
      </form>
    </Modal>
  );
}

// Read AI-generated filter from URL ?key=val pairs and shape it like the
// page's existing `filter` state. Only the keys allowed by SEARCH_CATALOG
// (backend/services/ai.js) ever reach here — anything else has been
// stripped by the route allowlist before redirect.
function filterFromSearchParams(search) {
  if (!search) return null;
  const sp = new URLSearchParams(search);
  if ([...sp.keys()].length === 0) return null;
  const f = {};
  const boolish = (v) => v === 'true' || v === '1';
  // Pass-through string filters.
  ['stage', 'phase', 'search'].forEach((k) => {
    if (sp.has(k)) f[k] = sp.get(k);
  });
  // Numeric amount band — the page already filters on these via the
  // DealFilters component contract.
  ['amount_min', 'amount_max'].forEach((k) => {
    if (sp.has(k)) {
      const n = Number(sp.get(k));
      if (Number.isFinite(n)) f[k] = n;
    }
  });
  // Boolean toggles.
  ['hot', 'overdue', 'new_customer_only', 'dormant_customer_only'].forEach((k) => {
    if (sp.has(k)) f[k] = boolish(sp.get(k));
  });
  // Activity window — accepted values must match the filter logic below.
  if (sp.has('last_activity_window')) {
    const v = sp.get('last_activity_window');
    if (['30d', '60d', '90d', '180d', 'never'].includes(v)) f.last_activity_window = v;
  }
  return Object.keys(f).length ? f : null;
}

export default function Deals() {
  const { user, orgPipeline, orgPipelines } = useAuth();
  const location = useLocation();
  // Multiple pipelines (spec 201): every pipeline of the org keyed by
  // deal_type ('default' = the main one). The switcher only appears when a
  // second pipeline exists — single-pipeline orgs see exactly today's page.
  const pipelineOptions = useMemo(() => {
    const map = orgPipelines || { default: orgPipeline };
    return Object.entries(map)
      .filter(([, p]) => p)
      .map(([deal_type, p]) => ({ deal_type, name: p.name || (deal_type === 'default' ? 'Pipeline' : deal_type) }))
      .sort((a, b) => (a.deal_type === 'default' ? -1 : b.deal_type === 'default' ? 1 : a.deal_type.localeCompare(b.deal_type)));
  }, [orgPipelines, orgPipeline]);
  const multiPipeline = pipelineOptions.length > 1;
  const dealTypeStorageKey = `deals.dealType.${user?.org_id || 'me'}`;
  const [dealType, setDealTypeRaw] = useState(() => {
    try {
      const saved = window.localStorage.getItem(`deals.dealType.${user?.org_id || 'me'}`);
      return saved || 'default';
    } catch { return 'default'; }
  });
  // A stale saved choice (pipeline deleted) falls back to the default board.
  const activeDealType = multiPipeline && pipelineOptions.some(p => p.deal_type === dealType) ? dealType : 'default';
  const setDealType = (next) => {
    setDealTypeRaw(next);
    try { window.localStorage.setItem(dealTypeStorageKey, next); } catch { /* per-viewer convenience only */ }
  };
  // Stage source: the profile default merged with the org's custom pipeline
  // for the ACTIVE deal type (per-org editable stages, /settings/pipeline).
  // Re-resolves when any of them change so a saved edit re-lays the board
  // without a reload.
  const cfg = useMemo(
    () => getStageConfig(user?.org_profile || 'generic', { dealType: activeDealType }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.org_profile, orgPipeline, orgPipelines, activeDealType]
  );
  const [activePhase, setActivePhase] = useState(cfg.phases[0].id);
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeId, setActiveId] = useState(null);
  const [selectedDeal, setSelectedDeal] = useState(null);
  const [addStageId, setAddStageId] = useState(null);
  const [companies, setCompanies] = useState([]);
  // Seed initial filter from URL params so a CommandPalette redirect lands
  // on the page with the spec already applied. Falls back to the empty
  // shape used in the original Deals page.
  const [filter, setFilterRaw] = useState(() => ({
    search: '', hot: false,
    ...(filterFromSearchParams(typeof window !== 'undefined' ? window.location.search : '') || {}),
  }));
  const [activeViewId, setActiveViewId] = useState(null);
  // Any direct mutation drops the active-view highlight — the user has
  // edited the filter so it no longer matches the saved view.
  const setFilter = (next) => {
    setActiveViewId(null);
    setFilterRaw(next);
  };
  const applySavedView = (filterSpec, _sort, view) => {
    // Match the other pages' behavior — applying a view resets all filters
    // (including the search box) to the spec so the user sees the saved view
    // alone, not its intersection with whatever they had typed.
    setFilterRaw({ ...filterSpec });
    setActiveViewId(view?.id || null);
  };
  // Stage selection for Focus mode — picks one stage at a time from the active
  // phase. Necessary on phones (horizontal-scrolling 8-15 stages is unusable),
  // useful on laptops where a 29-stage Kanban gets cramped. View mode controls
  // which rendering is active; Focus is forced below md regardless of choice.
  const [mobileStage, setMobileStage] = useState(null);
  // Default to Focus mode on screens below xl (1280px) where the Kanban
  // gets cramped. Kanban at xl+ matches the desktop power-user expectation.
  const sizeDefaultViewMode = () => {
    if (typeof window === 'undefined') return 'kanban';
    return window.matchMedia('(min-width: 1280px)').matches ? 'kanban' : 'focus';
  };
  const [viewMode, setViewModeRaw] = useState(() => {
    try {
      const saved = window.localStorage.getItem('deals.viewMode');
      if (['kanban', 'focus', 'map'].includes(saved)) return saved;
    } catch { /* per-viewer convenience only */ }
    return sizeDefaultViewMode();
  });
  const setViewMode = (mode) => {
    setViewModeRaw(mode);
    try { window.localStorage.setItem('deals.viewMode', mode); } catch { /* ignore */ }
  };
  // Map view (CMN_REQUIREMENTS 1.6): the Map toggle only appears when at
  // least one deal on the current board carries coordinates (custom_fields
  // gps_lat/gps_lng). A saved 'map' preference on a board with no
  // coordinates silently falls back to the size default.
  const hasMappable = useMemo(() => hasMappableRecords(deals), [deals]);
  const activeViewMode = viewMode === 'map' && !hasMappable ? sizeDefaultViewMode() : viewMode;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const phase = cfg.phases.find(p => p.id === activePhase) || cfg.phases[0];
  const customers = useMemo(() => companies.filter(c => c.type === 'customer' || !c.type), [companies]);
  const vendors = useMemo(() => companies.filter(c => c.type === 'vendor'), [companies]);

  // Record ownership (migration 135): "My deals" narrows the board to deals
  // owned by the caller — applied server-side via ?owner=me so it composes
  // with the org scope. Refetches whenever the toggle flips.
  const [mineOnly, setMineOnly] = useState(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchAll(); }, [mineOnly, activeDealType]);

  // Switching pipeline resets the phase tabs + Focus stage to the new
  // board's first phase/stage.
  useEffect(() => {
    setActivePhase(cfg.phases[0].id);
    setMobileStage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDealType]);

  // When the URL search params change (e.g. CommandPalette navigates here
  // while we're already mounted), re-seed the filter. We replace rather
  // than merge so a new AI spec doesn't accidentally inherit stale toggles.
  useEffect(() => {
    const fromUrl = filterFromSearchParams(location.search);
    if (fromUrl) setFilterRaw({ search: '', hot: false, ...fromUrl });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  // Chat-first action chips deep-link into Deals via ?dealId=N (+ optional
  // &compose=1 to immediately open the email composer for that deal). When
  // the deals list isn't loaded yet we just remember the id and open after
  // load. The compose flag is forwarded to DealPanel via initialAction prop.
  const [pendingDealAction, setPendingDealAction] = useState(null);
  // Tier-cap 402 body from a create on an explicitly-capped plan → upgrade nudge.
  const [tierLimit, setTierLimit] = useState(null);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const dealIdParam = params.get('dealId');
    if (!dealIdParam) return;
    const compose = params.get('compose') === '1';
    setPendingDealAction({ id: Number(dealIdParam), compose });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  // Quick-add (CommandPalette "New deal" / nav "+" button) → ?new=1 opens the
  // Add modal on the currently active phase's first stage, same as clicking
  // the page's own "New deal" button.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('new') === '1') setAddStageId(phase.stages[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);
  // Resolve the deep-linked deal once the board has finished its first fetch
  // attempt (not merely "has any rows" — an empty "My deals" board should
  // still fall back). If it isn't on the currently loaded board (a different
  // pipeline, or the "My deals" filter), fetch it directly rather than
  // failing silently; a genuine 404 surfaces as a banner instead of nothing
  // happening.
  useEffect(() => {
    if (!pendingDealAction || loading) return;
    const action = pendingDealAction.compose ? 'compose-email' : null;
    const target = deals.find(d => d.id === pendingDealAction.id);
    if (target) {
      setSelectedDeal({ ...target, _initialAction: action });
      setPendingDealAction(null);
      return;
    }
    let alive = true;
    api.get(`/deals/${pendingDealAction.id}`)
      .then((res) => {
        if (!alive) return;
        setSelectedDeal({ ...res.data, _initialAction: action });
      })
      .catch(() => {
        if (alive) setError('Deal not found');
      })
      .finally(() => {
        if (alive) setPendingDealAction(null);
      });
    return () => { alive = false; };
  }, [pendingDealAction, deals, loading]);

  // Monotonic guard so out-of-order fetchAll responses can't clobber newer
  // state. Every call bumps the counter; a response only writes state if it is
  // still the latest issued fetch. Protects the create/delete/panel-refresh
  // paths that all funnel through here.
  const fetchSeq = useRef(0);
  const fetchAll = async () => {
    const seq = ++fetchSeq.current;
    try {
      setLoading(true);
      const [d, c] = await Promise.all([
        // ?owner=me — the "My deals" server-side owner filter (migration 135).
        // ?deal_type= — only sent on multi-pipeline orgs (spec 201), so a
        // single-pipeline org's request is byte-for-byte what it always was.
        api.get('/deals', {
          params: {
            ...(mineOnly ? { owner: 'me' } : {}),
            ...(multiPipeline ? { deal_type: activeDealType } : {}),
          },
        }),
        api.get('/companies'),
      ]);
      if (seq !== fetchSeq.current) return; // superseded by a newer fetch
      setDeals(d.data);
      setCompanies(c.data);
      setError('');
    } catch (e) {
      if (seq !== fetchSeq.current) return;
      setError(e.response?.data?.error || 'Failed to load deals');
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  };

  const filteredDeals = useMemo(() => {
    const customerById = Object.fromEntries(companies.map(c => [c.id, c]));
    return deals.filter(d => {
      const f = filter;
      if (f.hot && !d.hot_flag) return false;
      // Filters newly supported via AI/URL params. Stage and phase already
      // exist as backend filters, but the page historically delegated those
      // to the phase tabs; surfacing them as in-memory filters too lets the
      // CommandPalette pin the page to a specific stage even when phase
      // tabs are also rendered.
      if (f.stage && f.stage !== d.stage) return false;
      if (f.phase && f.phase !== d.phase) return false;
      if (f.amount_min !== undefined && f.amount_min !== '' && f.amount_min !== null) {
        if (!d.amount || Number(d.amount) < Number(f.amount_min)) return false;
      }
      if (f.amount_max !== undefined && f.amount_max !== '' && f.amount_max !== null) {
        if (!d.amount || Number(d.amount) > Number(f.amount_max)) return false;
      }
      if (f.search) {
        const q = f.search.toLowerCase();
        if (!((d.title || '').toLowerCase().includes(q)
          || (d.po_number || '').toLowerCase().includes(q)
          || (d.customer_name || '').toLowerCase().includes(q))) return false;
      }
      if (f.customer_id && Number(f.customer_id) !== Number(d.customer_id)) return false;
      if (f.vendor_id && Number(f.vendor_id) !== Number(d.vendor_id)) return false;
      if (f.salesman_id && Number(f.salesman_id) !== Number(d.salesman_id)) return false;
      if (f.vertical && f.vertical !== d.vertical) return false;
      if (f.product && f.product !== d.product) return false;
      if (f.deal_class && f.deal_class !== d.deal_class) return false;
      if (f.deal_size && f.deal_size !== d.deal_size) return false;
      if (f.office_location && f.office_location !== d.office_location) return false;
      if (f.last_activity_window) {
        const days = { '30d': 30, '60d': 60, '90d': 90, '180d': 180 }[f.last_activity_window];
        if (days) {
          const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
          if (d.last_activity_at && new Date(d.last_activity_at).getTime() > cutoff) return false;
        }
        if (f.last_activity_window === 'never' && d.last_activity_at) return false;
      }
      if (f.overdue) {
        // Terminal (closed/cancelled) stages are never "overdue" — derive them
        // from the active profile's config so closed deals in every profile
        // (incl. jcp's uppercase CLOSED_WON/CLOSED_LOST and future rin) are
        // excluded, not just the hardcoded Zang/generic mix that used to live
        // here.
        const terminal = cfg.terminalStageIds || [];
        if (!(d.expected_close_date && new Date(d.expected_close_date) < new Date()
              && !terminal.includes(d.stage))) return false;
      }
      if (f.new_customer_only) {
        const c = customerById[d.customer_id];
        if (!c || !c.first_deal_at || (Date.now() - new Date(c.first_deal_at).getTime() > 90 * 24 * 60 * 60 * 1000)) return false;
      }
      if (f.dormant_customer_only) {
        const c = customerById[d.customer_id];
        if (!c || !c.last_deal_at || (Date.now() - new Date(c.last_deal_at).getTime() < 180 * 24 * 60 * 60 * 1000)) return false;
      }
      return true;
    });
  }, [deals, filter, companies, cfg]);

  const dealsByStage = useMemo(() => {
    const m = {};
    phase.stages.forEach(s => { m[s.id] = []; });
    filteredDeals.forEach(d => {
      if (m[d.stage]) m[d.stage].push(d);
    });
    return m;
  }, [filteredDeals, phase]);

  const handleDragEnd = async (e) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const dealId = Number(active.id);
    const newStage = over.id;
    const deal = deals.find(d => d.id === dealId);
    if (!deal || deal.stage === newStage) return;

    const oldStage = deal.stage;
    // Optimistic move.
    setDeals(prev => prev.map(d => d.id === dealId ? { ...d, stage: newStage } : d));

    try {
      const res = await api.patch(`/deals/${dealId}/stage`, { stage: newStage });
      // Reconcile ONLY this card from the server response (fresh stage/phase/
      // version), not a full-board refetch. The refetch was the drag race: a
      // slow /deals snapshot could return after a second, concurrent drag and
      // overwrite that card's optimistic move. Per-card, id-keyed updates can't
      // clobber a concurrent drag. Merge (not replace) so the join-derived
      // display fields (customer_name, vendor_name, …) that RETURNING * omits
      // are preserved.
      if (res?.data?.id) {
        setDeals(prev => prev.map(d => d.id === dealId ? { ...d, ...res.data } : d));
      }
    } catch {
      setDeals(prev => prev.map(d => d.id === dealId ? { ...d, stage: oldStage } : d));
      setError('Failed to update stage');
    }
  };

  const handleCreate = async (payload) => {
    try {
      const res = await api.post('/deals', payload);
      const created = res.data;
      // Land on what you just created. If it landed on a different pipeline
      // than the one we're viewing (multi-pipeline orgs only), switch boards
      // first — that switch's own effect refetches, so skip the extra call.
      if (multiPipeline && created?.deal_type && created.deal_type !== activeDealType) {
        setDealType(created.deal_type);
      } else {
        fetchAll();
      }
      if (created?.id) setSelectedDeal(created);
    } catch (e) {
      // Tier-cap 402 → non-blocking upgrade nudge instead of the generic error.
      if (e.response?.status === 402 && e.response?.data?.code === 'TIER_LIMIT_EXCEEDED') {
        setTierLimit(e.response.data);
        return;
      }
      setError(e.response?.data?.error || 'Failed to create deal');
    }
  };

  // Server-authoritative CSV download of the deal list, carrying the
  // API-supported search filter so the file matches what's on screen.
  const handleExport = () => {
    const params = new URLSearchParams();
    if (filter.search) params.set('search', filter.search);
    if (multiPipeline) params.set('deal_type', activeDealType);
    const q = params.toString();
    downloadBlob(`/deals/export.csv${q ? `?${q}` : ''}`, 'deals.csv')
      .catch(() => setError('Failed to export CSV'));
  };

  const activeDeal = activeId ? deals.find(d => d.id === Number(activeId)) : null;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Nav active="deals" />

      <main className="flex-1 flex flex-col px-3 sm:px-4 lg:px-6 py-3 lg:py-4 overflow-hidden">
        <PageHeader
          className="mb-3"
          actionSize="sm"
          title={cfg.labels?.deals || 'Deals'}
          subtitle={
            <span className="hidden sm:inline">
              {activeViewMode === 'kanban'
                ? 'Drag cards between stages — phase auto-updates'
                : activeViewMode === 'map'
                  ? 'Deals with coordinates, pinned on the map — pin color follows stage'
                  : 'Pick a stage to focus on one column at a time'}
            </span>
          }
          actions={
            <>
              <Input
                size="sm"
                leadingIcon="search"
                aria-label="Filter deals"
                value={filter.search || ''}
                onChange={(e) => setFilter({ ...filter, search: e.target.value })}
                placeholder="Filter…"
                wrapperClassName="w-40 sm:w-56 lg:w-64"
              />
              <DealFilters value={filter} onChange={setFilter} />
              {/* Record ownership (migration 135): server-side ?owner=me filter. */}
              <Button
                size="sm"
                variant={mineOnly ? 'primary' : 'secondary'}
                onClick={() => setMineOnly(v => !v)}
                aria-pressed={mineOnly}
                title="Show only deals you own"
                icon="user"
              >
                My deals
              </Button>
              {/* View mode toggle — hidden on phones (focus is always forced
                  below md anyway), visible md+ to let users swap Kanban vs
                  Focus per their screen size and preference. */}
              <div className="hidden md:inline-flex rounded-md border border-gray-300 overflow-hidden text-xs font-medium" role="group" aria-label="View mode">
                <button
                  type="button"
                  onClick={() => setViewMode('kanban')}
                  aria-pressed={activeViewMode === 'kanban'}
                  className={`px-2.5 py-1.5 min-h-[32px] transition ${activeViewMode === 'kanban' ? 'bg-brand-blue text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  title="Show all stages as a horizontal Kanban (best on wide screens)"
                >
                  Kanban
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('focus')}
                  aria-pressed={activeViewMode === 'focus'}
                  className={`px-2.5 py-1.5 min-h-[32px] transition ${activeViewMode === 'focus' ? 'bg-brand-blue text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  title="Show one stage at a time (best on laptops + phones)"
                >
                  Focus
                </button>
                {/* Map view (CMN 1.6) — only offered when at least one deal
                    on this board carries gps coordinates. */}
                {hasMappable && (
                  <button
                    type="button"
                    onClick={() => setViewMode('map')}
                    aria-pressed={activeViewMode === 'map'}
                    className={`px-2.5 py-1.5 min-h-[32px] transition ${activeViewMode === 'map' ? 'bg-brand-blue text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                    title="Plot deals with coordinates on a map — pin color follows stage"
                  >
                    Map
                  </button>
                )}
              </div>
            </>
          }
          primaryAction={{ label: 'New deal', onClick: () => setAddStageId(phase.stages[0].id) }}
          secondaryActions={[
            { label: 'Export CSV', icon: 'download', onClick: handleExport },
          ]}
        />

        {/* Pipeline switcher (spec 201) — only rendered when the org runs
            more than one pipeline; the board, stage dropdowns, and create
            modal all follow the active deal type. */}
        {multiPipeline && (
          <Tabs
            className="mb-3"
            aria-label="Pipelines"
            value={activeDealType}
            onChange={setDealType}
            items={pipelineOptions.map(p => ({ id: p.deal_type, label: p.name }))}
          />
        )}

        <SavedViewsTabs
          resource="deals"
          currentFilter={filter}
          currentSort={{}}
          activeViewId={activeViewId}
          onApplyView={applySavedView}
        />

        {cfg.phases.length > 1 && (
          <Tabs
            className="mb-4"
            aria-label="Pipeline phases"
            value={activePhase}
            onChange={setActivePhase}
            items={cfg.phases.map(p => ({
              id: p.id,
              label: p.label,
              count: filteredDeals.filter(d => d.phase === p.id).length,
            }))}
          />
        )}

        {error && <Alert tone="danger" className="mb-3" onDismiss={() => setError('')}>{error}</Alert>}

        {loading ? (
          <div className="flex-1 flex items-center justify-center"><Spinner size="lg" /></div>
        ) : (
          <>
            {/* Kanban — md+ AND viewMode='kanban' (phones always fall back
                to Focus regardless of toggle). DnD drag works only here. */}
            {activeViewMode === 'kanban' && (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={(e) => setActiveId(e.active.id)}
                onDragEnd={handleDragEnd}
              >
                <div className="hidden md:block flex-1 overflow-x-auto">
                  <div className="flex gap-3 h-full pb-4">
                    {phase.stages.map(stage => (
                      <Column
                        key={stage.id}
                        stage={stage}
                        deals={dealsByStage[stage.id] || []}
                        onDealClick={setSelectedDeal}
                        onAdd={setAddStageId}
                        stageColors={cfg.stageColors}
                        profile={cfg.profile}
                      />
                    ))}
                  </div>
                </div>
                <DragOverlay>
                  {activeDeal ? (
                    <div className="bg-white rounded-lg p-3 shadow-lg border-2 border-brand-blue w-72 cursor-grabbing">
                      <CardContent deal={activeDeal} profile={cfg.profile} />
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            )}

            {/* Map view (CMN_REQUIREMENTS 1.6) — deals with gps coordinates
                pinned on an OpenStreetMap canvas, pin color = stage tone.
                md+ only; phones keep the Focus fallback below. Lazy-loaded so
                leaflet never touches the main bundle. */}
            {activeViewMode === 'map' && (
              <div className="hidden md:flex flex-1 min-h-0 flex-col">
                <Suspense fallback={<div className="flex-1 flex items-center justify-center"><Spinner size="lg" /></div>}>
                  <RecordMap
                    records={filteredDeals}
                    className="flex-1"
                    config={{
                      getColor: (d) => dealPinColor(d, cfg.stageColors),
                      renderPopup: (d) => (
                        <div className="text-sm min-w-[180px]">
                          <p className="font-semibold text-gray-900">{d.title}</p>
                          {d.customer_name && <p className="text-gray-600">{d.customer_name}</p>}
                          <p className="mt-1 text-gray-700">
                            {cfg.stageLabel(d.stage)}
                            {fmtAmount(d.amount) ? ` · ${fmtAmount(d.amount)}` : ''}
                          </p>
                          <button
                            type="button"
                            onClick={() => setSelectedDeal(d)}
                            className="mt-2 text-brand-blue font-medium hover:underline"
                          >
                            Open deal →
                          </button>
                        </div>
                      ),
                    }}
                  />
                </Suspense>
              </div>
            )}

            {/* Focus mode — always renders below md OR when user picks
                Focus on a larger screen. Single-stage selector + vertical
                card list, much friendlier on cramped screens. */}
            <div className={activeViewMode === 'focus' ? 'flex-1 overflow-y-auto pb-6' : 'md:hidden flex-1 overflow-y-auto pb-6'}>
              <div className="px-3 py-3 sticky top-0 bg-white z-10 border-b border-gray-200">
                <Select
                  label="Stage"
                  value={mobileStage || phase.stages[0].id}
                  onChange={e => setMobileStage(e.target.value)}
                  aria-label="Pipeline stage to focus on"
                  wrapperClassName="w-full max-w-md"
                >
                  {phase.stages.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.label} ({(dealsByStage[s.id] || []).length})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="px-3 pt-3 max-w-3xl mx-auto">
                {(() => {
                  const stageId = mobileStage || phase.stages[0].id;
                  const stageMeta = phase.stages.find(s => s.id === stageId) || phase.stages[0];
                  const stageDeals = dealsByStage[stageId] || [];
                  return (
                    <>
                      <div className="flex items-center justify-between mb-3 gap-2">
                        <div className="min-w-0">
                          <h2 className="text-lg font-semibold text-gray-900 truncate">{stageMeta.label}</h2>
                          {stageMeta.desc && <p className="text-xs text-gray-500 line-clamp-2">{stageMeta.desc}</p>}
                        </div>
                        <Button size="sm" icon="plus" className="flex-shrink-0" onClick={() => setAddStageId(stageId)}>
                          Add
                        </Button>
                      </div>
                      {stageDeals.length === 0 ? (
                        <div className="bg-white rounded-lg border border-dashed border-gray-200">
                          <EmptyState
                            icon={deals.length === 0 ? 'trending-up' : 'inbox'}
                            title={deals.length === 0 ? 'Your pipeline starts here' : 'This stage is empty'}
                            message={
                              deals.length === 0
                                ? "Deals are the opportunities you're working — first hello to closed-won. Add the one on your desk right now and watch the board come alive."
                                : 'Drag a card over from another stage — or add a new deal directly.'
                            }
                            action={
                              <div className="flex flex-col items-center gap-2">
                                <Button variant="primary" icon="plus" onClick={() => setAddStageId(stageId)}>
                                  Add deal to {stageMeta.label}
                                </Button>
                                {deals.length === 0 && (
                                  <Link to="/chat" className="text-sm text-brand-blue hover:underline">
                                    Not sure where to start? Ask the copilot &rarr;
                                  </Link>
                                )}
                              </div>
                            }
                          />
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {stageDeals.map(d => (
                            <button
                              key={d.id}
                              onClick={() => setSelectedDeal(d)}
                              className="block w-full text-left bg-white border border-gray-200 rounded-lg p-3 sm:p-4 hover:border-brand-blue hover:shadow-sm active:bg-gray-50 transition"
                            >
                              <CardContent deal={d} profile={cfg.profile} />
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          </>
        )}
      </main>

      {selectedDeal && (
        <DealPanel
          dealId={selectedDeal.id}
          companies={companies}
          onClose={() => setSelectedDeal(null)}
          onChanged={fetchAll}
          initialAction={selectedDeal._initialAction}
        />
      )}

      {addStageId && (
        <AddModal
          stageId={addStageId}
          onClose={() => setAddStageId(null)}
          onCreate={handleCreate}
          customers={customers}
          vendors={vendors}
          stageLabel={cfg.stageLabel}
          profile={cfg.profile}
          dealType={activeDealType}
          pipelineOptions={pipelineOptions}
          showAdvancedPanels={cfg.showAdvancedPanels}
        />
      )}

      <TierLimitToast
        info={tierLimit}
        onDismiss={() => setTierLimit(null)}
      />
    </div>
  );
}
