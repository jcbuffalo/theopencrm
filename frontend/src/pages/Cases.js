// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Nav from '../components/Nav';
import CommentThread from '../components/CommentThread';
import DataTable from '../components/DataTable';
import api, { cases as casesApi } from '../api';
import { Alert, Button, Card, Container, Input, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea } from '../components/ui';

// Support Cases (CS-5) — the customer-service ticket board. Mirrors Issues.js
// in shape (filter bar → table/cards → create-or-edit modal) but for the
// post-sale support motion: cases link to a company/contact, carry a
// priority + SLA due date, and the backend stamps resolved_at on the
// resolved/closed transition. Backend: /api/cases (caseRoutes.js), gated by
// customer_success_enabled.

const STATUSES = [
  { value: 'open',     label: 'Open'     },
  { value: 'pending',  label: 'Pending'  },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed',   label: 'Closed'   },
];
const PRIORITIES = [
  { value: 'low',    label: 'Low'    },
  { value: 'normal', label: 'Normal' },
  { value: 'high',   label: 'High'   },
  { value: 'urgent', label: 'Urgent' },
];

const PRIORITY_TONE = { urgent: 'error', high: 'warning', normal: 'info', low: 'neutral' };

function slaState(c) {
  if (!c.sla_due_at || c.status === 'resolved' || c.status === 'closed') return null;
  const due = new Date(c.sla_due_at).getTime();
  if (Number.isNaN(due)) return null;
  const hoursLeft = (due - Date.now()) / 3600000;
  if (hoursLeft < 0) return { label: 'SLA breached', tone: 'error' };
  if (hoursLeft < 24) return { label: 'SLA < 24h', tone: 'warning' };
  return null;
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

// datetime-local wants "YYYY-MM-DDTHH:mm" in local time.
function toLocalInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const EMPTY_FORM = {
  subject: '', description: '', priority: 'normal', status: 'open',
  company_id: '', contact_id: '', sla_due_at: '',
};

// Compact native select for the in-row status editor — the Select primitive's
// 32px minimum would double the row height.
const INLINE_SELECT = 'text-xs border border-gray-300 rounded-md px-1.5 py-0.5 bg-white focus:outline-none focus:border-brand-blue';

export default function Cases() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [gated, setGated] = useState(false);
  const [filter, setFilter] = useState({ status: '', priority: '' });
  const [editing, setEditing] = useState(null); // null | 'new' | case row
  const [form, setForm] = useState(EMPTY_FORM);
  const [companies, setCompanies] = useState([]);
  const [contacts, setContacts] = useState([]);

  const load = async () => {
    try {
      setLoading(true);
      const data = await casesApi.list({ status: filter.status, priority: filter.priority });
      setItems(Array.isArray(data) ? data : []);
      setError('');
      setGated(false);
    } catch (e) {
      if (e.response?.data?.code === 'FEATURE_DISABLED') setGated(true);
      else setError(e.response?.data?.error || 'Failed to load cases');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [filter.status, filter.priority]); // eslint-disable-line react-hooks/exhaustive-deps

  // Companies + contacts for the link dropdowns — best-effort; the form still
  // works (unlinked) if either fetch fails.
  useEffect(() => {
    api.get('/companies').then((r) => setCompanies(Array.isArray(r.data) ? r.data : [])).catch(() => {});
    api.get('/contacts').then((r) => setContacts(Array.isArray(r.data) ? r.data : [])).catch(() => {});
  }, []);

  const openNew = () => { setForm(EMPTY_FORM); setEditing('new'); };
  const openEdit = (c) => {
    setForm({
      subject: c.subject || '', description: c.description || '',
      priority: c.priority || 'normal', status: c.status || 'open',
      company_id: c.company_id ?? '', contact_id: c.contact_id ?? '',
      sla_due_at: toLocalInput(c.sla_due_at),
    });
    setEditing(c);
  };

  const save = async (e) => {
    e.preventDefault();
    if (!form.subject.trim()) return;
    const payload = {
      subject: form.subject,
      description: form.description || null,
      priority: form.priority,
      status: form.status,
      company_id: form.company_id ? Number(form.company_id) : null,
      contact_id: form.contact_id ? Number(form.contact_id) : null,
      sla_due_at: form.sla_due_at ? new Date(form.sla_due_at).toISOString() : null,
    };
    try {
      if (editing === 'new') await casesApi.create(payload);
      else await casesApi.update(editing.id, payload);
      setEditing(null);
      setForm(EMPTY_FORM);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save case');
    }
  };

  const updateStatus = async (id, status) => {
    try { await casesApi.update(id, { status }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Failed to update case'); }
  };
  const remove = async (id) => {
    if (window.confirm('Delete case?')) {
      try { await casesApi.remove(id); load(); }
      catch (err) { setError(err.response?.data?.error || 'Failed to delete case'); }
    }
  };

  const counts = {
    open: items.filter((c) => c.status === 'open' || c.status === 'pending').length,
    urgent: items.filter((c) => (c.status === 'open' || c.status === 'pending') && c.priority === 'urgent').length,
    breached: items.filter((c) => slaState(c)?.label === 'SLA breached').length,
  };

  const filtered = !!(filter.status || filter.priority);

  const columns = [
    {
      key: 'subject', label: 'Subject',
      render: (c) => {
        const sla = slaState(c);
        return (
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <button type="button" onClick={() => openEdit(c)} className="font-medium text-gray-900 hover:text-brand-blue text-left">{c.subject}</button>
              {sla && <StatusBadge tone={sla.tone} label={sla.label} />}
            </div>
            {c.description && <div className="text-xs text-gray-500 truncate max-w-md font-normal">{c.description}</div>}
          </div>
        );
      },
    },
    {
      key: 'priority', label: 'Priority', width: '110px',
      render: (c) => <StatusBadge tone={PRIORITY_TONE[c.priority] || 'info'} label={<span className="capitalize">{c.priority}</span>} />,
    },
    {
      key: 'company_name', label: 'Account',
      render: (c) => c.company_id
        ? <Link to={`/accounts/${c.company_id}`} className="text-brand-blue hover:underline">{c.company_name || `#${c.company_id}`}</Link>
        : null,
    },
    { key: 'sla_due_at', label: 'SLA due', width: '120px', render: (c) => fmtDate(c.sla_due_at) },
    {
      key: 'status', label: 'Status', width: '130px',
      render: (c) => (
        <select value={c.status} onChange={(e) => updateStatus(c.id, e.target.value)} aria-label={`Status for ${c.subject}`} className={INLINE_SELECT}>
          {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      ),
    },
  ];

  const statusTabs = [
    { id: '', label: 'All' },
    ...STATUSES.map((s) => ({ id: s.value, label: s.label })),
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="cases" />
      <Container size="wide">
        <PageHeader
          title="Cases"
          subtitle={`Customer support tickets · ${counts.open} open · ${counts.urgent} urgent · ${counts.breached} past SLA`}
          primaryAction={{ label: 'New case', onClick: openNew }}
          actions={
            <Select
              size="sm"
              aria-label="Filter by priority"
              value={filter.priority}
              onChange={(e) => setFilter({ ...filter, priority: e.target.value })}
              wrapperClassName="w-36"
            >
              <option value="">All priority</option>
              {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </Select>
          }
        />

        <div className="space-y-6">
          <Tabs
            items={statusTabs}
            value={filter.status}
            onChange={(id) => setFilter({ ...filter, status: id })}
            aria-label="Case status"
          />

          {gated && (
            <Alert tone="warning" icon="lock" title="Support cases are switched off">
              Cases are part of the Customer Success module, which isn't enabled for your organization. Ask your admin to switch it on.
            </Alert>
          )}
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          {!gated && (
            <DataTable
              columns={columns}
              data={items}
              loading={loading}
              onEdit={openEdit}
              onDelete={remove}
              minWidth="820px"
              emptyState={{
                icon: 'inbox',
                title: filtered ? 'No cases match your filters' : 'No support cases yet',
                message: filtered
                  ? 'Try clearing the filters to see the full queue.'
                  : 'When a customer needs a hand, log it here — link it to their account, set a priority and an SLA, and it shows up on their Account 360 automatically.',
                action: !filtered && <Button onClick={openNew} icon="plus">Log your first case</Button>,
              }}
            />
          )}
        </div>
      </Container>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'New case' : 'Edit case'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="submit" form="case-form">{editing === 'new' ? 'Create case' : 'Save changes'}</Button>
          </>
        }
      >
        <form id="case-form" onSubmit={save} className="space-y-4">
          <Input label="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required autoFocus />
          <Textarea label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} />
          <div className="grid grid-cols-2 gap-3">
            <Select label="Priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} options={PRIORITIES} />
            <Select label="Status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} options={STATUSES} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Company" value={form.company_id} onChange={(e) => setForm({ ...form, company_id: e.target.value })}>
              <option value="">No company link</option>
              {companies.map((co) => <option key={co.id} value={co.id}>{co.name}</option>)}
            </Select>
            <Select label="Contact" value={form.contact_id} onChange={(e) => setForm({ ...form, contact_id: e.target.value })}>
              <option value="">No contact link</option>
              {contacts.map((ct) => (
                <option key={ct.id} value={ct.id}>{[ct.first_name, ct.last_name].filter(Boolean).join(' ') || ct.email || `#${ct.id}`}</option>
              ))}
            </Select>
          </div>
          <Input label="SLA due" type="datetime-local" value={form.sla_due_at} onChange={(e) => setForm({ ...form, sla_due_at: e.target.value })} />
          {/* Team comments with @mentions (migration 146) — only on
              existing cases (a new case has no id to attach to yet).
              CommentThread renders no <form> and only type="button"
              buttons, so it nests safely inside this modal's form. */}
          {editing !== null && editing !== 'new' && (
            <div className="border-t border-gray-200 pt-3">
              <div className="text-xs font-semibold text-gray-700 mb-2">Comments</div>
              <CommentThread entityType="case" entityId={editing.id} />
            </div>
          )}
        </form>
      </Modal>
    </div>
  );
}
