// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Sub-record panels for the Workflow tab: issues, customer quotes,
// submittals, change orders, delivery checklist. Vendor RFQs live in
// ./vendorQuotes.js. Each panel owns its own fetch so it can mount lazily.

import React, { useEffect, useState } from 'react';
import api from '../../api';
import { urgencyColor } from '../../stages';
import { Button, Input, Select, Skeleton, StatusBadge } from '../ui';
import { ActionError, fmtMoney, LinkButton, RemoveButton, rowControlClass, useAsyncAction } from './shared';

// -- Quick read-only list of customer quotes attached to this deal. Full
// editing happens on the Quotes page.
export function QuotesQuickList({ dealId }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let alive = true;
    setLoadError('');
    api.get(`/quotes?deal_id=${dealId}`)
      .then((r) => { if (alive) setList(r.data); })
      .catch((err) => { if (alive) setLoadError(err.response?.data?.error || 'Failed to load quotes.'); })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [dealId]);

  if (loading) return <Skeleton lines={2} />;
  if (loadError) return <ActionError error={loadError} className="" />;
  if (list.length === 0) {
    return (
      <div>
        <p className="mb-2 text-xs text-gray-500">No customer quotes yet.</p>
        <a href="/quotes" className="text-xs font-medium text-brand-blue hover:underline">Create one in the Quotes module</a>
      </div>
    );
  }
  return (
    <div>
      <ul className="mb-2 space-y-1.5">
        {list.map((q) => (
          <li key={q.id} className="flex items-center justify-between rounded border border-gray-200 px-2 py-1.5 text-xs">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-gray-900">{q.title}</div>
              <div className="text-gray-500">Rev {q.current_revision} · {q.status}</div>
            </div>
            <div className="text-right">
              <div className="font-semibold text-gray-900">{fmtMoney(q.total_amount)}</div>
              {q.valid_until && <div className="text-[10px] text-gray-500">valid {q.valid_until}</div>}
            </div>
          </li>
        ))}
      </ul>
      <a href="/quotes" className="text-xs font-medium text-brand-blue hover:underline">Open Quotes module</a>
    </div>
  );
}

