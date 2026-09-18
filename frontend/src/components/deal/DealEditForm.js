// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Full edit form for a deal (Overview → Details → Edit). Saves the whole
// record with one PUT /deals/:id, exactly like the pre-restructure panel.
// Order-details fields (PO #, ship-to, POC, release) fold in here for
// profiles that show them so there's a single Save.

import React, { useState } from 'react';
import api from '../../api';
import CustomFieldsSection from '../CustomFieldsSection';
import { Button, Input, Select, Textarea } from '../ui';
import { ActionError, LinkButton } from './shared';

export default function DealEditForm({
  deal,
  cfg,
  customers,
  vendors,
  members,
  lineItemCount,
  showOrderDetails,
  onSaved,
  onCancel,
  onDelete,
}) {
  const [form, setForm] = useState(() => ({ ...deal }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  const save = async (e) => {
    e?.preventDefault?.();
    setSaving(true);
    setError('');
    try {
      const payload = { ...form };
      ['amount', 'closed_amount'].forEach((k) => {
        if (payload[k] === '' || payload[k] === null || payload[k] === undefined) payload[k] = null;
        else payload[k] = Number(payload[k]);
      });
      // Owner select stores '' for "unassigned" — the API expects int or null
      // (migration 135 record ownership).
      if (payload.owner_user_id === '' || payload.owner_user_id == null) payload.owner_user_id = null;
      else payload.owner_user_id = Number(payload.owner_user_id);
      if (payload.expected_close_date === '') payload.expected_close_date = null;
      const r = await api.put(`/deals/${deal.id}`, payload);
      onSaved(r.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Couldn\'t save your changes. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const dateValue = (v) => (v ? String(v).slice(0, 10) : '');

  return (
    <form onSubmit={save} className="space-y-3" aria-label="Edit deal">
      <Input size="sm" label="Title" value={form.title || ''} onChange={(e) => set({ title: e.target.value })} required />
      <Select size="sm" label="Stage" value={form.stage || ''} onChange={(e) => set({ stage: e.target.value })}>
        {cfg.allStages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </Select>
      <div className="grid grid-cols-2 gap-3">
        <Select size="sm" label="Customer" value={form.customer_id || ''} onChange={(e) => set({ customer_id: e.target.value || null })}>
          <option value="">No customer</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select size="sm" label="Vendor" value={form.vendor_id || ''} onChange={(e) => set({ vendor_id: e.target.value || null })}>
          <option value="">No vendor</option>
          {vendors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Input size="sm" label="Vertical" value={form.vertical || ''} onChange={(e) => set({ vertical: e.target.value })} />
        <Input
          size="sm"
          type="number"
          label="Amount"
          value={form.amount ?? ''}
          onChange={(e) => set({ amount: e.target.value })}
          disabled={lineItemCount > 0}
          hint={lineItemCount > 0
            ? `Derived from ${lineItemCount} line item${lineItemCount === 1 ? '' : 's'} — edit them in the Line items section.`
            : undefined}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Input size="sm" type="date" label="Expected close" value={dateValue(form.expected_close_date)}
          onChange={(e) => set({ expected_close_date: e.target.value })} />
        {/* Record owner (migration 135) — only renders for org workspaces
            (members is empty for personal workspaces). */}
        {members.length > 0 && (
          <Select size="sm" label="Owner" value={form.owner_user_id ?? ''} onChange={(e) => set({ owner_user_id: e.target.value })}>
            <option value="">No owner</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
          </Select>
        )}
      </div>
      <Textarea label="Notes" value={form.notes || ''} onChange={(e) => set({ notes: e.target.value })} rows={3} />
      <label className="flex items-center gap-2 text-sm text-gray-800">
        <input type="checkbox" className="rounded border-gray-300 text-brand-blue focus:ring-brand-blue"
          checked={!!form.hot_flag} onChange={(e) => set({ hot_flag: e.target.checked })} />
        Mark as hot
      </label>

      {showOrderDetails && (
        <fieldset className="space-y-3 border-t border-gray-100 pt-3">
          <legend className="text-sm font-semibold text-gray-900">Order details</legend>
          <Input size="sm" label="Customer PO #" value={form.po_number || ''} onChange={(e) => set({ po_number: e.target.value })} />
          <Textarea label="Ship-to address" value={form.ship_to || ''} onChange={(e) => set({ ship_to: e.target.value })} rows={2} />
          <div className="grid grid-cols-2 gap-3">
            <Input size="sm" label="POC name" value={form.poc_name || ''} onChange={(e) => set({ poc_name: e.target.value })} />
            <Input size="sm" type="email" label="POC email" value={form.poc_email || ''} onChange={(e) => set({ poc_email: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input size="sm" type="tel" label="POC phone" value={form.poc_phone || ''} onChange={(e) => set({ poc_phone: e.target.value })} />
            <Input size="sm" type="date" label="Target ship" value={dateValue(form.target_ship_date)}
              onChange={(e) => set({ target_ship_date: e.target.value })} />
          </div>
          <Select size="sm" label="Release" value={form.release_status || 'released'} onChange={(e) => set({ release_status: e.target.value })}>
            <option value="released">Released</option>
            <option value="held">Held</option>
          </Select>
          {form.release_status === 'held' && (
            <Input size="sm" label="Hold reason" value={form.hold_reason || ''} onChange={(e) => set({ hold_reason: e.target.value })} />
          )}
        </fieldset>
      )}

      <CustomFieldsSection
        entity="deals"
        values={form.custom_fields || {}}
        onChange={(next) => set({ custom_fields: next })}
      />

      <ActionError error={error} />

      <div className="flex items-center justify-between pt-1">
        <LinkButton tone="danger" onClick={onDelete}>Delete deal</LinkButton>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button size="sm" type="submit" loading={saving} loadingLabel="Saving…">Save changes</Button>
        </div>
      </div>
    </form>
  );
}
