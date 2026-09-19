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
import { Link } from 'react-router-dom';
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
    // The primary contact links to its record (/contacts/:id drawer).
    parts.push({ icon: 'user', text: name || contact.email || 'Contact', to: contact.id ? `/contacts/${contact.id}` : null });
  }
  if (vendorName) parts.push({ icon: 'briefcase', text: `Vendor: ${vendorName}` });
  if (parts.length === 0) return <span className="text-gray-400">No company linked yet</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {parts.map((p) => (
        p.to ? (
          <Link key={p.icon + p.text} to={p.to} className="inline-flex items-center gap-1 hover:text-brand-blue hover:underline">
            <Icon name={p.icon} size={14} className="text-gray-400" />
            {p.text}
          </Link>
        ) : (
          <span key={p.icon + p.text} className="inline-flex items-center gap-1">
            <Icon name={p.icon} size={14} className="text-gray-400" />
            {p.text}
          </span>
        )
      ))}
    </span>
  );
}

// -- The rep's committed next step (migration 172). Three states: no step
// yet (canned per-stage hint + "Set next step"), a step on file (text + due
// date, overdue tint, Edit / Done), and the inline editor. `onSave` receives
// { next_step, next_step_date } — both keys always present so the PUT's
// explicit-key semantics can CLEAR a finished step.
function isoToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nextStepStatus(dateStr) {
  if (!dateStr) return null;
  const today = isoToday();
  const d = String(dateStr).slice(0, 10);
  if (d < today) return 'overdue';
  if (d === today) return 'today';
  return 'upcoming';
}

export function NextStepLine({ deal, hint, onSave }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(deal.next_step || '');
  const [date, setDate] = useState(deal.next_step_date ? String(deal.next_step_date).slice(0, 10) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!editing) {
      setText(deal.next_step || '');
      setDate(deal.next_step_date ? String(deal.next_step_date).slice(0, 10) : '');
    }
  }, [deal.next_step, deal.next_step_date, editing]);

  const save = async (patch) => {
    setBusy(true);
    setError('');
    try {
      await onSave(patch);
      setEditing(false);
    } catch (err) {
      setError(err.response?.data?.error || 'Couldn\'t save the next step.');
    } finally {
      setBusy(false);
    }
  };

  const submit = (e) => {
    e?.preventDefault?.();
    const t = text.trim();
    if (!t) { setError('Write the next step first.'); return; }
    save({ next_step: t, next_step_date: date || null });
  };

  if (editing) {
    return (
      <form onSubmit={submit} className="space-y-2 rounded border border-info-200 bg-info-50 px-3 py-2">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
          <Input
            size="sm"
            aria-label="Next step"
            placeholder="e.g. Send revised quote to Dana"
            value={text}
            autoFocus
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setEditing(false); } }}
          />
          <Input
            size="sm"
            type="date"
            aria-label="Next step due date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            wrapperClassName="sm:w-40"
          />
        </div>
        {error && <p className="text-xs text-danger-600">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" type="submit" loading={busy} loadingLabel="Saving…">Save next step</Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
          <span className="ml-auto text-[11px] text-gray-500">Shows up on My Day when it's due.</span>
        </div>
      </form>
    );
  }

  if (deal.next_step) {
    const status = nextStepStatus(deal.next_step_date);
    const tone = status === 'overdue'
      ? 'border-danger-200 bg-danger-50'
      : status === 'today' ? 'border-warning-200 bg-warning-50' : 'border-info-200 bg-info-50';
    const dateLabel = deal.next_step_date
      ? (status === 'overdue' ? `was due ${fmtDate(deal.next_step_date)}` : status === 'today' ? 'due today' : `due ${fmtDate(deal.next_step_date)}`)
      : 'no date';
    return (
      <div className={`flex flex-wrap items-start gap-2 rounded border px-3 py-2 text-sm text-gray-800 ${tone}`}>
        <Icon name="arrow-right" size={16} className={`mt-0.5 flex-shrink-0 ${status === 'overdue' ? 'text-danger-600' : 'text-brand-blue'}`} />
        <span className="min-w-0 flex-1">
          <span className="font-semibold">{deal.next_step}</span>
          <span className={`ml-2 text-xs ${status === 'overdue' ? 'font-semibold text-danger-600' : 'text-gray-600'}`}>{dateLabel}</span>
          {error && <span className="block text-xs text-danger-600">{error}</span>}
        </span>
        <span className="flex flex-shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing(true)} disabled={busy} aria-label="Edit next step">Edit</Button>
          <Button size="sm" variant="ghost" icon="check" loading={busy} loadingLabel="…"
            title="Mark this step done and clear it"
            onClick={() => save({ next_step: null, next_step_date: null })}>
            Done
          </Button>
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-start gap-2 rounded border border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-700">
      <Icon name="arrow-right" size={16} className="mt-0.5 flex-shrink-0 text-gray-400" />
      <span className="min-w-0 flex-1">
        {hint ? (
          <>
            <span className="font-medium text-gray-800">Suggested: {hint.label}</span>
            {hint.hint && <span className="text-gray-500"> — {hint.hint}</span>}
          </>
        ) : (
          <span className="text-gray-500">No next step committed yet.</span>
        )}
      </span>
      <Button size="sm" variant="secondary" icon="plus" onClick={() => setEditing(true)}>Set next step</Button>
    </div>
  );
}

export default function DealHero({
  deal,
  cfg,
  members,
  lineItemCount,
  aiEnabled,
  onStageChange,
  onNextStepChange,
  onLogActivity,
  onAddTask,
  onEmail,
  hasEmailTarget,
  onAi,
  onAskCopilot,
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
        {/* Phase is a Zang concept (Pre-Sale / Post-Sale / Post-Shipment); a
            generic or jcp deal has no phase worth showing, so this slot is
            gated on showAdvancedPanels rather than falling back to the
            (also Zang-only) Vertical field. */}
        {isAdvanced && (
          <div>
            <dt className="text-xs uppercase tracking-wider text-gray-500">Phase</dt>
            <dd className="truncate text-sm text-gray-900">
              {deal.phase ? String(deal.phase).replace(/_/g, ' ') : '—'}
            </dd>
          </div>
        )}
      </dl>

      {/* The committed next step (migration 172) replaces the canned per-stage
          hint once the rep writes one; the hint stays as the "suggested"
          fallback while no step is on file. */}
      {onNextStepChange ? (
        <NextStepLine deal={deal} hint={nextStep} onSave={onNextStepChange} />
      ) : nextStep && (
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
        {/* Promoted from the "More actions" overflow (email is a first-class
            daily action, not a buried one) — shown once there's somewhere to
            send it; "Send email" stays in the overflow menu too. */}
        {hasEmailTarget && (
          <Button size="sm" variant="secondary" icon="mail" onClick={onEmail}>Email</Button>
        )}
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
        {/* Chat-from-record: opens /chat?seed=deal&deal_id=N, which pre-sends
            one grounded opening message (pages/Chat.js seed handling). */}
        {aiEnabled && onAskCopilot && (
          <Button size="sm" variant="secondary" icon="chat" onClick={onAskCopilot} title="Open the copilot with this deal loaded">
            Ask the copilot
          </Button>
        )}
        <Menu size="sm" label="More actions" items={overflowItems} />
      </div>
    </div>
  );
}
