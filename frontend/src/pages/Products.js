// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import Nav from '../components/Nav';
import DataTable from '../components/DataTable';
import api from '../api';
import { useAuth } from '../AuthContext';
import { Alert, Button, Container, Input, Modal, PageHeader, StatusBadge, Textarea } from '../components/ui';

// Product catalog admin — the reusable priced line items that feed the generic
// light-CPQ quote builder (/quotes-builder). This is the GENERIC quoting
// surface for generic/jcp/rin orgs; it is intentionally separate from the Zang
// /quotes workflow. Catalog mutation is org-admin-only (the backend enforces
// this too — the buttons are just hidden for non-admins).

function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const EMPTY = { name: '', sku: '', description: '', unit_price: '', unit: 'each', active: true };

function ProductModal({ initial, onCancel, onSaved }) {
  const [form, setForm] = useState(initial || EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const editing = !!initial?.id;

  const save = async (e) => {
    e?.preventDefault?.();
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError('');
    try {
      const payload = {
        name: form.name.trim(),
        sku: form.sku?.trim() || null,
        description: form.description || null,
        unit_price: form.unit_price === '' ? 0 : Number(form.unit_price),
        unit: form.unit?.trim() || 'each',
        active: form.active !== false,
      };
      if (editing) await api.put(`/products/${initial.id}`, payload);
      else await api.post('/products', payload);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save product');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title={editing ? 'Edit product' : 'New product'}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button type="submit" form="product-form" loading={saving} loadingLabel="Saving…">
            {editing ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <form id="product-form" onSubmit={save} className="space-y-4">
        {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}
        <Input
          label="Name"
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          autoFocus
          placeholder="e.g. Annual license"
        />
        <div className="grid grid-cols-2 gap-3">
          <Input label="SKU" value={form.sku || ''} onChange={(e) => setForm({ ...form, sku: e.target.value })} placeholder="Optional" />
          <Input label="Unit" value={form.unit || ''} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="each / hour / seat" />
        </div>
        <Input
          label="Unit price"
          type="number"
          min="0"
          step="0.01"
          value={form.unit_price}
          onChange={(e) => setForm({ ...form, unit_price: e.target.value })}
          placeholder="0.00"
        />
        <Textarea label="Description" value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} />
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue"
            checked={form.active !== false}
            onChange={(e) => setForm({ ...form, active: e.target.checked })}
          />
          Active (available in the quote builder)
        </label>
      </form>
    </Modal>
  );
}

export default function Products() {
  const { user } = useAuth();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // product object | 'new' | null

  // Catalog mutation is org-admin-only. Personal (org-less) workspaces own all
  // their own data. Mirrors the backend requireCatalogAdmin gate.
  const canManage = !user?.org_id || ['owner', 'admin'].includes(user?.org_role);

  const load = async () => {
    try {
      setLoading(true);
      const r = await api.get('/products');
      setProducts(r.data);
      setError('');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load products');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const remove = async (id) => {
    if (!window.confirm('Delete this product? Existing quotes keep their line snapshot.')) return;
    try {
      await api.delete(`/products/${id}`);
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to delete');
    }
  };

  const columns = [
    {
      key: 'name',
      label: 'Name',
      render: (p) => (
        <>
          <div className="font-medium text-gray-900">{p.name}</div>
          {p.description && <div className="text-xs text-gray-500 font-normal">{p.description}</div>}
        </>
      ),
    },
    { key: 'sku', label: 'SKU', render: (p) => <span className="text-gray-500">{p.sku || '—'}</span> },
    { key: 'unit_price', label: 'Unit price', align: 'right', render: (p) => <span className="font-medium">{fmtMoney(p.unit_price)}</span> },
    { key: 'unit', label: 'Unit' },
    {
      key: 'active',
      label: 'Status',
      render: (p) => <StatusBadge tone={p.active ? 'success' : 'neutral'} label={p.active ? 'Active' : 'Inactive'} />,
    },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="products" />
      <Container size="wide">
        <PageHeader
          title="Products"
          subtitle="Your reusable catalog for the quote builder."
          primaryAction={canManage ? { label: 'New product', onClick: () => setEditing('new') } : undefined}
        />

        <div className="space-y-6">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          <DataTable
            columns={columns}
            data={products}
            loading={loading}
            onEdit={canManage ? (p) => setEditing(p) : undefined}
            onDelete={canManage ? remove : undefined}
            emptyState={{
              icon: 'briefcase',
              title: 'Your catalog is empty',
              message: canManage
                ? "Add the products and services you sell once, and they'll be one click away in every quote."
                : 'No products in the catalog yet — ask an admin to add the items you sell.',
              action: canManage ? <Button icon="plus" onClick={() => setEditing('new')}>New product</Button> : undefined,
            }}
          />
        </div>
      </Container>

      {editing && (
        <ProductModal
          initial={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}
