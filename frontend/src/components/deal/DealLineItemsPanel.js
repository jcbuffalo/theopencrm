// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Deal line items (migration 145): products/quantities that sum to the
// deal's amount. Money mirrors the backend exactly — the SERVER computes
// line_total_cents and re-derives deals.amount on every mutation; this panel
// only ever sends the inputs (product_id / description / quantity /
// unit_price in dollars). Deliberately separate from the CPQ sales-quote
// items (migration 120): a quote is a point-in-time offer document, these
// lines are the deal's own composition. A deal with no lines keeps its
// manually-entered amount.
//
// Migration 159: each line is 'revenue' (rolls into the amount) or 'cost'
// (feeds the contribution/margin footer only). Deals with no cost lines
// render exactly as before — the Revenue/Costs grouping and the P&L footer
// only appear once a cost line exists.

import React, { useEffect, useState } from 'react';
import api from '../../api';
import { Button, Input, Select, Skeleton } from '../ui';
import { ActionError, fmtMoney, RemoveButton, rowControlClass, useAsyncAction } from './shared';

export default function DealLineItemsPanel({ dealId, onRollup, onCountChange }) {
  const [items, setItems] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const { run, error } = useAsyncAction();
  const [form, setForm] = useState({ product_id: '', description: '', quantity: '1', unit_price: '', kind: 'revenue', category: '' });
  // In-flight row edits (id → { quantity?, unit_price? }), committed on blur.
  const [drafts, setDrafts] = useState({});

  const load = async () => {
    try {
      const r = await api.get(`/deals/${dealId}/line-items`);
      const rows = r.data?.line_items || [];
      setItems(rows);
      setLoadError('');
      onCountChange?.(rows.length);
    } catch (err) {
      setLoadError(err.response?.data?.error || 'Failed to load line items.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // Catalog is optional (products_enabled may be off) — degrade to free-text lines.
    api.get('/products?active=true')
      .then((r) => setProducts(Array.isArray(r.data) ? r.data : []))
      .catch(() => setProducts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId]);

  // After any mutation: re-pull the lines AND let the parent refresh the deal
  // (the server just re-derived deals.amount inside the same transaction).
  const mutated = async () => { await load(); onRollup?.(); };

  const add = async (e) => {
    e.preventDefault();
    const payload = {
      product_id: form.product_id ? Number(form.product_id) : null,
      quantity: form.quantity !== '' ? Number(form.quantity) : 1,
      kind: form.kind,
    };
    if (form.description.trim()) payload.description = form.description.trim();
    if (form.unit_price !== '') payload.unit_price = Number(form.unit_price);
    if (form.category.trim()) payload.category = form.category.trim();
    const ok = await run(() => api.post(`/deals/${dealId}/line-items`, payload));
    if (ok) {
      setForm({ product_id: '', description: '', quantity: '1', unit_price: '', kind: form.kind, category: '' });
      await mutated();
    }
  };

  // Kind toggle (migration 159): flip a line between revenue and cost — the
  // server re-derives deals.amount from the remaining revenue lines.
  const toggleKind = async (item) => {
    const next = (item.kind || 'revenue') === 'cost' ? 'revenue' : 'cost';
    if (await run(() => api.put(`/deals/${dealId}/line-items/${item.id}`, { kind: next }))) await mutated();
  };

  const commitDraft = async (item) => {
    const d = drafts[item.id];
    setDrafts((prev) => { const next = { ...prev }; delete next[item.id]; return next; });
    if (!d) return;
    const patch = {};
    if (d.quantity !== undefined && d.quantity !== '' && Number(d.quantity) !== Number(item.quantity)) {
      patch.quantity = Number(d.quantity);
    }
    if (d.unit_price !== undefined && d.unit_price !== ''
        && Math.round(Number(d.unit_price) * 100) !== Number(item.unit_price_cents)) {
      patch.unit_price = Number(d.unit_price);
    }
    if (Object.keys(patch).length === 0) return;
    if (await run(() => api.put(`/deals/${dealId}/line-items/${item.id}`, patch))) await mutated();
  };

  const remove = async (id) => {
    if (await run(() => api.delete(`/deals/${dealId}/line-items/${id}`))) await mutated();
  };

  // Picking a catalog product prefills description + unit price (still editable).
  const pickProduct = (id) => {
    const p = products.find((x) => String(x.id) === String(id));
    setForm((f) => ({
      ...f,
      product_id: id,
      description: p ? p.name : f.description,
      unit_price: p != null && p.unit_price != null ? String(p.unit_price) : f.unit_price,
    }));
  };

  // Live P&L in integer cents — same discipline as the backend. Revenue lines
  // are what the deal amount derives from; cost lines feed the contribution
  // footer only (migration 159). Rows with no kind are legacy revenue rows.
  const revenueItems = items.filter((it) => (it.kind || 'revenue') !== 'cost');
  const costItems = items.filter((it) => (it.kind || 'revenue') === 'cost');
  const revenueCents = revenueItems.reduce((s, it) => s + (Number(it.line_total_cents) || 0), 0);
  const costCents = costItems.reduce((s, it) => s + (Number(it.line_total_cents) || 0), 0);
  const hasCosts = costItems.length > 0;
  const contributionCents = revenueCents - costCents;
  const marginPct = revenueCents > 0 ? Math.round((contributionCents / revenueCents) * 1000) / 10 : null;

  if (loading) return <Skeleton lines={3} />;
  if (loadError) return <ActionError error={loadError} className="" />;

  const renderRow = (it) => {
    const d = drafts[it.id] || {};
    const isCost = (it.kind || 'revenue') === 'cost';
    return (
      <tr key={it.id} className="border-t border-gray-100 align-middle">
        <td className="py-1 pr-2 text-gray-900">
          {it.description}
          {it.product_name && it.product_name !== it.description && (
            <span className="ml-1 text-[10px] text-gray-400">({it.product_name})</span>
          )}
          {it.category && (
            <span className="ml-1 text-[10px] text-gray-400">· {it.category}</span>
          )}
          <button type="button" onClick={() => toggleKind(it)}
            aria-label={isCost ? 'Make this a revenue line' : 'Make this a cost line'}
            title={isCost ? 'Reclassify as revenue' : 'Reclassify as cost'}
            className={`ml-1.5 rounded px-1 py-0.5 text-[10px] font-medium leading-none ${isCost
              ? 'bg-warning-50 text-warning-700 hover:bg-warning-100'
              : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
            {isCost ? 'cost' : 'rev'}
          </button>
        </td>
        <td className="px-1 py-1">
          <input type="number" min="0" step="any" aria-label="Quantity"
            value={d.quantity !== undefined ? d.quantity : Number(it.quantity)}
            onChange={(e) => setDrafts((prev) => ({ ...prev, [it.id]: { ...prev[it.id], quantity: e.target.value } }))}
            onBlur={() => commitDraft(it)}
            className={`w-full ${rowControlClass}`} />
        </td>
        <td className="px-1 py-1">
          <input type="number" min="0" step="0.01" aria-label="Unit price"
            value={d.unit_price !== undefined ? d.unit_price : (Number(it.unit_price_cents) / 100)}
            onChange={(e) => setDrafts((prev) => ({ ...prev, [it.id]: { ...prev[it.id], unit_price: e.target.value } }))}
            onBlur={() => commitDraft(it)}
            className={`w-full ${rowControlClass}`} />
        </td>
        <td className={`py-1 pl-1 text-right font-medium ${isCost ? 'text-warning-700' : 'text-gray-900'}`}>
          {isCost ? '−' : ''}{fmtMoney(Number(it.line_total_cents) / 100)}
        </td>
        <td className="text-right">
          <RemoveButton label="Remove line item" onClick={() => remove(it.id)} />
        </td>
      </tr>
    );
  };

  const groupHeader = (label) => (
    <tr className="border-t border-gray-100">
      <td colSpan={5} className="pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">{label}</td>
    </tr>
  );

  return (
    <div>
      <ActionError error={error} className="mb-2" />
      {items.length === 0 ? (
        <p className="mb-2 text-xs text-gray-500">
          No line items — the deal keeps its manually-entered amount. Add lines below to derive the amount from products/quantities instead.
        </p>
      ) : (
        <div className="mb-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-gray-500">
                <th className="py-1 pr-2 font-medium">Item</th>
                <th className="w-16 px-1 py-1 font-medium">Qty</th>
                <th className="w-24 px-1 py-1 font-medium">Unit $</th>
                <th className="w-20 py-1 pl-1 text-right font-medium">Total</th>
                <th className="w-6" />
              </tr>
            </thead>
            <tbody>
              {hasCosts ? (
                <>
                  {revenueItems.length > 0 && groupHeader('Revenue')}
                  {revenueItems.map(renderRow)}
                  {groupHeader('Costs')}
                  {costItems.map(renderRow)}
                </>
              ) : (
                items.map(renderRow)
              )}
            </tbody>
            <tfoot>
              {hasCosts ? (
                <>
                  <tr className="border-t border-gray-200">
                    <td colSpan={3} className="py-1 pr-2 text-right text-gray-500">
                      {revenueItems.length > 0 ? 'Revenue (= deal amount)' : 'Revenue'}
                    </td>
                    <td className="py-1 pl-1 text-right font-semibold text-gray-900">{fmtMoney(revenueCents / 100)}</td>
                    <td />
                  </tr>
                  <tr>
                    <td colSpan={3} className="py-1 pr-2 text-right text-gray-500">Costs</td>
                    <td className="py-1 pl-1 text-right font-semibold text-warning-700">−{fmtMoney(costCents / 100)}</td>
                    <td />
                  </tr>
                  <tr className="border-t border-gray-200">
                    <td colSpan={3} className="py-1 pr-2 text-right font-medium text-gray-600">
                      Contribution{marginPct != null ? ` · ${marginPct}% margin` : ''}
                    </td>
                    <td className={`py-1 pl-1 text-right font-semibold ${contributionCents < 0 ? 'text-danger-700' : 'text-success-700'}`}>
                      {fmtMoney(contributionCents / 100)}
                    </td>
                    <td />
                  </tr>
                </>
              ) : (
                <tr className="border-t border-gray-200">
                  <td colSpan={3} className="py-1 pr-2 text-right text-gray-500">Subtotal (= deal amount)</td>
                  <td className="py-1 pl-1 text-right font-semibold text-gray-900">{fmtMoney(revenueCents / 100)}</td>
                  <td />
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      )}

      <form onSubmit={add} className="space-y-2 border-t border-gray-100 pt-2">
        {products.length > 0 && (
          <Select size="sm" value={form.product_id} onChange={(e) => pickProduct(e.target.value)} aria-label="Catalog product">
            <option value="">Free-text line (no catalog product)</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.unit_price != null ? ` — ${fmtMoney(p.unit_price)}` : ''}</option>
            ))}
          </Select>
        )}
        <Input size="sm" placeholder="Description" aria-label="Description" value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <div className="grid grid-cols-3 gap-2">
          <Input size="sm" type="number" min="0" step="any" placeholder="Qty" value={form.quantity} aria-label="Quantity"
            onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
          <Input size="sm" type="number" min="0" step="0.01" placeholder="Unit price" value={form.unit_price} aria-label="Unit price"
            onChange={(e) => setForm({ ...form, unit_price: e.target.value })} />
          {/* Revenue rolls into the deal amount; costs only feed the margin footer. */}
          <Select size="sm" value={form.kind} aria-label="Line kind"
            onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="revenue">Revenue line</option>
            <option value="cost">Cost line</option>
          </Select>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2">
            {form.kind === 'cost' && (
              <Input size="sm" placeholder="Cost category (optional — e.g. production, install)" aria-label="Category"
                value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            )}
          </div>
          <Button size="sm" type="submit" icon="plus">Add line</Button>
        </div>
      </form>
    </div>
  );
}
