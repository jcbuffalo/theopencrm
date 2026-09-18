// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import api from '../api';
import Nav from '../components/Nav';
import DataTable from '../components/DataTable';
import { Button, Container, Input, Modal, PageHeader, Select, Tabs, Textarea } from '../components/ui';

// Customer Appreciation queue — SOW §4.5c.ii.
// Lets the team track thank-you notes, gifts, and other appreciation actions
// that should be sent to customers, optionally tied to specific deals.

const STATUSES = ['queued', 'in_progress', 'sent', 'skipped'];
const STATUS_SELECT = {
  queued:      'bg-info-100 text-info-800',
  in_progress: 'bg-warning-100 text-warning-800',
  sent:        'bg-success-100 text-success-800',
  skipped:     'bg-gray-100 text-gray-600',
};
const REASONS = [
  { id: 'project_completed', label: 'Project completed' },
  { id: 'big_milestone',     label: 'Big milestone' },
  { id: 'long_dormant_recovered', label: 'Long-dormant customer recovered' },
  { id: 'birthday',          label: 'Birthday / anniversary' },
  { id: 'manual',            label: 'Manual / other' },
];
const GIFT_TYPES = [
  { id: 'thank_you_note', label: 'Thank-you note' },
  { id: 'gift_card',      label: 'Gift card' },
  { id: 'merchandise',    label: 'Merchandise' },
  { id: 'flowers',        label: 'Flowers' },
  { id: 'phone_call',     label: 'Phone call' },
  { id: 'other',          label: 'Other' },
];

function AppreciationForm({ item, customers, deals, onClose, onSave }) {
  const [form, setForm] = useState(() => ({
    customer_id: item?.customer_id || '',
    deal_id: item?.deal_id || '',
    reason: item?.reason || 'manual',
    gift_type: item?.gift_type || '',
    notes: item?.notes || '',
    scheduled_for: item?.scheduled_for ? item.scheduled_for.slice(0, 10) : '',
  }));
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        ...form,
        customer_id: form.customer_id || null,
        deal_id: form.deal_id || null,
        scheduled_for: form.scheduled_for || null,
      };
      if (item?.id) await api.put(`/appreciation/${item.id}`, payload);
      else          await api.post('/appreciation', payload);
      onSave();
    } finally { setSaving(false); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={item ? 'Edit item' : 'Queue appreciation item'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="appreciation-form" loading={saving} loadingLabel="Saving…">
            {item ? 'Save' : 'Queue it'}
          </Button>
        </>
      }
    >
      <form id="appreciation-form" onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select label="Customer" value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value })}>
            <option value="">Customer…</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select label="Deal" value={form.deal_id} onChange={(e) => setForm({ ...form, deal_id: e.target.value })}>
            <option value="">Deal (optional)…</option>
            {deals.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
          </Select>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select label="Reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
            {REASONS.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
          </Select>
          <Select label="Gift type" value={form.gift_type} onChange={(e) => setForm({ ...form, gift_type: e.target.value })}>
            <option value="">Gift type…</option>
            {GIFT_TYPES.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
          </Select>
        </div>
        <Input
          type="date"
          label="Schedule for"
          value={form.scheduled_for}
          onChange={(e) => setForm({ ...form, scheduled_for: e.target.value })}
        />
        <Textarea
          label="Notes"
          placeholder="Gift specifics, address, message draft"
          rows={3}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </form>
    </Modal>
  );
}

export default function Appreciation() {
  const [items, setItems] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [deals, setDeals] = useState([]);
  const [filter, setFilter] = useState('queued');
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const params = filter === 'all' ? '' : `?status=${filter}`;
      const [a, c, d] = await Promise.all([
        api.get(`/appreciation${params}`),
        api.get('/companies?type=customer'),
        api.get('/deals'),
      ]);
      setItems(a.data || []);
      setCustomers(c.data || []);
      setDeals(d.data || []);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [filter]);

  const markComplete = async (id) => { await api.post(`/appreciation/${id}/complete`); load(); };
  const remove = async (id) => { if (window.confirm('Remove this item?')) { await api.delete(`/appreciation/${id}`); load(); } };
  const updateStatus = async (id, status) => { await api.put(`/appreciation/${id}`, { status }); load(); };

  const counts = STATUSES.reduce((acc, s) => { acc[s] = items.filter(i => i.status === s).length; return acc; }, {});

  const columns = [
    { key: 'customer_name', label: 'Customer', render: (it) => it.customer_name || '—' },
    { key: 'reason', label: 'Reason', render: (it) => (REASONS.find(r => r.id === it.reason) || {}).label || it.reason },
    { key: 'gift_type', label: 'Gift type', render: (it) => (GIFT_TYPES.find(g => g.id === it.gift_type) || {}).label || '—' },
    { key: 'scheduled_for', label: 'Scheduled', render: (it) => it.scheduled_for ? new Date(it.scheduled_for).toLocaleDateString() : '—' },
    { key: 'deal_title', label: 'Deal', className: 'max-w-xs truncate', render: (it) => it.deal_title || '—' },
    {
      key: 'status',
      label: 'Status',
      render: (it) => (
        // Inline cell editor — kept as a compact native control on purpose.
        <select
          value={it.status}
          onChange={(e) => updateStatus(it.id, e.target.value)}
          onClick={(e) => e.stopPropagation()}
          aria-label="Status"
          className={`text-xs border border-gray-300 rounded-md px-2 py-0.5 ${STATUS_SELECT[it.status] || ''}`}
        >
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      ),
    },
  ];

  const filterItems = [
    { id: 'queued',      label: 'Queued',      count: counts.queued || 0 },
    { id: 'in_progress', label: 'In progress', count: counts.in_progress || 0 },
    { id: 'sent',        label: 'Sent',        count: counts.sent || 0 },
    { id: 'skipped',     label: 'Skipped',     count: counts.skipped || 0 },
    { id: 'all',         label: 'All' },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="appreciation" />
      <Container size="wide">
        <PageHeader
          title="Customer appreciation"
          subtitle="Track thank-you notes, gifts, and follow-ups for customers. SOW §4.5c.ii."
          primaryAction={{ label: 'Queue item', onClick: () => setCreating(true) }}
        />

        <div className="space-y-6">
          <Tabs items={filterItems} value={filter} onChange={setFilter} aria-label="Filter by status" />

          <DataTable
            columns={columns}
            data={items}
            loading={loading}
            rowActions={[
              { label: 'Mark sent', onClick: (it) => markComplete(it.id), disabled: (it) => it.status === 'sent' },
              { label: 'Edit', onClick: (it) => setEditing(it) },
            ]}
            onDelete={remove}
            emptyState={{
              icon: 'star',
              title: filter === 'all' ? 'No appreciation items yet' : `No ${filter.replace('_', ' ')} items`,
              message: 'Queue a thank-you note or gift when a customer hits a milestone.',
              action: <Button size="sm" icon="plus" onClick={() => setCreating(true)}>Queue item</Button>,
            }}
          />
        </div>
      </Container>

      {(editing || creating) && (
        <AppreciationForm
          item={editing}
          customers={customers}
          deals={deals}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSave={() => { setEditing(null); setCreating(false); load(); }}
        />
      )}
    </div>
  );
}
