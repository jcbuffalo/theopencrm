// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useRef, useState, useMemo } from 'react';
import { useNavigate, useLocation, useParams } from 'react-router-dom';
import api, { downloadBlob } from '../api';
import Nav from '../components/Nav';
import DataTable from '../components/DataTable';
import ContactForm from '../components/ContactForm';
import ContactPanel from '../components/ContactPanel';
import DuplicateWarningToast from '../components/DuplicateWarningToast';
import TierLimitToast from '../components/TierLimitToast';
import EmailComposerModal from '../components/EmailComposerModal';
import EnrichModal from '../components/EnrichModal';
import SavedViewsTabs from '../components/SavedViewsTabs';
import BulkActionBar from '../components/BulkActionBar';
import { Alert, Button, Card, Container, Input, PageHeader, Select, StatusBadge } from '../components/ui';

const CONTACT_STATUSES = ['prospect', 'customer', 'lead', 'inactive'];
const STATUS_TONE = { customer: 'success', lead: 'info', prospect: 'neutral', inactive: 'neutral' };

// Relationship-cadence intervals offered by the inline editor. Any bespoke
// value already on a contact (e.g. set via API) renders as an extra option so
// the select never lies about the current state.
const CADENCE_OPTIONS = [
  { value: 7, label: 'Weekly' },
  { value: 14, label: 'Every 2 weeks' },
  { value: 30, label: 'Monthly' },
  { value: 60, label: 'Every 2 months' },
  { value: 90, label: 'Quarterly' },
  { value: 180, label: 'Twice a year' },
  { value: 365, label: 'Yearly' },
];

const DAY_MS = 86400000;
function daysSince(ts) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / DAY_MS);
}

// "Last touched" cell — days-ago with an overdue tint when the contact has a
// cadence and the touch is older than it (mirrors TouchCell on Accounts).
function LastTouchCell({ contact }) {
  const days = daysSince(contact.last_touch_at);
  if (days == null) {
    return <span className="text-gray-400 text-xs">Never</span>;
  }
  const overdue = contact.cadence_days != null && days > contact.cadence_days;
  const tone = overdue ? 'error' : days <= 7 ? 'success' : 'neutral';
  return (
    <StatusBadge
      tone={tone}
      label={`${days === 0 ? 'Today' : `${days}d ago`}${overdue ? ' · overdue' : ''}`}
    />
  );
}

// Translate URL ?key=val pairs into the Contacts page's filter shape.
// Only the keys the AI catalog allows for "contacts" are honoured.
function filterFromSearchParams(search) {
  if (!search) return null;
  const sp = new URLSearchParams(search);
  if ([...sp.keys()].length === 0) return null;
  const f = {};
  ['search', 'status'].forEach((k) => { if (sp.has(k)) f[k] = sp.get(k); });
  return Object.keys(f).length ? f : null;
}

// Inline cell editors stay as compact native selects: the Select primitive's
// 32px minimum would double the row height for a two-line editor.
const INLINE_SELECT =
  'text-xs border border-gray-300 rounded-md px-1.5 py-1 bg-white cursor-pointer focus:outline-none focus:border-brand-blue';

