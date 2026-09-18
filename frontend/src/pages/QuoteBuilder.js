// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useMemo, useState } from 'react';
import Nav from '../components/Nav';
import DataTable from '../components/DataTable';
import api, { downloadBlob } from '../api';
import { Alert, Button, Container, Icon, Input, Modal, PageHeader, Select, StatusBadge, Textarea, controlClasses } from '../components/ui';

// Generic light-CPQ quote builder — pick catalog products, set qty/discount,
// see live totals, save, download a branded PDF. Separate surface from the
// Zang /quotes workflow. Money shown here is a client-side PREVIEW; the server
// recomputes authoritatively on save (see backend/services/salesQuotes.js).

function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '$0.00';
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Client-side mirror of the server line math (preview only).
function previewTotals(items, discount, taxRate) {
  const cents = (v) => Math.round((Number(v) || 0) * 100);
  const lineCents = (it) => {
    const qty = Number(it.quantity) > 0 ? Number(it.quantity) : 0;
    const dp = Math.min(Math.max(Number(it.discount_pct) || 0, 0), 100);
    return Math.round(cents(it.unit_price) * qty * (1 - dp / 100));
  };
  const subtotalC = items.reduce((s, it) => s + lineCents(it), 0);
  const discC = Math.min(Math.max(cents(discount), 0), subtotalC);
  const taxableC = subtotalC - discC;
  const rate = Math.max(Number(taxRate) || 0, 0);
  const taxC = Math.round(taxableC * rate / 100);
  return {
    lineTotal: (it) => lineCents(it) / 100,
    subtotal: subtotalC / 100,
    discount: discC / 100,
    tax: taxC / 100,
    total: (taxableC + taxC) / 100,
  };
}

const BLANK_LINE = { product_id: '', name: '', quantity: 1, unit_price: '', discount_pct: '' };
const STATUS_TONE = { draft: 'neutral', sent: 'info', accepted: 'success', rejected: 'error', expired: 'warning' };

// Compact native controls for the line-item grid — the primitives' 40px
// minimum would double row height.
const CELL = controlClasses({ size: 'sm', className: 'text-sm' });
const CELL_RIGHT = controlClasses({ size: 'sm', className: 'text-sm text-right' });

