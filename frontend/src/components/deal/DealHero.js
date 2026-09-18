// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// The deal drawer's hero: the one place that answers "what is this deal and
// what do I do next?". Title (inline-editable, rendered in the Drawer header),
// company + contact, stage badge + stage picker, value / close / owner, the
// intent-driven next step, and the primary CTA row. Everything else in the
// drawer is a tab below this.

import React, { useEffect, useState } from 'react';
import { getNextStep } from '../../nextSteps';
import { Button, Icon, Input, Menu, Select, StatusBadge } from '../ui';
import { fmtDate, fmtMoney } from './shared';

// Stage tone: closed/paid/won reads green, lost/cancelled red, else brand.
export function stageTone(stageId) {
  const s = String(stageId || '').toLowerCase();
  if (/lost|cancel/.test(s)) return 'error';
  if (/won|paid|invoiced|^closed$|delivered/.test(s)) return 'success';
  return 'info';
}

// -- Inline-editable title. Rendered inside the Drawer's <h2>: click to edit,
// Enter/blur saves (PUT /deals/:id { title }), Escape cancels.
export function InlineTitle({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const [error, setError] = useState('');

  useEffect(() => { if (!editing) setDraft(value || ''); }, [value, editing]);

  const cancel = () => { setEditing(false); setDraft(value || ''); setError(''); };
  const commit = async () => {
    const next = draft.trim();
    if (!next || next === value) { cancel(); return; }
    try {
      await onSave(next);
      setEditing(false);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Couldn\'t rename the deal.');
    }
  };

  if (editing) {
    return (
      <Input
        size="sm"
        aria-label="Deal title"
        value={draft}
        autoFocus
        error={error}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        className="font-semibold"
        wrapperClassName="whitespace-normal"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Rename deal"
      className="group inline-flex max-w-full items-center gap-1.5 rounded text-left hover:text-brand-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
    >
      <span className="truncate">{value}</span>
      <Icon name="edit" size={14} className="flex-shrink-0 text-gray-300 group-hover:text-brand-blue" />
    </button>
  );
}

// -- Company · contact line (Drawer description slot).
export function HeroSubtitle({ customerName, vendorName, contact }) {
  const parts = [];
  if (customerName) parts.push({ icon: 'building', text: customerName });
  if (contact) {
    const name = `${contact.first_name || ''} ${contact.last_name || ''}`.trim();
    parts.push({ icon: 'user', text: name || contact.email || 'Contact' });
  }
  if (vendorName) parts.push({ icon: 'briefcase', text: `Vendor: ${vendorName}` });
  if (parts.length === 0) return <span className="text-gray-400">No company linked yet</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {parts.map((p) => (
        <span key={p.icon + p.text} className="inline-flex items-center gap-1">
          <Icon name={p.icon} size={14} className="text-gray-400" />
          {p.text}
        </span>
      ))}
    </span>
  );
}

export default function DealHero({
  deal,
  cfg,
  members,
  lineItemCount,
  aiEnabled,
  onStageChange,
  onLogActivity,
  onAddTask,
  onAi,
  overflowItems,
}) {
  const [stageError, setStageError] = useState('');
  const [stageBusy, setStageBusy] = useState(false);

  const changeStage = async (stage) => {
    if (!stage || stage === deal.stage) return;
    setStageBusy(true);
    setStageError('');
    try {
      await onStageChange(stage);
    } catch (err) {
      setStageError(err.response?.data?.error || 'Couldn\'t change the stage.');
    } finally {
      setStageBusy(false);
    }
  };

  const owner = (() => {
    if (!deal.owner_user_id) return '—';
    const m = members.find((x) => Number(x.id) === Number(deal.owner_user_id));
    return m ? (m.name || m.email) : `User #${deal.owner_user_id}`;
  })();

  const nextStep = getNextStep(deal, cfg.profile);
  const isAdvanced = cfg.showAdvancedPanels;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={stageTone(deal.stage)} label={cfg.stageLabel(deal.stage)} size="md" />
        <Select
          size="sm"
          aria-label="Change stage"
          value={deal.stage || ''}
          disabled={stageBusy}
          onChange={(e) => changeStage(e.target.value)}
          wrapperClassName="w-48"
          error={stageError || undefined}
        >
          {cfg.allStages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </Select>
        {deal.hot_flag && (
          <StatusBadge tone="warning" size="md" label={<><Icon name="flame" size={12} />Hot</>} />
        )}
        {deal.release_status === 'held' && cfg.showOrderDetails && (
          <StatusBadge tone="error" size="md" label="On hold" />
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-wider text-gray-500">Value</dt>
          <dd className="text-base font-semibold text-gray-900">
            {fmtMoney(deal.amount)}
            {lineItemCount > 0 && <span className="ml-1 text-xs font-normal text-gray-400">from line items</span>}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-gray-500">
            {isAdvanced && deal.phase !== 'pre_sale' ? 'Target ship' : 'Expected close'}
          </dt>
          <dd className="text-sm text-gray-900">
            {isAdvanced && deal.phase !== 'pre_sale' ? fmtDate(deal.target_ship_date) : fmtDate(deal.expected_close_date)}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-gray-500">Owner</dt>
          <dd className="truncate text-sm text-gray-900">{owner}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-gray-500">{isAdvanced ? 'Phase' : 'Vertical'}</dt>
          <dd className="truncate text-sm text-gray-900">
            {isAdvanced ? (deal.phase ? String(deal.phase).replace(/_/g, ' ') : '—') : (deal.vertical || '—')}
          </dd>
        </div>
      </dl>

      {nextStep && (
        <p className="flex items-start gap-2 rounded border border-info-200 bg-info-50 px-3 py-2 text-sm text-gray-800">
          <Icon name="arrow-right" size={16} className="mt-0.5 flex-shrink-0 text-brand-blue" />
          <span>
            <span className="font-semibold text-brand-blue">Next: {nextStep.label}</span>
            {nextStep.hint && <span className="text-gray-600"> — {nextStep.hint}</span>}
          </span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon="plus" onClick={onLogActivity}>Log activity</Button>
        <Button size="sm" variant="secondary" icon="check" onClick={onAddTask}>Add task</Button>
        {aiEnabled && (
          <Menu
            size="sm"
            label="AI assist"
            align="left"
            trigger={({ open }) => (
              <Button size="sm" variant="secondary" icon="sparkles" iconRight="chevron-down" aria-expanded={open}>
                AI assist
              </Button>
            )}
            items={[
              { label: 'Summarize deal', icon: 'sparkles', onClick: () => onAi('summarize') },
              { label: 'Draft follow-up', icon: 'mail', onClick: () => onAi('draft') },
            ]}
          />
        )}
        <Menu size="sm" label="More actions" items={overflowItems} />
      </div>
    </div>
  );
}