export default function Contacts() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const [contacts, setContacts] = useState([]);
  // Companies feed the contact drawer's company line (one fetch per page).
  const [companies, setCompanies] = useState([]);
  // The open contact record (ContactPanel drawer). Deep-linkable two ways:
  // /contacts/:id (App.js routes it here) and ?contactId=N (chips / palette).
  const [selectedContactId, setSelectedContactId] = useState(null);
  // When "Edit details" in the drawer hands off to the inline form we
  // remember the id so a successful save re-opens the record.
  const returnToPanelRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  // Email composer surface — set to a contact object to open the modal.
  // Null means closed; we don't unmount the modal between sends so the
  // template list it loads once stays warm across opens.
  const [emailContact, setEmailContact] = useState(null);
  // Enrichment proposal surface — set to a contact object to open the modal.
  const [enrichContact, setEnrichContact] = useState(null);
  // Soft duplicate warning from the last create (201 with warning payload).
  const [dupWarning, setDupWarning] = useState(null);
  // Tier-cap 402 body from a create on an explicitly-capped plan → upgrade nudge.
  const [tierLimit, setTierLimit] = useState(null);

  // Filter shape — saved + replayed verbatim as a saved-view filter_spec.
  // Seeded from URL params so a CommandPalette redirect arrives applied.
  const [filter, setFilter] = useState(() => ({
    search: '', status: '',
    ...(filterFromSearchParams(typeof window !== 'undefined' ? window.location.search : '') || {}),
  }));
  const [activeViewId, setActiveViewId] = useState(null);

  // Re-apply URL filter when the query string changes mid-session.
  useEffect(() => {
    const fromUrl = filterFromSearchParams(location.search);
    if (fromUrl) setFilter({ search: '', status: '', ...fromUrl });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  // Quick-add (CommandPalette "New contact" / nav "+" button) → ?new=1 opens
  // the create form, same as clicking the page's own "New contact" button.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('new') === '1') { setEditingId(null); setShowForm(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  // Record deep link: /contacts/:id wins, then ?contactId=N. Leaving both
  // (back button, drawer close) closes the drawer.
  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const fromPath = params.id ? Number(params.id) : null;
    const fromQuery = sp.get('contactId') ? Number(sp.get('contactId')) : null;
    const id = Number.isInteger(fromPath) && fromPath > 0 ? fromPath
      : Number.isInteger(fromQuery) && fromQuery > 0 ? fromQuery : null;
    setSelectedContactId(id);
  }, [params.id, location.search]);

  const openContact = (id) => navigate(`/contacts/${id}`);
  const closeContact = () => {
    setSelectedContactId(null);
    if (params.id || new URLSearchParams(location.search).has('contactId')) navigate('/contacts');
  };

  const [selectedIds, setSelectedIds] = useState(new Set());
  const [members, setMembers] = useState([]);

  // Relationship cadence — the "gone quiet" list. null = not loaded (or the
  // customer-success module is off for this org: a 403 simply hides the strip).
  const [goneQuiet, setGoneQuiet] = useState(null);
  // Ids with an in-flight touch / cadence save, to disable their controls.
  const [touchingIds, setTouchingIds] = useState(new Set());
  const [cadenceSavingIds, setCadenceSavingIds] = useState(new Set());

  useEffect(() => {
    fetchContacts();
    fetchMembers();
    fetchGoneQuiet();
    api.get('/companies')
      .then((r) => setCompanies(Array.isArray(r.data) ? r.data : []))
      .catch(() => setCompanies([]));
  }, []);

  const fetchContacts = async () => {
    try {
      setLoading(true);
      const response = await api.get('/contacts');
      setContacts(response.data);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to fetch contacts');
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

  const fetchGoneQuiet = async () => {
    try {
      const r = await api.get('/contacts/gone-quiet');
      setGoneQuiet(Array.isArray(r.data?.contacts) ? r.data.contacts : []);
    } catch {
      // Feature off (403) or transient error — hide the strip rather than nag.
      setGoneQuiet(null);
    }
  };

  // One-click "I just reconnected with this person". Updates the row locally
  // and refreshes the gone-quiet list so the strip empties itself out.
  const markTouched = async (contact) => {
    setTouchingIds((s) => new Set(s).add(contact.id));
    try {
      const r = await api.post(`/contacts/${contact.id}/touch`);
      const updated = r.data;
      setContacts((rows) => rows.map((c) => (c.id === contact.id ? { ...c, ...updated } : c)));
      setGoneQuiet((list) => (list ? list.filter((c) => c.id !== contact.id) : list));
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to mark contact touched');
    } finally {
      setTouchingIds((s) => { const n = new Set(s); n.delete(contact.id); return n; });
    }
  };

  // Inline cadence editor save — PATCHes only the allowlisted cadence fields.
  const saveCadence = async (contact, patch) => {
    setCadenceSavingIds((s) => new Set(s).add(contact.id));
    try {
      const r = await api.patch(`/contacts/${contact.id}/cadence`, patch);
      const updated = r.data;
      setContacts((rows) => rows.map((c) => (c.id === contact.id ? { ...c, ...updated } : c)));
      fetchGoneQuiet();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update cadence');
    } finally {
      setCadenceSavingIds((s) => { const n = new Set(s); n.delete(contact.id); return n; });
    }
  };

  const handleDelete = async (id) => {
    if (window.confirm('Are you sure you want to delete this contact?')) {
      try {
        await api.delete(`/contacts/${id}`);
        setContacts(contacts.filter(c => c.id !== id));
      } catch (err) {
        setError(err.response?.data?.error || 'Failed to delete contact');
      }
    }
  };

  const handleFormClose = () => {
    setShowForm(false);
    setEditingId(null);
  };

  // A create may return a soft warning.possibleDuplicates on its 201 — the
  // record IS saved; we just surface a non-blocking review toast.
  //
  // Land on what you just created: `created` is only passed by ContactForm
  // on a fresh create (an edit-save calls onSuccess() with no argument), so
  // reopening the form in edit mode for the new id only fires there — an
  // edit-save still closes the form exactly as before.
  const handleFormSuccess = (created) => {
    fetchContacts();
    if (created?.warning?.possibleDuplicates?.length) {
      setDupWarning(created.warning);
    }
    if (created?.id) {
      setEditingId(created.id);
      setShowForm(true);
    } else {
      handleFormClose();
      // Came from the drawer's "Edit details"? Go back to the record.
      if (returnToPanelRef.current) {
        const id = returnToPanelRef.current;
        returnToPanelRef.current = null;
        openContact(id);
      }
    }
  };

  // Drawer → inline form hand-off. The Drawer would cover the form, so close
  // it, open the form, and remember to come back on save.
  const editFromPanel = (contact) => {
    returnToPanelRef.current = contact.id;
    closeContact();
    setEditingId(contact.id);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Server-authoritative CSV download of the current list, carrying the
  // API-supported filters (search, status) so the file matches the view.
  const handleExport = () => {
    const params = new URLSearchParams();
    if (filter.search) params.set('search', filter.search);
    if (filter.status) params.set('status', filter.status);
    const q = params.toString();
    downloadBlob(`/contacts/export.csv${q ? `?${q}` : ''}`, 'contacts.csv')
      .catch(() => setError('Failed to export CSV'));
  };

  const openNew = () => { setEditingId(null); setShowForm(true); };

  // Inline cadence cell — a reconnect-interval select plus a relationship-owner
  // select, each saving on change via PATCH /contacts/:id/cadence. Kept inside
  // the component so it can reach members / saveCadence without prop drilling.
  const renderCadenceCell = (contact) => {
    const saving = cadenceSavingIds.has(contact.id);
    const hasBespoke = contact.cadence_days != null
      && !CADENCE_OPTIONS.some((o) => o.value === contact.cadence_days);
    return (
      <div className="flex flex-col gap-1 min-w-[130px]" onClick={(e) => e.stopPropagation()}>
        <select
          value={contact.cadence_days ?? ''}
          disabled={saving}
          onChange={(e) => saveCadence(contact, {
            cadence_days: e.target.value === '' ? null : parseInt(e.target.value, 10),
          })}
          aria-label={`Reconnect cadence for ${contact.first_name} ${contact.last_name}`}
          className={`${INLINE_SELECT} text-gray-700 ${saving ? 'opacity-50' : ''}`}
        >
          <option value="">No cadence</option>
          {hasBespoke && <option value={contact.cadence_days}>Every {contact.cadence_days}d</option>}
          {CADENCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {members.length > 0 && (
          <select
            value={contact.owner_user_id ?? ''}
            disabled={saving}
            onChange={(e) => saveCadence(contact, {
              owner_user_id: e.target.value === '' ? null : parseInt(e.target.value, 10),
            })}
            aria-label={`Relationship owner for ${contact.first_name} ${contact.last_name}`}
            className={`${INLINE_SELECT} text-gray-500 ${saving ? 'opacity-50' : ''}`}
          >
            <option value="">No owner</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name || m.email}</option>
            ))}
          </select>
        )}
      </div>
    );
  };

  // The name cell opens the record. A real <button> (not a row onClick) so
  // the inline cadence selects and row actions never fight it for the tap;
  // ≥44px tall on phones via min-h so it's a comfortable target.
  const renderName = (c) => (
    <button
      type="button"
      onClick={() => openContact(c.id)}
      className="inline-flex min-h-[44px] items-center text-left font-medium text-gray-900 hover:text-brand-blue hover:underline md:min-h-0"
      aria-label={`Open ${c.first_name || ''} ${c.last_name || ''}`.trim()}
    >
      {c.first_name} {c.last_name}
    </button>
  );

  const columns = [
    { key: 'first_name', label: 'Name', width: '20%', render: renderName },
    { key: 'email', label: 'Email', width: '24%' },
    { key: 'job_title', label: 'Job title', width: '20%' },
    {
      key: 'status', label: 'Status', width: '8%',
      render: (c) => c.status ? <StatusBadge tone={STATUS_TONE[c.status] || 'neutral'} label={c.status} className="capitalize" /> : null,
    },
    { key: 'last_touch_at', label: 'Last touched', width: '12%', render: (c) => <LastTouchCell contact={c} /> },
    { key: 'cadence_days', label: 'Cadence', width: '16%', render: renderCadenceCell },
  ];

  const filteredContacts = useMemo(() => {
    const s = (filter.search || '').toLowerCase();
    return contacts.filter(c => {
      if (filter.status && c.status !== filter.status) return false;
      if (s) {
        const hit = (c.first_name || '').toLowerCase().includes(s)
          || (c.last_name || '').toLowerCase().includes(s)
          || (c.email || '').toLowerCase().includes(s);
        if (!hit) return false;
      }
      return true;
    });
  }, [contacts, filter]);

  const visibleIds = useMemo(() => new Set(filteredContacts.map(c => c.id)), [filteredContacts]);
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
    setSelectedIds(checked ? new Set(filteredContacts.map(c => c.id)) : new Set());
  };
  const clearSelection = () => setSelectedIds(new Set());

  const applyView = (filterSpec, _sort, view) => {
    setFilter({ search: '', status: '', ...filterSpec });
    setActiveViewId(view?.id || null);
    clearSelection();
  };

  const setFilterField = (k, v) => {
    setFilter(prev => ({ ...prev, [k]: v }));
    setActiveViewId(null);
    clearSelection();
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="contacts" />

      <Container size="wide">
        <PageHeader
          title="Contacts"
          subtitle="The people you sell to and stay in touch with."
          primaryAction={{ label: 'New contact', onClick: openNew }}
          secondaryActions={[
            { label: 'Import CSV', icon: 'upload', onClick: () => navigate('/import?type=contacts') },
            { label: 'Export CSV', icon: 'download', onClick: handleExport },
            { label: 'Find duplicates', icon: 'copy', onClick: () => navigate('/duplicates?type=contacts') },
          ]}
        />

        {showForm && (
          <ContactForm
            contactId={editingId}
            onClose={handleFormClose}
            onSuccess={handleFormSuccess}
            onTierLimit={setTierLimit}
          />
        )}

        <div className="space-y-6">
          {error && (
            <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>
          )}

          {/* Gone-quiet cadence strip (mirrors the Accounts rollup strip). Hidden
              entirely when the endpoint is unavailable (module off / error). */}
          {goneQuiet !== null && (
            goneQuiet.length > 0 ? (
              <Alert
                tone="danger"
                icon="clock"
                title={`Gone quiet · ${goneQuiet.length} ${goneQuiet.length === 1 ? 'person is' : 'people are'} past their reconnect cadence`}
              >
                <ul className="mt-2 divide-y divide-danger-100">
                  {goneQuiet.map((c) => (
                    <li key={c.id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <button
                        type="button"
                        onClick={() => openContact(c.id)}
                        className="font-medium text-gray-900 hover:text-brand-blue hover:underline text-left"
                      >
                        {c.first_name} {c.last_name}
                      </button>
                      <span className="text-xs font-semibold">
                        {c.never_touched ? 'never touched' : `${c.days_overdue}d overdue`}
                      </span>
                      <span className="text-xs text-gray-500">
                        {c.never_touched
                          ? `cadence every ${c.cadence_days}d`
                          : `last touch ${c.days_since_last_touch}d ago · cadence every ${c.cadence_days}d`}
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon="check"
                        className="ml-auto"
                        onClick={() => markTouched(c)}
                        loading={touchingIds.has(c.id)}
                        loadingLabel="Saving…"
                      >
                        Mark touched
                      </Button>
                    </li>
                  ))}
                </ul>
              </Alert>
            ) : (
              <Alert tone="success" title="Gone quiet: nobody">
                {contacts.some((c) => c.cadence_days != null)
                  ? 'Everyone with a cadence has been touched on time. Nice.'
                  : 'Set a reconnect cadence on a contact and anyone who goes quiet will surface here.'}
              </Alert>
            )
          )}

          <div>
            <SavedViewsTabs
              resource="contacts"
              currentFilter={filter}
              currentSort={{}}
              activeViewId={activeViewId}
              onApplyView={applyView}
            />

            <Card padding="sm">
              <div className="flex flex-wrap gap-2">
                <Input
                  leadingIcon="search"
                  placeholder="Search contacts…"
                  aria-label="Search contacts"
                  value={filter.search}
                  onChange={(e) => setFilterField('search', e.target.value)}
                  wrapperClassName="flex-1 min-w-[200px]"
                />
                <Select
                  value={filter.status}
                  onChange={(e) => setFilterField('status', e.target.value)}
                  aria-label="Filter contacts by status"
                  wrapperClassName="w-40"
                >
                  <option value="">Any status</option>
                  {CONTACT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </Select>
              </div>
            </Card>
          </div>

          <DataTable
            columns={columns}
            data={filteredContacts}
            loading={loading}
            onEdit={(contact) => {
              setEditingId(contact.id);
              setShowForm(true);
            }}
            onDelete={handleDelete}
            selectedIds={visibleSelected}
            onToggleRow={toggleRow}
            onToggleAll={toggleAll}
            emptyState={{
              icon: 'users',
              title: contacts.length === 0
                ? "Let's build your contact list"
                : 'No contacts match your filters',
              message: contacts.length === 0
                ? 'Contacts are the humans you sell to. Bring your whole book in from a CSV in one shot, or add the first one by hand.'
                : 'Try clearing the search box or relaxing a filter.',
              action: contacts.length === 0 ? (
                <div className="flex flex-wrap gap-2 justify-center">
                  <Button variant="secondary" icon="upload" onClick={() => navigate('/import?type=contacts')}>
                    Import CSV
                  </Button>
                  <Button variant="primary" icon="plus" onClick={openNew}>
                    Create your first contact
                  </Button>
                </div>
              ) : null,
            }}
            rowActions={[
              { label: 'Open', onClick: (contact) => openContact(contact.id) },
              {
                label: 'Email',
                // Only enabled when the contact has an email on file. The
                // composer locks To: to the row's address for safety; ad-hoc
                // addresses use a different entry point.
                disabled: (contact) => !contact.email,
                onClick: (contact) => {
                  if (!contact.email) return;
                  setEmailContact(contact);
                },
              },
              { label: 'Enrich', onClick: (contact) => setEnrichContact(contact) },
            ]}
          />
        </div>

        {selectedContactId && (
          <ContactPanel
            contactId={selectedContactId}
            companies={companies}
            onClose={closeContact}
            onChanged={() => { fetchContacts(); fetchGoneQuiet(); }}
            onEdit={editFromPanel}
          />
        )}

        <EmailComposerModal
          open={!!emailContact}
          onClose={() => setEmailContact(null)}
          onSent={() => setEmailContact(null)}
          contact={emailContact}
        />

        <EnrichModal
          open={!!enrichContact}
          entity="contacts"
          record={enrichContact}
          recordLabel={enrichContact ? `${enrichContact.first_name || ''} ${enrichContact.last_name || ''}`.trim() : ''}
          onClose={() => setEnrichContact(null)}
          onApplied={fetchContacts}
        />

        <DuplicateWarningToast
          warning={dupWarning}
          entityType="contacts"
          onDismiss={() => setDupWarning(null)}
        />

        <TierLimitToast
          info={tierLimit}
          onDismiss={() => setTierLimit(null)}
        />
      </Container>

      <BulkActionBar
        resource="contacts"
        selectedIds={visibleSelected}
        totalCount={filteredContacts.length}
        ownerOptions={members}
        ownerField="owner_id"
        statusOptions={CONTACT_STATUSES}
        statusLabel="Change status"
        onClear={clearSelection}
        onComplete={() => { clearSelection(); fetchContacts(); }}
      />
    </div>
  );
}