export function SubmittalsPanel({ dealId }) {
  const [list, setList] = useState([]);
  const [loadError, setLoadError] = useState('');
  const { run, error } = useAsyncAction();

  const load = async () => {
    try {
      const r = await api.get(`/submittals?deal_id=${dealId}`); setList(r.data); setLoadError('');
    } catch (err) { setLoadError(err.response?.data?.error || 'Failed to load submittals.'); }
  };
  useEffect(() => { load(); }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    const type = window.prompt('Submittal type (drawing, spec, sample):', 'drawing');
    if (!type) return;
    if (await run(() => api.post('/submittals', { deal_id: dealId, type }))) load();
  };
  const updateStatus = async (id, status) => {
    if (await run(() => api.put(`/submittals/${id}`, { status }))) load();
  };
  const remove = async (id) => {
    if (!window.confirm('Delete this submittal?')) return;
    if (await run(() => api.delete(`/submittals/${id}`))) load();
  };

  return (
    <div>
      <ActionError error={loadError || error} className="mb-2" />
      {list.length === 0 ? (
        <p className="mb-2 text-xs text-gray-500">No submittals yet.</p>
      ) : (
        <ul className="mb-2 space-y-1.5">
          {list.map((s) => (
            <li key={s.id} className="flex items-center justify-between rounded border border-gray-200 px-2 py-1.5 text-xs">
              <div>
                <span className="font-medium">v{s.version}</span>
                <span className="ml-2 text-gray-500">{s.type}</span>
              </div>
              <div className="flex items-center gap-2">
                <select value={s.status} onChange={(e) => updateStatus(s.id, e.target.value)}
                  aria-label={`Status for submittal v${s.version}`} className={rowControlClass}>
                  <option value="pending_vendor">Pending Vendor</option>
                  <option value="pending_customer">Pending Customer</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                </select>
                <RemoveButton label="Delete submittal" onClick={() => remove(s.id)} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <Button size="sm" variant="ghost" icon="plus" onClick={create}>New submittal version</Button>
    </div>
  );
}

export function ChangeOrdersPanel({ dealId }) {
  const [list, setList] = useState([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ description: '', amount_delta: '' });
  const [loadError, setLoadError] = useState('');
  const { run, error } = useAsyncAction();

  const load = async () => {
    try {
      const r = await api.get(`/change-orders?deal_id=${dealId}`); setList(r.data); setLoadError('');
    } catch (err) { setLoadError(err.response?.data?.error || 'Failed to load change orders.'); }
  };
  useEffect(() => { load(); }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async (e) => {
    e.preventDefault();
    if (!form.description) return;
    const ok = await run(() => api.post('/change-orders', {
      deal_id: dealId, description: form.description,
      amount_delta: form.amount_delta ? Number(form.amount_delta) : null,
    }));
    if (!ok) return;
    setForm({ description: '', amount_delta: '' });
    setAdding(false);
    load();
  };
  const updateStatus = async (id, status) => { if (await run(() => api.put(`/change-orders/${id}`, { status }))) load(); };
  const remove = async (id) => { if (window.confirm('Delete this change order?')) { if (await run(() => api.delete(`/change-orders/${id}`))) load(); } };

  return (
    <div>
      <ActionError error={loadError || error} className="mb-2" />
      {list.length === 0 ? (
        <p className="mb-2 text-xs text-gray-500">No change orders.</p>
      ) : (
        <ul className="mb-2 space-y-1.5">
          {list.map((co) => (
            <li key={co.id} className="flex items-center justify-between rounded border border-gray-200 px-2 py-1.5 text-xs">
              <div className="min-w-0 flex-1">
                <span className="font-medium">CO #{co.number}</span>
                <span className="ml-2 truncate text-gray-700">{co.description}</span>
                {co.amount_delta && (
                  <span className={`ml-2 font-medium ${Number(co.amount_delta) >= 0 ? 'text-success-700' : 'text-danger-600'}`}>
                    {fmtMoney(co.amount_delta)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <select value={co.status} onChange={(e) => updateStatus(co.id, e.target.value)}
                  aria-label={`Status for CO #${co.number}`} className={rowControlClass}>
                  <option value="pending">Pending</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                </select>
                <RemoveButton label="Delete change order" onClick={() => remove(co.id)} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <form onSubmit={create} className="space-y-2 rounded bg-gray-50 p-3">
          <Input size="sm" placeholder="Description" aria-label="Description" value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })} required />
          <Input size="sm" type="number" placeholder="Amount delta (+/-)" aria-label="Amount delta" value={form.amount_delta}
            onChange={(e) => setForm({ ...form, amount_delta: e.target.value })} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" type="submit">Add</Button>
          </div>
        </form>
      ) : (
        <Button size="sm" variant="ghost" icon="plus" onClick={() => setAdding(true)}>Change order</Button>
      )}
    </div>
  );
}

export function IssuesPanel({ dealId }) {
  const [list, setList] = useState([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: '', urgency: 'green', category: 'logistics', blocks_workflow: false });
  const [loadError, setLoadError] = useState('');
  const { run, error } = useAsyncAction();

  const load = async () => {
    try {
      const r = await api.get(`/issues?related_type=deal&related_id=${dealId}`); setList(r.data); setLoadError('');
    } catch (err) { setLoadError(err.response?.data?.error || 'Failed to load issues.'); }
  };
  useEffect(() => { load(); }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async (e) => {
    e.preventDefault();
    const ok = await run(() => api.post('/issues', { ...form, related_type: 'deal', related_id: dealId }));
    if (!ok) return;
    setForm({ title: '', urgency: 'green', category: 'logistics', blocks_workflow: false });
    setAdding(false);
    load();
  };
  const resolve = async (id) => { if (await run(() => api.put(`/issues/${id}`, { status: 'resolved' }))) load(); };
  const remove = async (id) => { if (window.confirm('Delete issue?')) { if (await run(() => api.delete(`/issues/${id}`))) load(); } };

  return (
    <div>
      <ActionError error={loadError || error} className="mb-2" />
      {list.length === 0 ? (
        <p className="mb-2 text-xs text-gray-500">No issues.</p>
      ) : (
        <ul className="mb-2 space-y-1.5">
          {list.map((i) => (
            <li key={i.id} className="flex items-center justify-between rounded border border-gray-200 px-2 py-1.5 text-xs">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className={`rounded border px-1.5 py-0.5 text-[10px] ${urgencyColor(i.urgency)}`}>{i.urgency.toUpperCase()}</span>
                <span className={`truncate ${i.status === 'resolved' ? 'text-gray-400 line-through' : 'text-gray-900'}`}>{i.title}</span>
                {i.blocks_workflow && <StatusBadge tone="error" label="Blocking" />}
              </div>
              <div className="flex items-center gap-2">
                {i.status === 'open' && <LinkButton tone="success" onClick={() => resolve(i.id)}>Resolve</LinkButton>}
                <RemoveButton label="Delete issue" onClick={() => remove(i.id)} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <form onSubmit={create} className="space-y-2 rounded bg-gray-50 p-3">
          <Input size="sm" placeholder="Issue title" aria-label="Issue title" value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })} required />
          <div className="grid grid-cols-2 gap-2">
            <Select size="sm" aria-label="Urgency" value={form.urgency} onChange={(e) => setForm({ ...form, urgency: e.target.value })}>
              <option value="green">Green</option>
              <option value="yellow">Yellow</option>
              <option value="red">Red</option>
            </Select>
            <Select size="sm" aria-label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              <option value="logistics">Logistics</option>
              <option value="technical">Technical</option>
              <option value="financial">Financial</option>
              <option value="other">Other</option>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-800">
            <input type="checkbox" checked={form.blocks_workflow} onChange={(e) => setForm({ ...form, blocks_workflow: e.target.checked })} />
            Blocks workflow
          </label>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" type="submit">Add</Button>
          </div>
        </form>
      ) : (
        <Button size="sm" variant="ghost" icon="plus" onClick={() => setAdding(true)}>Log issue</Button>
      )}
    </div>
  );
}

// -- Delivery checklist: editable JSONB on deal.delivery_checklist.
const DEFAULT_CHECKLIST = [
  { id: 1, label: 'Confirm ship-to address', done: false },
  { id: 2, label: 'Confirm POC name + phone', done: false },
  { id: 3, label: 'Verify delivery equipment needed', done: false },
  { id: 4, label: 'Storage instructions captured', done: false },
  { id: 5, label: 'Carrier scheduled', done: false },
  { id: 6, label: 'BOL collected from vendor', done: false },
  { id: 7, label: 'Packing list collected', done: false },
  { id: 8, label: 'Closeout docs collected', done: false },
];

export function DeliveryChecklist({ deal, onSave }) {
  const initial = Array.isArray(deal.delivery_checklist) ? deal.delivery_checklist : [];
  const [items, setItems] = useState(initial.length > 0 ? initial : DEFAULT_CHECKLIST);
  const [adding, setAdding] = useState('');
  const [dirty, setDirty] = useState(false);
  const { run, error, busy } = useAsyncAction();

  const toggle = (id) => { setItems(items.map((it) => (it.id === id ? { ...it, done: !it.done } : it))); setDirty(true); };
  const addItem = () => {
    if (!adding.trim()) return;
    setItems([...items, { id: Date.now(), label: adding.trim(), done: false }]);
    setAdding('');
    setDirty(true);
  };
  const removeItem = (id) => { setItems(items.filter((it) => it.id !== id)); setDirty(true); };
  const save = async () => {
    const ok = await run(() => api.put(`/deals/${deal.id}`, { delivery_checklist: items }));
    if (!ok) return;
    setDirty(false);
    onSave?.();
  };

  const completed = items.filter((it) => it.done).length;
  const pct = items.length > 0 ? Math.round((completed / items.length) * 100) : 0;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-xs text-gray-600">{completed} / {items.length} complete</span>
        <div className="h-1.5 flex-1 rounded-full bg-gray-200">
          <div className="h-1.5 rounded-full bg-brand-mint-dark" style={{ width: `${pct}%` }} />
        </div>
        {dirty && <Button size="sm" onClick={save} loading={busy} loadingLabel="Saving…">Save</Button>}
      </div>
      <ActionError error={error} className="mb-2" />
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it.id} className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={it.done} onChange={() => toggle(it.id)} className="cursor-pointer" aria-label={it.label} />
            <span className={`flex-1 ${it.done ? 'text-gray-400 line-through' : 'text-gray-800'}`}>{it.label}</span>
            <RemoveButton label={`Remove ${it.label}`} onClick={() => removeItem(it.id)} />
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <Input size="sm" placeholder="Add checklist item…" aria-label="New checklist item" value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } }}
          wrapperClassName="flex-1" />
        <Button size="sm" variant="secondary" onClick={addItem}>Add</Button>
      </div>
    </div>
  );
}
