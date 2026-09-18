// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useMemo, useState } from 'react';
import Nav from '../components/Nav';
import DataTable from '../components/DataTable';
import api, { downloadBlob } from '../api';
import {
  Alert, Button, Card, Container, Drawer, Icon, Input, Modal, PageHeader, Select, Spinner, StatusBadge, Textarea, controlClasses,
} from '../components/ui';

function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  return `$${Number(n).toLocaleString()}`;
}

const STATUSES = ['draft', 'sent', 'revised', 'accepted', 'rejected', 'expired'];
const STATUS_TONE = { draft: 'neutral', sent: 'info', revised: 'info', accepted: 'success', rejected: 'error', expired: 'warning' };

// Compact native control for inline line-item cells — the primitives' 40px
// minimum would double the row height in the line-item grids.
const CELL = controlClasses({ size: 'sm', className: 'text-sm' });
const CELL_RIGHT = controlClasses({ size: 'sm', className: 'text-sm text-right' });

// Customer's response recorded from their portal link (migration 149) —
// separate from the internal status lifecycle, which stays a team decision.
function PortalResponseChip({ response }) {
  if (!response) return null;
  const approved = response === 'approved';
  return (
    <StatusBadge
      tone={approved ? 'success' : 'warning'}
      label={approved ? <><Icon name="check" size={12} /> customer approved</> : 'changes requested'}
      className="ml-1"
    />
  );
}

