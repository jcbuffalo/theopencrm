// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Vendor RFQ panel (advanced-workflow profiles): the list of vendor quotes
// on a deal, the add form, and the "send RFQ" modal.

import React, { useEffect, useState } from 'react';
import api from '../../api';
import { Alert, Button, Input, Modal, Select, StatusBadge, Textarea } from '../ui';
import { ActionError, fmtMoney, LinkButton, RemoveButton, rowControlClass, useAsyncAction } from './shared';

export function SendRfqModal({ vq, onClose, onSent }) {
  const [form, setForm] = useState({ recipient_email: '', recipient_name: '', custom_message: '' });
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const send = async (e) => {
    e.preventDefault();
    setSending(true);
    setError('');
    try {
      const r = await api.post(`/vendor-quotes/${vq.id}/send-rfq`, form);
      setResult(r.data);
      onSent?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send RFQ');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open={!!vq}
      onClose={onClose}
      title={`Send RFQ to ${vq.vendor_name}`}
      description="Email goes from your configured sender; replies route to your address."
      footer={result ? (
        <Button onClick={onClose}>Close</Button>
      ) : (
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="send-rfq-form" loading={sending} loadingLabel="Sending…">Send RFQ</Button>
        </>
      )}
    >
      {result ? (
        <div className="space-y-3">
          <Alert tone={result.transport === 'console' ? 'warning' : 'success'}>{result.message}</Alert>
          <p className="text-xs text-gray-500">Transport: <code>{result.transport}</code></p>
        </div>
      ) : (
        <form id="send-rfq-form" onSubmit={send} className="space-y-3">
          {error && <Alert tone="danger">{error}</Alert>}
          <Input type="email" label="Recipient email" required value={form.recipient_email}
            onChange={(e) => setForm({ ...form, recipient_email: e.target.value })} placeholder="quotes@vendor.com" />
          <Input label="Recipient name (optional)" value={form.recipient_name}
            onChange={(e) => setForm({ ...form, recipient_name: e.target.value })} placeholder="Jane" />
          <Textarea label="Custom message (optional)" value={form.custom_message} rows={4}
            onChange={(e) => setForm({ ...form, custom_message: e.target.value })}
            placeholder="Add anything specific you'd like the vendor to know — deadline, special specs, etc."
            hint="The deal title, vertical, and notes will be auto-included." />
        </form>
      )}
    </Modal>
  );
}

export function VendorQuotesPanel({ dealId, vendors, onChange }) {
  const [list, setList] = useState([]);
  const [adding, setAdding] = useState(false);
  const [sendingFor, setSendingFor] = useState(null);
  const [form, setForm] = useState({ vendor_id: '', amount: '', lead_time_days: '', status: 'requested', notes: '' });
  const [loadError, setLoadError] = useState('');
  const { run, error } = useAsyncAction();

  const load = async () => {
    try {
      const r = await api.get(`/vendor-quotes?deal_id=${dealId}`);
      setList(r.data);
      setLoadError('');
    } catch (err) {
      setLoadError(err.response?.data?.error || 'Failed to load vendor RFQs.');
    }
  };

  useEffect(() => { load(); }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async (e) => {
    e.preventDefault();
    if (!form.vendor_id) return;
    const ok = await run(() => api.post('/vendor-quotes', {
      deal_id: dealId,
      vendor_id: Number(form.vendor_id),
      amount: form.amount ? Number(form.amount) : null,
      lead_time_days: form.lead_time_days ? Number(form.lead_time_days) : null,
      status: form.status,
      notes: form.notes || null,
      rfq_sent_at: new Date().toISOString(),
    }));
    if (!ok) return;
    setForm({ vendor_id: '', amount: '', lead_time_days: '', status: 'requested', notes: '' });
    setAdding(false);
    load();
    onChange?.();
  };

  const select = async (id) => {
    if (await run(() => api.put(`/vendor-quotes/${id}`, { is_selected: true }))) load();
  };

  const updateStatus = async (id, status) => {
    const patch = { status };
    if (status === 'received') patch.quote_received_at = new Date().toISOString();
    if (await run(() => api.put(`/vendor-quotes/${id}`, patch))) load();
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this vendor quote?')) return;
    if (await run(() => api.delete(`/vendor-quotes/${id}`))) load();
  };

  return (
    <div>
      <ActionError error={loadError || error} className="mb-2" />
      {list.length === 0 ? (
        <p className="mb-2 text-xs text-gray-500">No vendor RFQs yet.</p>
      ) : (
        <div className="mb-3 overflow-x-auto rounded border border-gray-200">
          <table className="w-full text-xs">
            <thead className="bg-gray-50">
              <tr className="text-xs uppercase tracking-wider text-gray-500">
                <th className="px-2 py-1.5 text-left font-medium">Vendor</th>
                <th className="px-2 py-1.5 text-right font-medium">Quote</th>
                <th className="px-2 py-1.5 text-right font-medium">Lead</th>
                <th className="px-2 py-1.5 text-left font-medium">Status</th>
                <th className="px-2 py-1.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((vq) => (
                <tr key={vq.id} className={`border-t border-gray-100 ${vq.is_selected ? 'bg-success-50' : ''}`}>
                  <td className="px-2 py-1.5">
                    <div className="font-medium text-gray-900">{vq.vendor_name}</div>
                    {vq.is_selected && <StatusBadge tone="success" label="Selected" />}
                  </td>
                  <td className="px-2 py-1.5 text-right font-medium">{fmtMoney(vq.amount)}</td>
                  <td className="px-2 py-1.5 text-right">{vq.lead_time_days ? `${vq.lead_time_days}d` : '—'}</td>
                  <td className="px-2 py-1.5">
                    <select value={vq.status} onChange={(e) => updateStatus(vq.id, e.target.value)}
                      aria-label={`Status for ${vq.vendor_name}`} className={rowControlClass}>
                      <option value="requested">Requested</option>
                      <option value="received">Received</option>
                      <option value="declined">Declined</option>
                    </select>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right">
                    <span className="inline-flex items-center gap-2">
                      <LinkButton tone="brand" onClick={() => setSendingFor(vq)}>
                        {vq.rfq_sent_at ? 'Re-send' : 'Send RFQ'}
                      </LinkButton>
                      {!vq.is_selected && vq.amount && (
                        <LinkButton onClick={() => select(vq.id)}>Select</LinkButton>
                      )}
                      <RemoveButton label="Delete vendor quote" onClick={() => remove(vq.id)} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding ? (
        <form onSubmit={create} className="space-y-2 rounded bg-gray-50 p-3">
          <Select size="sm" aria-label="Vendor" value={form.vendor_id} onChange={(e) => setForm({ ...form, vendor_id: e.target.value })} required>
            <option value="">Select vendor…</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </Select>
          <div className="grid grid-cols-2 gap-2">
            <Input size="sm" type="number" placeholder="Quote amount" aria-label="Quote amount" value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            <Input size="sm" type="number" placeholder="Lead time (days)" aria-label="Lead time (days)" value={form.lead_time_days}
              onChange={(e) => setForm({ ...form, lead_time_days: e.target.value })} />
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" type="submit">Add</Button>
          </div>
        </form>
      ) : (
        <Button size="sm" variant="ghost" icon="plus" onClick={() => setAdding(true)}>Add vendor RFQ</Button>
      )}

      {sendingFor && (
        <SendRfqModal vq={sendingFor} onClose={() => setSendingFor(null)} onSent={() => { load(); }} />
      )}
    </div>
  );
}
