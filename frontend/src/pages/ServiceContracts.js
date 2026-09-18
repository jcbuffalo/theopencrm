// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import api from '../api';
import Nav from '../components/Nav';
import DataTable from '../components/DataTable';
import { Alert, Button, Container, Input, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea } from '../components/ui';

function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  return `$${Number(n).toLocaleString()}`;
}

const STATUSES = ['active', 'expired', 'cancelled'];
const TYPES    = ['service', 'maintenance', 'support', 'subscription', 'other'];
const STATUS_TONE = { active: 'success', expired: 'warning', cancelled: 'neutral' };

const FILTER_TABS = [
  { id: 'active',    label: 'Active' },
  { id: 'renewal',   label: 'Due for renewal' },
  { id: 'expired',   label: 'Expired' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'all',       label: 'All' },
];

function ContractForm({ contract, customers, deals, onClose, onSave }) {
  const [form, setForm] = useState(() => ({
    name: contract?.name || '',
    contract_type: contract?.contract_type || 'service',
    customer_id: contract?.customer_id || '',
    deal_id: contract?.deal_id || '',
    start_date: contract?.start_date ? contract.start_date.slice(0, 10) : '',
    end_date: contract?.end_date ? contract.end_date.slice(0, 10) : '',
    renewal_notice_days: contract?.renewal_notice_days || 30,
    monthly_amount: contract?.monthly_amount || '',
    status: contract?.status || 'active',
    notes: contract?.notes || '',
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const payload = {
        ...form,
        customer_id: form.customer_id || null,
        deal_id: form.deal_id || null,
        monthly_amount: form.monthly_amount ? Number(form.monthly_amount) : null,
        renewal_notice_days: Number(form.renewal_notice_days) || 30,
      };
      if (contract?.id) await api.put(`/service-contracts/${contract.id}`, payload);
      else              await api.post('/service-contracts', payload);
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={contract ? 'Edit contract' : 'New service contract'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="contract-form" loading={saving} loadingLabel="Saving…">
            {contract ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <form id="contract-form" onSubmit={submit} className="space-y-4">
        {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

        <Input label="Contract name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />

        <div className="grid grid-cols-2 gap-3">
          <Select label="Customer" value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value })}>
            <option value="">Customer…</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select label="Linked deal" value={form.deal_id} onChange={(e) => setForm({ ...form, deal_id: e.target.value })}>
            <option value="">Linked deal…</option>
            {deals.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Select label="Type" value={form.contract_type} onChange={(e) => setForm({ ...form, contract_type: e.target.value })} options={TYPES} />
          <Select label="Status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} options={STATUSES} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input label="Start date" type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
          <Input label="End date" type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Renewal notice (days before end)"
            type="number"
            min="1"
            value={form.renewal_notice_days}
            onChange={(e) => setForm({ ...form, renewal_notice_days: e.target.value })}
          />
          <Input label="Monthly $" type="number" value={form.monthly_amount} onChange={(e) => setForm({ ...form, monthly_amount: e.target.value })} />
        </div>

        <Textarea label="Notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </form>
    </Modal>
  );
}

export default function ServiceContracts() {
  const [contracts, setContracts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [deals, setDeals] = useState([]);
  const [filter, setFilter] = useState('active');
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const params = filter === 'renewal' ? '?due_for_renewal=true' : (filter === 'all' ? '' : `?status=${filter}`);
      const [r, c, d] = await Promise.all([
        api.get(`/service-contracts${params}`),
        api.get('/companies?type=customer'),
        api.get('/deals'),
      ]);
      setContracts(r.data || []);
      setCustomers(c.data || []);
      setDeals(d.data || []);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load contracts');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [filter]);

  const remove = async (id) => {
    if (!window.confirm('Delete this contract?')) return;
    await api.delete(`/service-contracts/${id}`);
    load();
  };

  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'customer_name', label: 'Customer', render: (c) => c.customer_name || '—' },
    { key: 'contract_type', label: 'Type', render: (c) => <span className="text-xs text-gray-600">{c.contract_type}</span> },
    {
      key: 'period',
      label: 'Period',
      render: (c) => (
        <span className="text-xs text-gray-600">
          {c.start_date ? new Date(c.start_date).toLocaleDateString() : '—'}
          <span className="text-gray-400"> → </span>
          {c.end_date ? new Date(c.end_date).toLocaleDateString() : '—'}
        </span>
      ),
    },
    {
      key: 'days_to_end',
      label: 'Days left',
      align: 'right',
      render: (c) => {
        const days = c.days_to_end !== null && c.days_to_end !== undefined ? Number(c.days_to_end) : null;
        if (days === null) return '—';
        return (
          <span className={days <= (c.renewal_notice_days || 30) ? 'text-warning-700 font-semibold' : 'text-gray-700'}>{days}</span>
        );
      },
    },
    { key: 'monthly_amount', label: 'Monthly $', align: 'right', render: (c) => fmtMoney(c.monthly_amount) },
    { key: 'status', label: 'Status', render: (c) => <StatusBadge tone={STATUS_TONE[c.status] || 'neutral'} label={c.status} className="capitalize" /> },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="service-contracts" />
      <Container size="wide">
        <PageHeader
          title="Service contracts"
          subtitle="Track service / maintenance / subscription contracts. Automation flags renewals due in their notice window."
          primaryAction={{ label: 'New contract', onClick: () => setCreating(true) }}
        />

        <div className="space-y-6">
          <Tabs items={FILTER_TABS} value={filter} onChange={setFilter} aria-label="Contract filters" />

          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          <DataTable
            columns={columns}
            data={contracts}
            loading={loading}
            onEdit={(c) => setEditing(c)}
            onDelete={remove}
            emptyState={{
              icon: 'briefcase',
              title: `No contracts${filter !== 'all' ? ` (${filter})` : ''}`,
              message: 'Contracts you add here feed the renewals board and renewal-alert automation.',
              action: <Button icon="plus" onClick={() => setCreating(true)}>New contract</Button>,
            }}
          />
        </div>
      </Container>

      {(editing || creating) && (
        <ContractForm
          contract={editing}
          customers={customers}
          deals={deals}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSave={() => { setEditing(null); setCreating(false); load(); }}
        />
      )}
    </div>
  );
}