// --- Three-step wizard for creating a new quote. Replaces the single-screen
// modal so users don't face a wall of fields at once. Each step has its own
// validation gate and the running subtotal is visible on every step.
//
//   Step 1: Pick customer (and optionally link to a deal)
//   Step 2: Add line items + running subtotal
//   Step 3: Review (totals, terms, send / save options)
//
// Submits to POST /quotes — same endpoint as before, with optional
// line_items[]. Backend already accepts the line_items field (see
// backend/routes/quoteRoutes.js).
function NewQuoteWizard({ customers, deals, onCancel, onCreated }) {
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    title: '',
    customer_id: '',
    deal_id: '',
    valid_until: '',
    notes: '',
    status: 'draft',
  });
  const [items, setItems] = useState([
    { description: '', quantity: 1, unit_price: '', markup_pct: '' },
  ]);

  const subtotal = items.reduce((s, li) => {
    const qty   = Number(li.quantity)    || 0;
    const unit  = Number(li.unit_price)  || 0;
    const mark  = Number(li.markup_pct)  || 0;
    return s + qty * unit * (1 + mark / 100);
  }, 0);

  const customer = customers.find(c => String(c.id) === String(form.customer_id));
  const deal     = deals.find(d => String(d.id) === String(form.deal_id));

  // Step gates — keep "Next" disabled until the minimum required fields are
  // filled. The user can still click prior step pills to jump back.
  const canAdvanceFrom1 = !!form.title.trim() && !!form.customer_id;
  const canAdvanceFrom2 = items.some(li => li.description?.trim()); // at least one line

  const updateItem = (idx, patch) =>
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, ...patch } : it));
  const addItem = () =>
    setItems(prev => [...prev, { description: '', quantity: 1, unit_price: '', markup_pct: '' }]);
  const removeItem = (idx) =>
    setItems(prev => prev.length === 1 ? prev : prev.filter((_, i) => i !== idx));

  const submit = async () => {
    setSubmitting(true);
    setError('');
    try {
      const cleanItems = items
        .filter(li => li.description?.trim())
        .map(li => ({
          description: li.description.trim(),
          quantity:    Number(li.quantity)   || 1,
          unit_price:  li.unit_price === '' ? null : Number(li.unit_price),
          markup_pct:  li.markup_pct === '' ? null : Number(li.markup_pct),
        }));
      await api.post('/quotes', {
        title: form.title.trim(),
        customer_id: form.customer_id || null,
        deal_id:     form.deal_id     || null,
        status:      form.status,
        total_amount: subtotal || null,
        valid_until: form.valid_until || null,
        notes:       form.notes || null,
        line_items:  cleanItems,
      });
      onCreated();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to create quote');
    } finally {
      setSubmitting(false);
    }
  };

  // Single source of truth for the step pills at the top of the modal.
  const STEPS = [
    { n: 1, label: 'Customer' },
    { n: 2, label: 'Line items' },
    { n: 3, label: 'Review' },
  ];

  const footer = (
    <div className="flex w-full items-center justify-between gap-3 flex-wrap">
      <div>
        {step > 1 && (
          <Button variant="secondary" icon="arrow-left" onClick={() => setStep(step - 1)} disabled={submitting}>Back</Button>
        )}
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        {/* Persistent subtotal in footer once we have line items. */}
        {step >= 2 && (
          <span className="text-xs text-gray-500">Subtotal <span className="font-semibold text-gray-900">{fmtMoney(subtotal)}</span></span>
        )}
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>Cancel</Button>
        {step < 3 ? (
          <Button
            iconRight="arrow-right"
            onClick={() => setStep(step + 1)}
            disabled={(step === 1 && !canAdvanceFrom1) || (step === 2 && !canAdvanceFrom2)}
          >
            Next
          </Button>
        ) : (
          <Button onClick={submit} loading={submitting} loadingLabel="Creating…">
            {form.status === 'sent' ? 'Create & mark sent' : 'Create draft'}
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <Modal open onClose={onCancel} title="New quote" size="lg" footer={footer}>
      {/* Progress pills */}
      <div className="flex items-center gap-2 mb-5">
        {STEPS.map((s, i) => {
          const isActive = step === s.n;
          const isDone   = step > s.n;
          // Users can click backward to revisit a prior step; clicking
          // forward is gated on validation so we keep them honest.
          const canClick = isDone
            || (s.n === 2 && canAdvanceFrom1)
            || (s.n === 3 && canAdvanceFrom1 && canAdvanceFrom2);
          return (
            <React.Fragment key={s.n}>
              <button
                type="button"
                onClick={() => canClick && setStep(s.n)}
                disabled={!canClick}
                aria-current={isActive ? 'step' : undefined}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  isActive ? 'bg-brand-blue text-white' :
                  isDone   ? 'bg-success-100 text-success-700 hover:bg-success-200' :
                             'bg-gray-100 text-gray-500'
                } ${canClick ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
              >
                <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-[10px] font-bold">
                  {isDone ? <Icon name="check" size={12} /> : s.n}
                </span>
                {s.label}
              </button>
              {i < STEPS.length - 1 && <div className={`flex-1 h-px ${step > s.n ? 'bg-success-300' : 'bg-gray-200'}`} />}
            </React.Fragment>
          );
        })}
      </div>

      {error && <Alert tone="danger" className="mb-4" onDismiss={() => setError('')}>{error}</Alert>}

      {step === 1 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">Tell us who this quote is for. Linking to a deal is optional but it ties the quote into the pipeline view.</p>
          <Input
            label="Quote title"
            required
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="e.g. Acme Q3 expansion proposal"
            autoFocus
          />
          <Select label="Customer" required value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value })}>
            <option value="">Select customer…</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select
            label="Link to deal (optional)"
            value={form.deal_id}
            onChange={(e) => setForm({ ...form, deal_id: e.target.value })}
            hint="A linked deal shows this quote in the Deals workflow tab."
          >
            <option value="">None — standalone quote</option>
            {deals.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
          </Select>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">Add what you're selling. Each line totals as <code className="text-[11px]">qty × unit × (1 + markup%)</code>. The running subtotal updates below.</p>
          <div className="border border-gray-200 rounded overflow-x-auto">
            <table className="w-full text-sm min-w-[520px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-2 py-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Description</th>
                  <th className="text-right px-2 py-2 text-xs font-semibold uppercase tracking-wider text-gray-500 w-16">Qty</th>
                  <th className="text-right px-2 py-2 text-xs font-semibold uppercase tracking-wider text-gray-500 w-24">Unit $</th>
                  <th className="text-right px-2 py-2 text-xs font-semibold uppercase tracking-wider text-gray-500 w-20">Markup %</th>
                  <th className="text-right px-2 py-2 text-xs font-semibold uppercase tracking-wider text-gray-500 w-24">Line total</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {items.map((li, i) => {
                  const lineTotal = (Number(li.quantity || 1) * Number(li.unit_price || 0)) * (1 + Number(li.markup_pct || 0) / 100);
                  return (
                    <tr key={i} className="border-t border-gray-100">
                      <td className="px-2 py-1.5">
                        <input type="text" value={li.description} aria-label={`Line ${i + 1} description`}
                          onChange={(e) => updateItem(i, { description: e.target.value })}
                          className={CELL} placeholder="Line description" />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" min="0" value={li.quantity} aria-label={`Line ${i + 1} quantity`}
                          onChange={(e) => updateItem(i, { quantity: e.target.value })} className={CELL_RIGHT} />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" min="0" step="0.01" value={li.unit_price} aria-label={`Line ${i + 1} unit price`}
                          onChange={(e) => updateItem(i, { unit_price: e.target.value })} className={CELL_RIGHT} />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" min="0" step="0.01" value={li.markup_pct} aria-label={`Line ${i + 1} markup`}
                          onChange={(e) => updateItem(i, { markup_pct: e.target.value })} className={CELL_RIGHT} />
                      </td>
                      <td className="px-2 py-1.5 text-right font-medium text-gray-900">{fmtMoney(lineTotal)}</td>
                      <td className="px-1 py-1.5 text-right">
                        <button type="button" onClick={() => removeItem(i)} disabled={items.length === 1} aria-label="Remove line"
                          className="rounded-md p-1 text-gray-400 hover:text-danger-600 hover:bg-danger-50 disabled:opacity-30 disabled:cursor-not-allowed">
                          <Icon name="x" size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Button variant="ghost" size="sm" icon="plus" onClick={addItem}>Add line item</Button>

          {/* Running subtotal — always visible on step 2. */}
          <div className="bg-gray-50 border border-gray-200 rounded px-4 py-3 flex items-baseline justify-between">
            <span className="text-xs uppercase font-semibold text-gray-500">Running subtotal</span>
            <span className="text-2xl font-semibold tracking-tight text-gray-900">{fmtMoney(subtotal)}</span>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">Final review. Add terms below, choose whether to save as a draft or mark it as sent.</p>

          <div className="bg-gray-50 border border-gray-200 rounded p-4 space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-gray-500">Title</span><span className="font-medium text-gray-900">{form.title || '—'}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Customer</span><span className="font-medium text-gray-900">{customer?.name || '—'}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Deal</span><span className="font-medium text-gray-900">{deal?.title || 'Standalone'}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Line items</span><span className="font-medium text-gray-900">{items.filter(li => li.description?.trim()).length}</span></div>
            <div className="flex justify-between border-t border-gray-300 pt-2 mt-2">
              <span className="text-gray-700 font-semibold uppercase text-xs">Total</span>
              <span className="font-semibold text-lg text-gray-900">{fmtMoney(subtotal)}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input label="Valid until" type="date" value={form.valid_until} onChange={(e) => setForm({ ...form, valid_until: e.target.value })} />
            <Select label="Save as" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="draft">Draft (default)</option>
              <option value="sent">Sent</option>
            </Select>
          </div>

          <Textarea
            label="Terms / notes"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            rows={3}
            placeholder="Payment terms, warranty notes, or anything else you'd like on the PDF."
          />
        </div>
      )}
    </Modal>
  );
}

function QuoteDetailPanel({ quoteId, customers, vendors, onClose, onChanged }) {
  const [quote, setQuote] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [items, setItems] = useState([]);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const r = await api.get(`/quotes/${quoteId}`);
    setQuote(r.data);
    setForm(r.data);
    setItems(r.data.line_items || []);
  };

  useEffect(() => { load(); }, [quoteId]);

  const total = items.reduce((s, li) => s + (Number(li.quantity || 1) * Number(li.unit_price || 0) * (1 + Number(li.markup_pct || 0) / 100)), 0);

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/quotes/${quoteId}`, {
        ...form,
        total_amount: total || form.total_amount,
        create_revision: true,
      });
      setEditing(false);
      load();
      onChanged?.();
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete this quote?')) return;
    await api.delete(`/quotes/${quoteId}`);
    onChanged?.();
    onClose();
  };

  const downloadPdf = () => {
    const filename = `${(quote.title || 'quote').replace(/[^a-zA-Z0-9._-]/g, '_')}-r${quote.current_revision || 1}.pdf`;
    downloadBlob(`/quotes/${quoteId}/pdf`, filename)
      .catch(() => alert('Failed to generate PDF'));
  };

  if (!quote) {
    return (
      <Drawer open onClose={onClose} title="Quote" size="lg">
        <Spinner size="lg" label="Loading quote…" />
      </Drawer>
    );
  }

  const footer = editing ? (
    <div className="flex w-full items-center justify-between gap-2">
      <Button variant="ghost" size="sm" icon="trash" className="text-danger-600" onClick={remove}>Delete quote</Button>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => { setEditing(false); load(); }}>Cancel</Button>
        <Button onClick={save} loading={saving} loadingLabel="Saving…">Save (new revision)</Button>
      </div>
    </div>
  ) : (
    <>
      <Button variant="secondary" icon="edit" onClick={() => setEditing(true)}>Edit</Button>
      <Button icon="download" onClick={downloadPdf}>Download PDF</Button>
    </>
  );

  return (
    <Drawer
      open
      onClose={onClose}
      title={quote.title}
      description={`Quote · Rev ${quote.current_revision}`}
      size="lg"
      footer={footer}
    >
      <div className="space-y-6">
        {editing ? (
          <div className="space-y-3">
            <Input label="Title" value={form.title || ''} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <div className="grid grid-cols-2 gap-3">
              <Select label="Customer" value={form.customer_id || ''} onChange={(e) => setForm({ ...form, customer_id: e.target.value || null })}>
                <option value="">No customer</option>
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
              <Select label="Status" value={form.status || 'draft'} onChange={(e) => setForm({ ...form, status: e.target.value })} options={STATUSES} />
            </div>
            <Input label="Valid until" type="date" value={form.valid_until || ''} onChange={(e) => setForm({ ...form, valid_until: e.target.value })} />
            <Textarea label="Notes" value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
          </div>
        ) : (
          <dl className="text-sm space-y-1.5">
            <div className="flex"><dt className="w-28 text-gray-500">Customer</dt><dd className="text-gray-900">{quote.customer_name || '—'}</dd></div>
            <div className="flex"><dt className="w-28 text-gray-500">Deal</dt><dd className="text-gray-900">{quote.deal_title || '—'}</dd></div>
            <div className="flex items-center"><dt className="w-28 text-gray-500">Status</dt><dd><StatusBadge tone={STATUS_TONE[quote.status] || 'neutral'} label={quote.status} className="capitalize" /></dd></div>
            <div className="flex"><dt className="w-28 text-gray-500">Total</dt><dd className="text-gray-900 font-semibold">{fmtMoney(quote.total_amount)}</dd></div>
            <div className="flex"><dt className="w-28 text-gray-500">Valid until</dt><dd className="text-gray-900">{quote.valid_until || '—'}</dd></div>
            {quote.portal_response && (
              <div className="flex">
                <dt className="w-28 text-gray-500">Customer</dt>
                <dd className={quote.portal_response === 'approved' ? 'text-success-700 font-medium' : 'text-warning-700 font-medium'}>
                  {quote.portal_response === 'approved' ? 'Approved via portal' : 'Requested changes via portal'}
                  {quote.portal_response_at && <span className="text-gray-500 font-normal"> · {new Date(quote.portal_response_at).toLocaleDateString()}</span>}
                  {quote.portal_response_note && <div className="text-gray-700 font-normal mt-0.5">“{quote.portal_response_note}”</div>}
                </dd>
              </div>
            )}
            {quote.notes && <div className="pt-1 text-gray-700">{quote.notes}</div>}
          </dl>
        )}

        <div>
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Line items</h3>
          {items.length === 0 ? (
            <p className="text-xs text-gray-500">No line items.</p>
          ) : (
            <div className="border border-gray-200 rounded overflow-x-auto">
              <table className="w-full text-xs min-w-[480px]">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Description</th>
                    <th className="text-left px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Vendor</th>
                    <th className="text-right px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Qty</th>
                    <th className="text-right px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Unit</th>
                    <th className="text-right px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Markup</th>
                    <th className="text-right px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((li, i) => {
                    const lineTotal = (Number(li.quantity || 1) * Number(li.unit_price || 0)) * (1 + Number(li.markup_pct || 0) / 100);
                    return (
                      <tr key={li.id || i} className="border-t border-gray-100">
                        <td className="px-2 py-1.5">{li.description}</td>
                        <td className="px-2 py-1.5 text-gray-500">{li.vendor_name || '—'}</td>
                        <td className="text-right px-2 py-1.5">{li.quantity || 1}</td>
                        <td className="text-right px-2 py-1.5">{fmtMoney(li.unit_price)}</td>
                        <td className="text-right px-2 py-1.5">{li.markup_pct ? `${li.markup_pct}%` : '—'}</td>
                        <td className="text-right px-2 py-1.5 font-medium">{fmtMoney(lineTotal)}</td>
                      </tr>
                    );
                  })}
                  <tr className="border-t-2 border-gray-300 bg-gray-50">
                    <td colSpan={5} className="px-2 py-1.5 text-right font-medium">Total</td>
                    <td className="text-right px-2 py-1.5 font-semibold">{fmtMoney(total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Revisions</h3>
          {(quote.revisions || []).length === 0 ? (
            <p className="text-xs text-gray-500">No revisions yet.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {(quote.revisions || []).map(r => (
                <li key={r.id} className="flex items-center justify-between border border-gray-200 rounded px-2.5 py-1.5">
                  <span><strong>Rev {r.revision_number}</strong> — {fmtMoney(r.total_amount)}</span>
                  <span className="text-gray-500">{new Date(r.created_at).toLocaleDateString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Drawer>
  );
}

export default function Quotes() {
  const [quotes, setQuotes] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState({ search: '', status: '' });

  const load = async () => {
    try {
      setLoading(true);
      const [q, c, d] = await Promise.all([api.get('/quotes'), api.get('/companies'), api.get('/deals')]);
      setQuotes(q.data);
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

  // Client-side search + status filter — same pattern as Companies/Contacts.
  // All record fields are guarded with (x || '') so null titles/names never
  // crash the filter.
  const filteredQuotes = useMemo(() => {
    const s = (filter.search || '').toLowerCase();
    return quotes.filter(q => {
      if (filter.status && q.status !== filter.status) return false;
      if (s) {
        const hit = (q.title || '').toLowerCase().includes(s)
          || (q.customer_name || '').toLowerCase().includes(s)
          || (q.deal_title || '').toLowerCase().includes(s);
        if (!hit) return false;
      }
      return true;
    });
  }, [quotes, filter]);

  const columns = [
    {
      key: 'title',
      label: 'Title',
      render: (q) => (
        <button type="button" onClick={() => setSelected(q.id)} className="text-left font-medium text-gray-900 hover:text-brand-blue hover:underline">
          {q.title}
        </button>
      ),
    },
    { key: 'customer_name', label: 'Customer', render: (q) => q.customer_name || '—' },
    { key: 'deal_title', label: 'Deal', render: (q) => <span className="text-xs text-gray-500">{q.deal_title || '—'}</span> },
    { key: 'total_amount', label: 'Total', align: 'right', render: (q) => <span className="font-medium">{fmtMoney(q.total_amount)}</span> },
    { key: 'current_revision', label: 'Rev', render: (q) => `v${q.current_revision}` },
    {
      key: 'status',
      label: 'Status',
      render: (q) => (
        <span className="inline-flex items-center gap-1 flex-wrap">
          <StatusBadge tone={STATUS_TONE[q.status] || 'neutral'} label={q.status} className="capitalize" />
          <PortalResponseChip response={q.portal_response} />
        </span>
      ),
    },
    { key: 'valid_until', label: 'Valid until', render: (q) => <span className="text-xs">{q.valid_until || '—'}</span> },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="quotes" />
      <Container size="wide">
        <PageHeader
          title="Quotes"
          subtitle="Customer quotes with revision history and PDF export."
          primaryAction={{ label: 'New quote', onClick: () => setAdding(true) }}
        />

        <div className="space-y-6">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          <Card padding="sm">
            <div className="flex flex-wrap gap-2">
              <Input
                leadingIcon="search"
                placeholder="Search quotes…"
                aria-label="Search quotes"
                value={filter.search}
                onChange={(e) => setFilter(prev => ({ ...prev, search: e.target.value }))}
                wrapperClassName="flex-1 min-w-[200px]"
              />
              <Select
                value={filter.status}
                onChange={(e) => setFilter(prev => ({ ...prev, status: e.target.value }))}
                aria-label="Filter quotes by status"
                wrapperClassName="w-40"
              >
                <option value="">Any status</option>
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </Select>
            </div>
          </Card>

          <DataTable
            columns={columns}
            data={filteredQuotes}
            loading={loading}
            rowActions={[{ label: 'Open', onClick: (q) => setSelected(q.id) }]}
            emptyState={{
              icon: 'briefcase',
              title: 'No quotes yet',
              message: 'Create a quote to start tracking pricing and revisions for a customer.',
              action: <Button icon="plus" onClick={() => setAdding(true)}>New quote</Button>,
            }}
          />
        </div>
      </Container>

      {adding && (
        <NewQuoteWizard
          customers={customers}
          deals={deals}
          onCancel={() => setAdding(false)}
          onCreated={() => { setAdding(false); load(); }}
        />
      )}

      {selected && (
        <QuoteDetailPanel
          quoteId={selected}
          customers={customers}
          vendors={companies.filter(c => c.type === 'vendor')}
          onClose={() => setSelected(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
