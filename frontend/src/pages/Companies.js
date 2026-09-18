// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState, useMemo, Suspense } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import api, { downloadBlob } from '../api';
import { useAuth } from '../AuthContext';
import { getStageConfig } from '../stages';
import lazyWithRetry from '../lazyWithRetry';
import { hasMappableRecords, companyPinColor } from '../utils/recordGeo';
import Nav from '../components/Nav';
import DataTable from '../components/DataTable';
import CompanyForm from '../components/CompanyForm';
import DuplicateWarningToast from '../components/DuplicateWarningToast';
import EnrichModal from '../components/EnrichModal';
import SavedViewsTabs from '../components/SavedViewsTabs';
import BulkActionBar from '../components/BulkActionBar';
import { Alert, Button, Card, Container, Input, PageHeader, Select, Spinner, StatusBadge } from '../components/ui';

// Map view (CMN_REQUIREMENTS 1.6) — lazy so leaflet stays out of the main
// bundle; only fetched when a user actually opens the Map view.
const RecordMap = lazyWithRetry(() => import('../components/RecordMap'));

const HEALTH_TONE = { green: 'success', yellow: 'warning', red: 'error' };

// Read whatever the company row exposes for account health, tolerant of a
// couple of shapes (top-level band/score, or a nested `health` object). Null
// until the daily accountHealthWorker snapshot is wired through the list API —
// renders a neutral em-dash in that case.
function readHealthBand(row) {
  const band = row.health_band || row.health?.band || null;
  const score = row.health_score ?? row.health?.score ?? null;
  return { band, score };
}

function HealthCell({ row }) {
  const { band, score } = readHealthBand(row);
  if (!band) return <span className="text-gray-400">—</span>;
  return (
    <StatusBadge
      tone={HEALTH_TONE[band] || 'neutral'}
      label={<><span className="capitalize">{band}</span>{score != null && <span className="opacity-70">{score}</span>}</>}
    />
  );
}

// Record owner chip (migration 135) — tiny initial-avatar + name. Resolves the
// owner's display name from the org-members list already loaded on the page;
// unassigned renders a neutral em-dash.
export function OwnerChip({ ownerId, members }) {
  if (!ownerId) return <span className="text-gray-400">—</span>;
  const m = (members || []).find((x) => Number(x.id) === Number(ownerId));
  const label = m ? (m.name || m.email) : `User #${ownerId}`;
  const initial = (label || '?').trim().charAt(0).toUpperCase();
  return (
    <span className="inline-flex items-center gap-1.5 max-w-full" title={label}>
      <span className="w-5 h-5 rounded-full bg-info-100 text-brand-blue text-[10px] font-bold flex items-center justify-center flex-shrink-0">
        {initial}
      </span>
      <span className="text-xs text-gray-700 truncate">{label}</span>
    </span>
  );
}

const COMPANY_TYPES = ['customer', 'vendor', 'end_user', 'partner', 'other'];
const COMPANY_STATUSES = ['active', 'inactive', 'lead'];

// Translate URL ?key=val pairs into the page's filter shape. Only the
// keys the AI catalog allows for "companies" are honoured; anything else
// is ignored. Returns null if there's nothing to seed.
function filterFromSearchParams(search) {
  if (!search) return null;
  const sp = new URLSearchParams(search);
  if ([...sp.keys()].length === 0) return null;
  const f = {};
  ['search', 'type', 'status', 'industry'].forEach((k) => {
    if (sp.has(k)) f[k] = sp.get(k);
  });
  return Object.keys(f).length ? f : null;
}

