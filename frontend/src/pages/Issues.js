// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import Nav from '../components/Nav';
import DataTable from '../components/DataTable';
import api from '../api';
import { Alert, Button, Card, Container, Input, Modal, PageHeader, Select, StatusBadge, Textarea, controlClasses } from '../components/ui';

const CATEGORIES = ['logistics', 'technical', 'financial', 'other'];
// The stored enum values carry the Zang white-label name ('zang', 'zang_*') —
// a leak when this page renders for a generic/jcp/rin org. Keep the backend
// values but present neutral, profile-agnostic labels everywhere they show.
const FINANCIAL_IMPACTS = [
  { value: '',              label: 'No financial impact' },
  { value: 'zang',          label: 'Us' },
  { value: 'customer',      label: 'Customer' },
  { value: 'vendor',        label: 'Vendor' },
  { value: 'zang_customer', label: 'Us + Customer' },
  { value: 'zang_vendor',   label: 'Us + Vendor' },
];
const FINANCIAL_IMPACT_LABELS = Object.fromEntries(FINANCIAL_IMPACTS.map(f => [f.value, f.label]));
const financialImpactLabel = (v) => FINANCIAL_IMPACT_LABELS[v] ?? v;

const URGENCY_TONE = { red: 'error', yellow: 'warning', green: 'success' };
const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'bypassed', label: 'Bypassed' },
];

const EMPTY_FORM = {
  title: '', description: '', urgency: 'green', category: 'logistics',
  sub_category: '', financial_impact: '', blocks_workflow: false,
  related_type: '', related_id: '',
};

export default function Issues() {
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Seed the filter from the URL so deep-links (e.g. the Dashboard "Open issues
  // by urgency" cards → /issues?urgency=red) land on the matching filtered view
  // instead of a generic open-issues list that doesn't match the number clicked.
  const [filter, setFilter] = useState(() => {
    const sp = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
    return {
      status: sp.get('status') || 'open',
      urgency: sp.get('urgency') || '',
      category: sp.get('category') || '',
    };
  });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const load = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (filter.status)   params.set('status', filter.status);
      if (filter.urgency)  params.set('urgency', filter.urgency);
      if (filter.category) params.set('category', filter.category);
      const r = await api.get(`/issues?${params}`);
      setIssues(r.data);
      setError('');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load issues');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [filter.status, filter.urgency, filter.category]);

  const create = async (e) => {
    e.preventDefault();
    if (!form.title) return;
    try {
      await api.post('/issues', { ...form, related_id: form.related_id ? Number(form.related_id) : null });
      setForm(EMPTY_FORM);
      setAdding(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create issue');
    }
  };

  const updateStatus = async (id, status) => { await api.put(`/issues/${id}`, { status }); load(); };
  const remove = async (id) => { if (window.confirm('Delete issue?')) { await api.delete(`/issues/${id}`); load(); } };

  const counts = {
    red: issues.filter(i => i.urgency === 'red').length,
    yellow: issues.filter(i => i.urgency === 'yellow').length,
    green: issues.filter(i => i.urgency === 'green').length,
    blocking: issues.filter(i => i.blocks_workflow && i.status === 'open').length,
  };

  const columns = [
    {
      key: 'title',
      label: 'Issue',
      render: (i) => (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-900">{i.title}</span>
            {i.blocks_workflow && <StatusBadge tone="error" label="Blocking" />}
          </div>
          {i.description && <div className="text-xs text-gray-500 truncate max-w-md font-normal">{i.description}</div>}
        </>
      ),
    },
    {
      key: 'urgency',
      label: 'Urgency',
      render: (i) => <StatusBadge tone={URGENCY_TONE[i.urgency] || 'neutral'} label={i.urgency} className="capitalize" />,
    },
    { key: 'category', label: 'Category', render: (i) => `${i.category || '—'}${i.sub_category ? ` · ${i.sub_category}` : ''}` },
    { key: 'related', label: 'Related', render: (i) => <span className="text-xs text-gray-500">{i.related_type ? `${i.related_type} #${i.related_id}` : '—'}</span> },
    { key: 'financial_impact', label: 'Impact', render: (i) => <span className="text-xs">{i.financial_impact ? financialImpactLabel(i.financial_impact) : '—'}</span> },
    {
      key: 'status',
      label: 'Status',
      render: (i) => (
        // Inline cell editor — compact native control so rows stay dense.
        <select
          value={i.status}
          onChange={(e) => updateStatus(i.id, e.target.value)}
          aria-label={`Status for ${i.title}`}
          className={controlClasses({ size: 'sm', className: 'text-xs w-auto' })}
        >
          {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="issues" />
      <Container size="wide">
        <PageHeader
          title="Issues"
          subtitle={`Open issues across all records · ${counts.red} red · ${counts.yellow} yellow · ${counts.blocking} blocking`}
          primaryAction={{ label: 'New issue', onClick: () => setAdding(true) }}
        />

        <div className="space-y-6">
          <Card padding="sm">
            <div className="flex flex-wrap gap-3 items-center">
              <Select size="sm" wrapperClassName="w-40" aria-label="Filter by status" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
                <option value="">All status</option>
                {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
              <Select size="sm" wrapperClassName="w-40" aria-label="Filter by urgency" value={filter.urgency} onChange={(e) => setFilter({ ...filter, urgency: e.target.value })}>
                <option value="">All urgency</option>
                <option value="red">Red</option>
                <option value="yellow">Yellow</option>
                <option value="green">Green</option>
              </Select>
              <Select size="sm" wrapperClassName="w-44" aria-label="Filter by category" value={filter.category} onChange={(e) => setFilter({ ...filter, category: e.target.value })}>
                <option value="">All categories</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </Select>
            </div>
          </Card>

          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          <DataTable
            columns={columns}
            data={issues}
            loading={loading}
            onDelete={remove}
            emptyState={{ icon: 'alert-circle', title: 'No issues match your filters', message: 'Try widening the status or urgency filter.' }}
          />
        </div>
      </Container>

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="New issue"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="submit" form="issue-form">Create issue</Button>
          </>
        }
      >
        <form id="issue-form" onSubmit={create} className="space-y-4">
          <Input label="Title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus />
          <Textarea label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} />
          <div className="grid grid-cols-2 gap-3">
            <Select label="Urgency" value={form.urgency} onChange={(e) => setForm({ ...form, urgency: e.target.value })}>
              <option value="green">Green</option>
              <option value="yellow">Yellow</option>
              <option value="red">Red</option>
            </Select>
            <Select label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Sub-category" value={form.sub_category} onChange={(e) => setForm({ ...form, sub_category: e.target.value })} />
            <Select label="Financial impact" value={form.financial_impact} onChange={(e) => setForm({ ...form, financial_impact: e.target.value })}>
              {FINANCIAL_IMPACTS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Related record" value={form.related_type} onChange={(e) => setForm({ ...form, related_type: e.target.value })}>
              <option value="">No record link</option>
              <option value="deal">Deal</option>
              <option value="contact">Contact</option>
              <option value="company">Company</option>
            </Select>
            <Input label="Related ID" type="number" value={form.related_id} onChange={(e) => setForm({ ...form, related_id: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue"
              checked={form.blocks_workflow}
              onChange={(e) => setForm({ ...form, blocks_workflow: e.target.checked })}
            />
            Blocks workflow
          </label>
        </form>
      </Modal>
    </div>
  );
}
