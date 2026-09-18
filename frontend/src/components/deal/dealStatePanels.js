// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Deal-state panels for advanced-workflow profiles (SOW §4.5e): buy-back and
// end-user tracking. Both write straight to PUT /deals/:id.

import React, { useState } from 'react';
import api from '../../api';
import { Button, Input, Select, StatusBadge, Textarea } from '../ui';
import { ActionError, useAsyncAction } from './shared';

// -- Buy-back workflow. Status flow: none → eligible → requested → approved → completed.
const BUYBACK_STATUSES = ['none', 'eligible', 'requested', 'approved', 'completed'];
const BUYBACK_TONE = {
  none: 'neutral',
  eligible: 'info',
  requested: 'warning',
  approved: 'success',
  completed: 'success',
};

export function BuyBackPanel({ deal, onChange }) {
  const [form, setForm] = useState({
    buy_back_status: deal.buy_back_status || 'none',
    buy_back_amount: deal.buy_back_amount || '',
    buy_back_notes: deal.buy_back_notes || '',
  });
  const { run, error, busy: saving } = useAsyncAction();

  const save = async () => {
    const ok = await run(() => api.put(`/deals/${deal.id}`, {
      ...form,
      buy_back_amount: form.buy_back_amount ? Number(form.buy_back_amount) : null,
    }));
    if (ok) onChange?.();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <StatusBadge tone={BUYBACK_TONE[form.buy_back_status] || 'neutral'} label={form.buy_back_status} className="uppercase" />
        <Select
          size="sm"
          aria-label="Buy-back status"
          value={form.buy_back_status}
          onChange={(e) => setForm({ ...form, buy_back_status: e.target.value })}
          options={BUYBACK_STATUSES}
          wrapperClassName="w-36"
        />
      </div>
      {form.buy_back_status !== 'none' && (
        <>
          <Input size="sm" type="number" placeholder="Buy-back amount" aria-label="Buy-back amount" value={form.buy_back_amount}
            onChange={(e) => setForm({ ...form, buy_back_amount: e.target.value })} />
          <Textarea placeholder="Notes" aria-label="Buy-back notes" value={form.buy_back_notes} rows={2}
            onChange={(e) => setForm({ ...form, buy_back_notes: e.target.value })} />
        </>
      )}
      <div className="flex justify-end">
        <Button size="sm" onClick={save} loading={saving} loadingLabel="Saving…">Save</Button>
      </div>
      <ActionError error={error} />
    </div>
  );
}

// -- End-user tracking. Captures who actually uses the product (often distinct
// from the direct customer in manufacturer's-rep workflows).
export function EndUserPanel({ deal, companies, contacts, onChange }) {
  const [form, setForm] = useState({
    end_user_company_id: deal.end_user_company_id || '',
    end_user_contact_id: deal.end_user_contact_id || '',
  });
  const { run, error, busy: saving } = useAsyncAction();

  const save = async () => {
    const ok = await run(() => api.put(`/deals/${deal.id}`, {
      end_user_company_id: form.end_user_company_id || null,
      end_user_contact_id: form.end_user_contact_id || null,
    }));
    if (ok) onChange?.();
  };

  const customers = (companies || []).filter((c) => c.type === 'customer' || c.type === 'end_user' || !c.type);

  return (
    <div className="space-y-3">
      <Select size="sm" label="End-user company" value={form.end_user_company_id}
        onChange={(e) => setForm({ ...form, end_user_company_id: e.target.value })}>
        <option value="">None (sold direct)</option>
        {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </Select>
      <Select size="sm" label="End-user contact" value={form.end_user_contact_id}
        onChange={(e) => setForm({ ...form, end_user_contact_id: e.target.value })}>
        <option value="">None</option>
        {(contacts || []).map((c) => <option key={c.id} value={c.id}>{c.first_name} {c.last_name}</option>)}
      </Select>
      <div className="flex justify-end">
        <Button size="sm" onClick={save} loading={saving} loadingLabel="Saving…">Save</Button>
      </div>
      <ActionError error={error} />
    </div>
  );
}