export default function Companies() {
  const navigate = useNavigate();
  const location = useLocation();
  const { orgProfile } = useAuth();
  // Show the account-health column + link rows to the Account 360 page only for
  // profiles running the post-sale account-management motion (zang/rin).
  const showAccountManagement = getStageConfig(orgProfile).showAccountManagement;
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  // Enrichment proposal surface — set to a company object to open the modal.
  const [enrichCompany, setEnrichCompany] = useState(null);
  // Soft duplicate warning from the last create (201 with warning payload).
  const [dupWarning, setDupWarning] = useState(null);

  // Filter shape — opaque to the SavedViewsTabs component. We just save +
  // replay this object as-is when a view is applied. Seeded from URL params
  // so a CommandPalette redirect arrives with the spec already applied.
  const [filter, setFilter] = useState(() => ({
    search: '', type: '', status: '',
    ...(filterFromSearchParams(typeof window !== 'undefined' ? window.location.search : '') || {}),
  }));
  const [activeViewId, setActiveViewId] = useState(null);

  // Re-apply URL filter when navigation changes the query string. Uses a
  // full replace (not merge) so successive AI specs don't accumulate stale
  // toggles between calls.
  useEffect(() => {
    const fromUrl = filterFromSearchParams(location.search);
    if (fromUrl) setFilter({ search: '', type: '', status: '', ...fromUrl });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  // Bulk-select state. Cleared whenever filters/views change so the user
  // doesn't accidentally apply an action to off-screen rows.
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [members, setMembers] = useState([]);

  // Record ownership (migration 135): "My records" narrows the list to rows
  // owned by the caller. Server-side (?owner=me) so it composes with the org
  // scope, not just the in-memory filters.
  const [mineOnly, setMineOnly] = useState(false);

  // Map view (CMN_REQUIREMENTS 1.6): Table ⇄ Map toggle, persisted per
  // viewer. The Map option only appears when at least one company carries
  // coordinates in custom_fields (gps_lat/gps_lng, lat/lng fallback); a
  // saved 'map' preference with no mappable rows falls back to the table.
  const [viewMode, setViewModeRaw] = useState(() => {
    try {
      return window.localStorage.getItem('companies.viewMode') === 'map' ? 'map' : 'table';
    } catch { return 'table'; }
  });
  const setViewMode = (mode) => {
    setViewModeRaw(mode);
    try { window.localStorage.setItem('companies.viewMode', mode); } catch { /* ignore */ }
  };
  const hasMappable = useMemo(() => hasMappableRecords(companies), [companies]);
  const activeViewMode = viewMode === 'map' && hasMappable ? 'map' : 'table';

  // Org-scoped custom-field defs — power both extra table columns and a
  // dynamic filter dropdown for select/multiselect fields. Fetched once on
  // mount; admins reload after applying a customization (the admin page sets
  // window.location).
  const [customDefs, setCustomDefs] = useState([]);

  useEffect(() => {
    fetchMembers();
    api.get('/custom-fields', { params: { entity: 'companies' } })
      .then(r => setCustomDefs(Array.isArray(r.data) ? r.data : []))
      .catch(() => setCustomDefs([]));
  }, []);

  // Fetch (and refetch when the "My records" toggle flips — the owner filter
  // is applied server-side via ?owner=me, migration 135).
  useEffect(() => {
    fetchCompanies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mineOnly]);

  const fetchCompanies = async () => {
    try {
      setLoading(true);
      const response = await api.get('/companies', { params: mineOnly ? { owner: 'me' } : {} });
      setCompanies(response.data);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to fetch companies');
    } finally {
      setLoading(false);
    }
  };

  const fetchMembers = async () => {
    try {
      const r = await api.get('/org');
      setMembers(r.data?.members || []);
    } catch {
      setMembers([]);
    }
  };

  const handleDelete = async (id) => {
    if (window.confirm('Are you sure you want to delete this company?')) {
      try {
        await api.delete(`/companies/${id}`);
        setCompanies(companies.filter(c => c.id !== id));
      } catch (err) {
        setError(err.response?.data?.error || 'Failed to delete company');
      }
    }
  };

  const handleFormClose = () => {
    setShowForm(false);
    setEditingId(null);
  };

  // A create may return a soft warning.possibleDuplicates on its 201 — the
  // record IS saved; we just surface a non-blocking review toast.
  const handleFormSuccess = (created) => {
    fetchCompanies();
    handleFormClose();
    if (created?.warning?.possibleDuplicates?.length) {
      setDupWarning(created.warning);
    }
  };

  // Server-authoritative CSV download of the current list, carrying the
  // API-supported filters (search, type, status) so the file matches the view.
  const handleExport = () => {
    const params = new URLSearchParams();
    if (filter.search) params.set('search', filter.search);
    if (filter.type) params.set('type', filter.type);
    if (filter.status) params.set('status', filter.status);
    const q = params.toString();
    downloadBlob(`/companies/export.csv${q ? `?${q}` : ''}`, 'companies.csv')
      .catch(() => setError('Failed to export CSV'));
  };

  const openNew = () => { setEditingId(null); setShowForm(true); };

  // Base columns + one extra column per org-defined custom field. We render
  // them via a synthetic key like "custom_fields.commission_tier" and have
  // DataTable read it with a dot-aware accessor. (DataTable will fall back to
  // a plain row[key] read, so we shim by injecting accessor-style getters.)
  const baseColumns = useMemo(() => {
    const nameCol = showAccountManagement
      ? {
          key: 'name',
          label: 'Company',
          width: '24%',
          // Link to the Account 360 detail page (CS-1).
          render: (row) => (
            <Link to={`/accounts/${row.id}`} className="text-brand-blue hover:underline font-medium">
              {row.name}
            </Link>
          ),
        }
      : { key: 'name', label: 'Company', width: '28%' };
    const cols = [
      nameCol,
      { key: 'type', label: 'Type', width: '12%', render: (row) => row.type ? <span className="capitalize">{row.type.replace('_', ' ')}</span> : null },
      { key: 'industry', label: 'Industry', width: '16%' },
      { key: 'website', label: 'Website', width: '18%' },
      { key: 'employee_count', label: 'Employees', width: '10%' },
      // Record owner (migration 135) — resolved to a name chip via the
      // org-members list; personal workspaces just see the em-dash.
      {
        key: 'owner_user_id',
        label: 'Owner',
        width: '12%',
        render: (row) => <OwnerChip ownerId={row.owner_user_id} members={members} />,
      },
    ];
    if (showAccountManagement) {
      cols.push({ key: 'health', label: 'Health', width: '10%', render: (row) => <HealthCell row={row} /> });
    }
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAccountManagement, members]);
  const columns = useMemo(() => {
    return [
      ...baseColumns,
      ...customDefs.map(d => ({
        key: `cf_${d.name}`,
        label: d.label || d.name,
        // Render multiselect values as comma-joined strings; everything else
        // falls back to a stringified value.
        render: (row) => {
          const v = row.custom_fields ? row.custom_fields[d.name] : undefined;
          if (v === null || v === undefined || v === '') return '—';
          if (Array.isArray(v)) return v.join(', ');
          if (typeof v === 'boolean') return v ? 'yes' : 'no';
          return String(v);
        },
      })),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customDefs, baseColumns]);

  const filteredCompanies = useMemo(() => {
    const s = (filter.search || '').toLowerCase();
    return companies.filter(c => {
      if (filter.type && c.type !== filter.type) return false;
      if (filter.status && c.status !== filter.status) return false;
      if (filter.industry && (c.industry || '').toLowerCase() !== filter.industry.toLowerCase()) return false;
      if (s && !((c.name || '').toLowerCase().includes(s) || (c.industry || '').toLowerCase().includes(s))) return false;
      // Per-custom-field filter. `filter.custom` is { name: value }; an empty
      // string means "any". For multiselect defs the value matches if at least
      // one option is selected on the row.
      if (filter.custom) {
        for (const def of customDefs) {
          const want = filter.custom[def.name];
          if (!want) continue;
          const got = c.custom_fields ? c.custom_fields[def.name] : undefined;
          if (def.type === 'multiselect') {
            if (!Array.isArray(got) || !got.includes(want)) return false;
          } else {
            if (String(got ?? '') !== String(want)) return false;
          }
        }
      }
      return true;
    });
  }, [companies, filter, customDefs]);

  // Selection helpers — `selectedIds` is restricted to the currently-visible
  // (filtered) set so changes to filter naturally drop off-screen selections.
  const visibleIds = useMemo(() => new Set(filteredCompanies.map(c => c.id)), [filteredCompanies]);
  const visibleSelected = useMemo(() => {
    const s = new Set();
    selectedIds.forEach(id => { if (visibleIds.has(id)) s.add(id); });
    return s;
  }, [selectedIds, visibleIds]);

  const toggleRow = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = (checked) => {
    setSelectedIds(checked ? new Set(filteredCompanies.map(c => c.id)) : new Set());
  };
  const clearSelection = () => setSelectedIds(new Set());

  const applyView = (filterSpec /*, sortSpec, view */, _sort, view) => {
    setFilter({ search: '', type: '', status: '', ...filterSpec });
    setActiveViewId(view?.id || null);
    clearSelection();
  };

  // Any manual filter change drops the "active view" highlight — the view
  // and the in-memory state are no longer in sync.
  const setFilterField = (k, v) => {
    setFilter(prev => ({ ...prev, [k]: v }));
    setActiveViewId(null);
    clearSelection();
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="companies" />

      <Container size="wide">
        <PageHeader
          title="Companies"
          subtitle="The accounts, vendors and partners your deals belong to."
          primaryAction={{ label: 'New company', onClick: openNew }}
          secondaryActions={[
            { label: 'Import CSV', icon: 'upload', onClick: () => navigate('/import?type=companies') },
            { label: 'Export CSV', icon: 'download', onClick: handleExport },
            { label: 'Find duplicates', icon: 'copy', onClick: () => navigate('/duplicates?type=companies') },
          ]}
        />

        {showForm && (
          <CompanyForm
            companyId={editingId}
            onClose={handleFormClose}
            onSuccess={handleFormSuccess}
          />
        )}

        <div className="space-y-6">
          {error && (
            <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>
          )}

          <div>
            <SavedViewsTabs
              resource="companies"
              currentFilter={filter}
              currentSort={{}}
              activeViewId={activeViewId}
              onApplyView={applyView}
            />

            <Card padding="sm">
              <div className="flex flex-wrap gap-2">
                <Input
                  leadingIcon="search"
                  placeholder="Search companies…"
                  aria-label="Search companies"
                  value={filter.search}
                  onChange={(e) => setFilterField('search', e.target.value)}
                  wrapperClassName="flex-1 min-w-[200px]"
                />
                <Select
                  value={filter.type}
                  onChange={(e) => setFilterField('type', e.target.value)}
                  aria-label="Filter companies by type"
                  wrapperClassName="w-40"
                >
                  <option value="">Any type</option>
                  {COMPANY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </Select>
                <Select
                  value={filter.status}
                  onChange={(e) => setFilterField('status', e.target.value)}
                  aria-label="Filter companies by status"
                  wrapperClassName="w-40"
                >
                  <option value="">Any status</option>
                  {COMPANY_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </Select>
                {/* Record ownership (migration 135): server-side ?owner=me filter. */}
                <Button
                  variant={mineOnly ? 'primary' : 'secondary'}
                  onClick={() => { setMineOnly(v => !v); clearSelection(); }}
                  aria-pressed={mineOnly}
                  title="Show only companies you own"
                  icon="user"
                >
                  My records
                </Button>
                {/* Map view toggle (CMN 1.6) — only offered when at least one
                    company carries gps coordinates. */}
                {hasMappable && (
                  <div className="inline-flex rounded-md border border-gray-300 overflow-hidden text-xs font-medium self-stretch" role="group" aria-label="View mode">
                    <button
                      type="button"
                      onClick={() => setViewMode('table')}
                      aria-pressed={activeViewMode === 'table'}
                      className={`px-2.5 min-h-[38px] transition ${activeViewMode === 'table' ? 'bg-brand-blue text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                      title="Show companies as a table"
                    >
                      Table
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('map')}
                      aria-pressed={activeViewMode === 'map'}
                      className={`px-2.5 min-h-[38px] transition ${activeViewMode === 'map' ? 'bg-brand-blue text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                      title="Plot companies with coordinates on a map — pin color follows health / lifecycle stage"
                    >
                      Map
                    </button>
                  </div>
                )}
                {/* Org-scoped custom-field filters. Each select/multiselect def becomes
                    an "Any <label>" filter dropdown next to the built-in filters. We
                    skip text/number/date/boolean filters here to keep the surface
                    tight; if an admin requests them they can be added below. */}
                {customDefs.filter(d => d.type === 'select' || d.type === 'multiselect').map(def => (
                  <Select
                    key={def.id}
                    value={(filter.custom && filter.custom[def.name]) || ''}
                    onChange={(e) => setFilterField('custom', { ...(filter.custom || {}), [def.name]: e.target.value || undefined })}
                    aria-label={`Filter companies by ${def.label || def.name}`}
                    wrapperClassName="w-44"
                  >
                    <option value="">Any {def.label || def.name}</option>
                    {(def.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                  </Select>
                ))}
              </div>
            </Card>
          </div>

          {activeViewMode === 'map' ? (
            /* Map view (CMN_REQUIREMENTS 1.6) — companies with coordinates,
               pin color = health band, else lifecycle stage, else neutral. */
            <Suspense fallback={<div className="flex items-center justify-center py-16"><Spinner size="lg" /></div>}>
              <RecordMap
                records={filteredCompanies}
                className="h-[60vh] min-h-[420px]"
                config={{
                  getColor: companyPinColor,
                  renderPopup: (c) => (
                    <div className="text-sm min-w-[180px]">
                      <p className="font-semibold text-gray-900">{c.name}</p>
                      {(c.lifecycle_stage || c.type) && (
                        <p className="text-gray-600 capitalize">
                          {String(c.lifecycle_stage || c.type).replace(/_/g, ' ')}
                        </p>
                      )}
                      {showAccountManagement ? (
                        <Link to={`/accounts/${c.id}`} className="mt-2 inline-block text-brand-blue font-medium hover:underline">
                          Open account →
                        </Link>
                      ) : (
                        <button
                          type="button"
                          onClick={() => { setEditingId(c.id); setShowForm(true); }}
                          className="mt-2 text-brand-blue font-medium hover:underline"
                        >
                          Open company →
                        </button>
                      )}
                    </div>
                  ),
                }}
              />
            </Suspense>
          ) : (
          <DataTable
            columns={columns}
            data={filteredCompanies}
            loading={loading}
            onEdit={(company) => {
              setEditingId(company.id);
              setShowForm(true);
            }}
            onDelete={handleDelete}
            selectedIds={visibleSelected}
            onToggleRow={toggleRow}
            onToggleAll={toggleAll}
            emptyState={{
              icon: 'building',
              title: companies.length === 0
                ? 'Every deal needs a home'
                : 'No companies match your filters',
              message: companies.length === 0
                ? 'Companies are where your contacts, deals, and quotes all come together. Add your first account to get rolling.'
                : 'Try clearing the search box or relaxing a filter.',
              action: companies.length === 0 ? (
                <Button variant="primary" icon="plus" onClick={openNew}>
                  Create your first company
                </Button>
              ) : null,
            }}
            rowActions={[
              { label: 'Enrich', onClick: (company) => setEnrichCompany(company) },
            ]}
          />
          )}
        </div>

        <EnrichModal
          open={!!enrichCompany}
          entity="companies"
          record={enrichCompany}
          recordLabel={enrichCompany ? enrichCompany.name : ''}
          onClose={() => setEnrichCompany(null)}
          onApplied={fetchCompanies}
        />

        <DuplicateWarningToast
          warning={dupWarning}
          entityType="companies"
          onDismiss={() => setDupWarning(null)}
        />
      </Container>

      <BulkActionBar
        resource="companies"
        selectedIds={visibleSelected}
        totalCount={filteredCompanies.length}
        ownerOptions={members}
        ownerField="owner_id"
        statusOptions={COMPANY_STATUSES}
        statusLabel="Change status"
        onClear={clearSelection}
        onComplete={() => { clearSelection(); fetchCompanies(); }}
      />
    </div>
  );
}