function BuilderModal({ products, customers, deals, onCancel, onCreated }) {
  const [form, setForm] = useState({ title: '', customer_id: '', deal_id: '', status: 'draft', notes: '', discount: '', tax_rate: '' });
  const [items, setItems] = useState([{ ...BLANK_LINE }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const t = useMemo(() => previewTotals(items, form.discount, form.tax_rate), [items, form.discount, form.tax_rate]);

  const updateItem = (i, patch) => setItems(prev => prev.map((it, idx) => idx === i ? { ...it, ...patch } : it));
  const addLine = () => setItems(prev => [...prev, { ...BLANK_LINE }]);
  const removeLine = (i) => setItems(prev => prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i));

  // Picking a product autofills name + unit price (still editable per line).
  const pickProduct = (i, productId) => {
    const p = products.find(pr => String(pr.id) === String(productId));
    updateItem(i, p
      ? { product_id: p.id, name: p.name, unit_price: p.unit_price }
      : { product_id: '' });
  };

  const canSave = items.some(it => (it.name || '').trim());

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const cleanItems = items
        .filter(it => (it.name || '').trim())
        .map(it => ({
          product_id: it.product_id || null,
          name: it.name.trim(),
          quantity: Number(it.quantity) || 1,
          unit_price: it.unit_price === '' ? 0 : Number(it.unit_price),
          discount_pct: it.discount_pct === '' ? 0 : Number(it.discount_pct),
        }));
      const { data } = await api.post('/sales-quotes', {
        title: form.title.trim() || null,
        customer_id: form.customer_id || null,
        deal_id: form.deal_id || null,
        status: form.status,
        notes: form.notes || null,
        discount: form.discount === '' ? 0 : Number(form.discount),
        tax_rate: form.tax_rate === '' ? 0 : Number(form.tax_rate),
        items: cleanItems,
      });
      onCreated(data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save quote');
    } finally {
      setSaving(false);
    }
  };

  const footer = (
    <div className="flex w-full items-center justify-between gap-3 flex-wrap">
      <span className="text-xs text-gray-500">Server recomputes totals on save.</span>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button onClick={save} disabled={!canSave} loading={saving} loadingLabel="Saving…">Save quote</Button>
      </div>
    </div>
  );

  return (
    <Modal open onClose={onCancel} title="New quote" size="xl" footer={footer}>
      <div className="space-y-5">
        {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

        <div className="grid grid-cols-2 gap-3">
          <Input
            wrapperClassName="col-span-2"
            label="Quote title"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="e.g. Acme — Q3 expansion"
            autoFocus
          />
          <Select label="Customer" value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value })}>
            <option value="">None</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select label="Link to deal" value={form.deal_id} onChange={(e) => setForm({ ...form, deal_id: e.target.value })}>
            <option value="">None — standalone</option>
            {deals.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
          </Select>
        </div>

        {/* Line items */}
        <div>
          <div className="border border-gray-200 rounded overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-2 py-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Product / item</th>
                  <th className="text-right px-2 py-2 text-xs font-semibold uppercase tracking-wider text-gray-500 w-16">Qty</th>
                  <th className="text-right px-2 py-2 text-xs font-semibold uppercase tracking-wider text-gray-500 w-24">Unit $</th>
                  <th className="text-right px-2 py-2 text-xs font-semibold uppercase tracking-wider text-gray-500 w-20">Disc %</th>
                  <th className="text-right px-2 py-2 text-xs font-semibold uppercase tracking-wider text-gray-500 w-24">Line total</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i} className="border-t border-gray-100 align-top">
                    <td className="px-2 py-1.5 space-y-1">
                      <select value={it.product_id} onChange={(e) => pickProduct(i, e.target.value)} aria-label={`Line ${i + 1} product`} className={CELL}>
                        <option value="">Custom line…</option>
                        {products.filter(p => p.active).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                      <input type="text" value={it.name} onChange={(e) => updateItem(i, { name: e.target.value })} aria-label={`Line ${i + 1} description`}
                        className={CELL} placeholder="Line description" />
                    </td>
                    <td className="px-2 py-1.5">
                      <input type="number" min="0" step="0.01" value={it.quantity} onChange={(e) => updateItem(i, { quantity: e.target.value })}
                        aria-label={`Line ${i + 1} quantity`} className={CELL_RIGHT} />
                    </td>
                    <td className="px-2 py-1.5">
                      <input type="number" min="0" step="0.01" value={it.unit_price} onChange={(e) => updateItem(i, { unit_price: e.target.value })}
                        aria-label={`Line ${i + 1} unit price`} className={CELL_RIGHT} />
                    </td>
                    <td className="px-2 py-1.5">
                      <input type="number" min="0" max="100" step="0.01" value={it.discount_pct} onChange={(e) => updateItem(i, { discount_pct: e.target.value })}
                        aria-label={`Line ${i + 1} discount`} className={CELL_RIGHT} />
                    </td>
                    <td className="px-2 py-2.5 text-right font-medium text-gray-900">{fmtMoney(t.lineTotal(it))}</td>
                    <td className="px-1 py-2 text-right">
                      <button type="button" onClick={() => removeLine(i)} disabled={items.length === 1} aria-label="Remove line"
                        className="rounded-md p-1 text-gray-400 hover:text-danger-600 hover:bg-danger-50 disabled:opacity-30 disabled:cursor-not-allowed">
                        <Icon name="x" size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button variant="ghost" size="sm" icon="plus" onClick={addLine} className="mt-2">Add line item</Button>
        </div>

        {/* Totals + adjustments */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-3">
            <Input label="Discount ($)" type="number" min="0" step="0.01" value={form.discount} onChange={(e) => setForm({ ...form, discount: e.target.value })} placeholder="0.00" />
            <Input label="Tax rate (%)" type="number" min="0" step="0.001" value={form.tax_rate} onChange={(e) => setForm({ ...form, tax_rate: e.target.value })} placeholder="0" />
          </div>
          <div className="bg-gray-50 border border-gray-200 rounded p-4 space-y-1 text-sm self-start">
            <div className="flex justify-between"><span className="text-gray-500">Subtotal</span><span className="font-medium">{fmtMoney(t.subtotal)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Discount</span><span className="font-medium">− {fmtMoney(t.discount)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Tax</span><span className="font-medium">{fmtMoney(t.tax)}</span></div>
            <div className="flex justify-between border-t border-gray-300 pt-1 mt-1">
              <span className="font-semibold text-gray-700">Total</span><span className="font-semibold text-lg">{fmtMoney(t.total)}</span>
            </div>
          </div>
        </div>

        <Textarea label="Notes / terms" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
      </div>
    </Modal>
  );
}

export default function QuoteBuilder() {
  const [quotes, setQuotes] = useState([]);
  const [products, setProducts] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [building, setBuilding] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      const [q, p, c, d] = await Promise.all([
        api.get('/sales-quotes'), api.get('/products'), api.get('/companies'), api.get('/deals'),
      ]);
      setQuotes(q.data);
      setProducts(p.data);
      setCompanies(c.data);
      setDeals(d.data);
      setError('');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load quotes');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const customers = companies.filter(c => c.type === 'customer' || !c.type);

  const downloadPdf = (q) => {
    const filename = `${(q.title || `quote-${q.id}`).replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`;
    downloadBlob(`/sales-quotes/${q.id}/pdf`, filename).catch(() => alert('Failed to generate PDF'));
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this quote?')) return;
    await api.delete(`/sales-quotes/${id}`);
    load();
  };

  const columns = [
    { key: 'title', label: 'Title', render: (q) => q.title || `Quote #${q.id}` },
    { key: 'customer_name', label: 'Customer', render: (q) => q.customer_name || '—' },
    { key: 'deal_title', label: 'Deal', render: (q) => <span className="text-xs text-gray-500">{q.deal_title || '—'}</span> },
    { key: 'total', label: 'Total', align: 'right', render: (q) => <span className="font-medium">{fmtMoney(q.total)}</span> },
    { key: 'status', label: 'Status', render: (q) => <StatusBadge tone={STATUS_TONE[q.status] || 'neutral'} label={q.status} className="capitalize" /> },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="quote-builder" />
      <Container size="wide">
        <PageHeader
          title="Quotes"
          subtitle="Build line-item quotes from your product catalog."
          primaryAction={{ label: 'New quote', onClick: () => setBuilding(true) }}
        />

        <div className="space-y-6">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          <DataTable
            columns={columns}
            data={quotes}
            loading={loading}
            rowActions={[{ label: 'PDF', onClick: downloadPdf }]}
            onDelete={remove}
            emptyState={{
              icon: 'briefcase',
              title: 'No quotes yet',
              message: "Hit New quote — pick items from your catalog, set quantities and discounts, and we'll handle the math and the branded PDF.",
              action: <Button icon="plus" onClick={() => setBuilding(true)}>New quote</Button>,
            }}
          />
        </div>
      </Container>

      {building && (
        <BuilderModal
          products={products}
          customers={customers}
          deals={deals}
          onCancel={() => setBuilding(false)}
          onCreated={() => { setBuilding(false); load(); }}
        />
      )}
    </div>
  );
}
