// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Nav from '../components/Nav';
import api from '../api';
import {
  Alert, Button, Card, Container, EmptyState, Icon, Input, Modal, PageHeader, Select, Spinner, StatusBadge, Textarea,
} from '../components/ui';

// Leads — the pre-qualification board (migration 130) plus the capture-form
// manager (migration 131). Status columns mirror the Deals kanban visual
// language but skip drag-and-drop: a lead's status is a deliberate triage
// call, so the per-card status select + edit modal cover the motion without
// pulling @dnd-kit into another chunk.

const STATUSES = [
  { id: 'new',         label: 'New',         desc: 'Just arrived — untriaged',            header: 'bg-info-50',     border: 'border-info-200',     bg: 'bg-info-50/40' },
  { id: 'working',     label: 'Working',     desc: 'Being contacted / researched',        header: 'bg-warning-50',  border: 'border-warning-200',  bg: 'bg-warning-50/40' },
  { id: 'qualified',   label: 'Qualified',   desc: 'Real opportunity — ready to convert', header: 'bg-success-50',  border: 'border-success-200',  bg: 'bg-success-50/40' },
  { id: 'unqualified', label: 'Unqualified', desc: 'Not a fit (kept for the record)',     header: 'bg-gray-100',    border: 'border-gray-200',     bg: 'bg-gray-50' },
  { id: 'converted',   label: 'Converted',   desc: 'Now a contact (and maybe a deal)',    header: 'bg-purple-50',   border: 'border-purple-200',   bg: 'bg-purple-50/40' },
];

const MOVABLE_STATUSES = STATUSES.filter((s) => s.id !== 'converted');

const SOURCE_TONE = {
  'web form': 'info',
  manual: 'neutral',
  referral: 'success',
  import: 'warning',
};

function memberName(members, id) {
  const m = members.find((x) => x.id === id);
  return m ? (m.name || m.email) : null;
}

function LeadCard({ lead, members, onClick, onMove }) {
  const ownerName = memberName(members, lead.owner_user_id);
  return (
    <div
      onClick={() => onClick(lead)}
      className="bg-white rounded p-3 shadow-card border border-gray-200 hover:shadow-md transition-shadow cursor-pointer"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold text-gray-900 text-sm leading-snug line-clamp-2">{lead.name}</p>
        <span className="flex items-center gap-1 flex-shrink-0">
          {Number(lead.score) > 0 && (
            <StatusBadge
              tone="accent"
              title={`Lead score: ${lead.score}`}
              label={<><Icon name="star" size={10} />{lead.score}</>}
            />
          )}
          {lead.source && (
            <StatusBadge tone={SOURCE_TONE[lead.source] || 'neutral'} label={lead.source} />
          )}
        </span>
      </div>
      {lead.company_name && <p className="text-xs text-gray-600 mt-1 truncate">{lead.company_name}</p>}
      {lead.email && <p className="text-xs text-gray-400 truncate">{lead.email}</p>}
      <div className="flex justify-between items-center mt-2 gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] text-gray-500 truncate">
          <Icon name="user" size={11} className="text-gray-400" />
          {ownerName || 'Unassigned'}
        </span>
        {lead.status === 'converted' ? (
          lead.converted_deal_id ? (
            <Link
              to={`/deals?dealId=${lead.converted_deal_id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-[11px] text-brand-blue hover:underline flex-shrink-0"
            >
              View deal →
            </Link>
          ) : lead.converted_contact_id ? (
            <Link
              to={`/contacts/${lead.converted_contact_id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-[11px] text-brand-blue hover:underline flex-shrink-0"
            >
              View contact →
            </Link>
          ) : null
        ) : (
          <select
            value={lead.status}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onMove(lead, e.target.value)}
            aria-label={`Move ${lead.name} to another status`}
            className="text-[11px] border border-gray-300 rounded-md px-1 py-0.5 text-gray-600 bg-white flex-shrink-0 focus:outline-none focus:border-brand-blue"
          >
            {MOVABLE_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}

function LeadModal({ lead, members, onClose, onSaved, onDeleted, onConverted }) {
  const isNew = !lead.id;
  const [form, setForm] = useState({
    name: lead.name || '', email: lead.email || '', phone: lead.phone || '',
    company_name: lead.company_name || '', title: lead.title || '',
    source: lead.source || 'manual', status: lead.status || 'new',
    owner_user_id: lead.owner_user_id || '', notes: lead.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [convertOpen, setConvertOpen] = useState(false);
  const [convert, setConvert] = useState({ createDeal: true, dealTitle: '', dealAmount: '' });

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true); setError(null);
    try {
      const payload = {
        ...form,
        owner_user_id: form.owner_user_id ? Number(form.owner_user_id) : null,
      };
      if (isNew) await api.post('/leads', payload);
      else await api.put(`/leads/${lead.id}`, payload);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save lead');
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete lead "${lead.name}"? This can't be undone.`)) return;
    setSaving(true);
    try {
      await api.delete(`/leads/${lead.id}`);
      onDeleted();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete lead');
      setSaving(false);
    }
  };

  const doConvert = async () => {
    setSaving(true); setError(null);
    try {
      const res = await api.post(`/leads/${lead.id}/convert`, {
        createDeal: convert.createDeal,
        dealTitle: convert.dealTitle || undefined,
        dealAmount: convert.dealAmount ? Number(convert.dealAmount) : undefined,
      });
      onConverted(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to convert lead');
      setSaving(false);
    }
  };

  const converted = lead.status === 'converted';
  const title = isNew ? 'New lead' : converted ? 'Converted lead' : convertOpen ? 'Convert lead' : 'Edit lead';

  let footer = null;
  if (converted) {
    footer = <Button variant="secondary" onClick={onClose}>Close</Button>;
  } else if (convertOpen) {
    footer = (
      <>
        <Button variant="secondary" onClick={() => setConvertOpen(false)} disabled={saving}>Back</Button>
        <Button onClick={doConvert} loading={saving} loadingLabel="Converting…" icon="check">
          {convert.createDeal ? 'Convert to contact + deal' : 'Convert to contact'}
        </Button>
      </>
    );
  } else {
    footer = (
      <>
        {!isNew && (
          <div className="mr-auto">
            <Button variant="danger" icon="trash" onClick={remove} disabled={saving}>Delete</Button>
          </div>
        )}
        {!isNew && (
          <Button variant="secondary" onClick={() => setConvertOpen(true)} disabled={saving} iconRight="arrow-right">
            Convert
          </Button>
        )}
        <Button onClick={save} loading={saving} loadingLabel="Saving…">{isNew ? 'Create lead' : 'Save'}</Button>
      </>
    );
  }

  return (
    <Modal open onClose={onClose} title={title} footer={footer}>
      {error && <Alert tone="danger" className="mb-4">{error}</Alert>}

      {converted ? (
        <div className="space-y-3 text-sm text-gray-700">
          <p><span className="font-medium">{lead.name}</span> was converted{lead.company_name ? ` (${lead.company_name})` : ''}.</p>
          <div className="flex gap-4">
            {lead.converted_contact_id && <Link to={`/contacts/${lead.converted_contact_id}`} className="text-brand-blue hover:underline">View contact →</Link>}
            {lead.converted_deal_id && <Link to={`/deals?dealId=${lead.converted_deal_id}`} className="text-brand-blue hover:underline">View deal →</Link>}
          </div>
        </div>
      ) : convertOpen ? (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            This creates a <span className="font-medium">contact</span> from the lead and marks it converted. That can't be undone from this board.
          </p>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={convert.createDeal}
              onChange={(e) => setConvert((c) => ({ ...c, createDeal: e.target.checked }))}
              className="h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue"
            />
            Also create a deal
          </label>
          {convert.createDeal && (
            <>
              <Input
                label="Deal title"
                value={convert.dealTitle}
                onChange={(e) => setConvert((c) => ({ ...c, dealTitle: e.target.value }))}
                placeholder={`Default: ${form.company_name ? `${form.company_name} — ${form.name}` : form.name}`}
              />
              <Input
                label="Amount"
                value={convert.dealAmount}
                onChange={(e) => setConvert((c) => ({ ...c, dealAmount: e.target.value }))}
                placeholder="Optional"
                type="number" min="0"
              />
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Name" required value={form.name} onChange={set('name')} wrapperClassName="sm:col-span-2" autoFocus />
          <Input label="Email" type="email" value={form.email} onChange={set('email')} />
          <Input label="Phone" value={form.phone} onChange={set('phone')} />
          <Input label="Company" value={form.company_name} onChange={set('company_name')} />
          <Input label="Job title" value={form.title} onChange={set('title')} />
          <Input label="Source" value={form.source} onChange={set('source')} />
          <Select label="Status" value={form.status} onChange={set('status')}>
            {MOVABLE_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </Select>
          <Select label="Owner" value={form.owner_user_id} onChange={set('owner_user_id')} wrapperClassName="sm:col-span-2">
            <option value="">{isNew ? 'Auto-assign (round-robin)' : 'Unassigned'}</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
          </Select>
          <Textarea label="Notes" value={form.notes} onChange={set('notes')} rows={3} wrapperClassName="sm:col-span-2" />
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Capture-form manager
// ---------------------------------------------------------------------------

const FORM_FIELD_OPTIONS = [
  { key: 'email',        label: 'Email' },
  { key: 'phone',        label: 'Phone' },
  { key: 'company_name', label: 'Company' },
  { key: 'title',        label: 'Job title' },
  { key: 'notes',        label: 'Message / notes' },
];

function publicFormUrl(token) {
  return `${window.location.origin}/f/${token}`;
}

function embedSnippet(token) {
  return `<iframe src="${publicFormUrl(token)}" width="100%" height="480" style="border:0;border-radius:12px" title="Contact form"></iframe>`;
}

function FormsPanel({ forms, onChanged }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [fields, setFields] = useState({ email: true, phone: false, company_name: true, title: false, notes: true });
  const [redirectUrl, setRedirectUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null); // `${id}:url` | `${id}:embed`

  const copy = (formId, kind, text) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(`${formId}:${kind}`);
      setTimeout(() => setCopied(null), 1500);
    }).catch(() => {});
  };

  const create = async () => {
    if (!name.trim()) { setError('Give the form a name'); return; }
    setBusy(true); setError(null);
    try {
      await api.post('/lead-forms', { name, fields, redirect_url: redirectUrl.trim() || undefined });
      setCreating(false); setName(''); setRedirectUrl('');
      onChanged();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create form');
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (form) => {
    try {
      await api.put(`/lead-forms/${form.id}`, { is_active: !form.is_active });
      onChanged();
    } catch { /* transient — the list refresh will show truth */ }
  };

  const remove = async (form) => {
    if (!window.confirm(`Delete form "${form.name}"? Its public URL stops working immediately.`)) return;
    try {
      await api.delete(`/lead-forms/${form.id}`);
      onChanged();
    } catch { /* ditto */ }
  };

  return (
    <Card
      className="mb-5"
      title="Capture forms"
      subtitle="Public forms that feed this board — share the link or embed the snippet. Submissions arrive as web-form leads, round-robin assigned to your team."
      actions={
        <Button variant="secondary" size="sm" icon={creating ? 'x' : 'plus'} onClick={() => { setCreating((c) => !c); setError(null); }}>
          {creating ? 'Cancel' : 'New form'}
        </Button>
      }
      padding={creating || forms.length > 0 ? 'md' : 'none'}
    >
      {creating && (
        <div className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Input
            label="Form name"
            value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Homepage contact"
            wrapperClassName="sm:max-w-md"
          />
          <div>
            <span className="block text-sm font-medium text-gray-700 mb-1.5">Fields to collect</span>
            <div className="flex flex-wrap gap-3">
              {FORM_FIELD_OPTIONS.map((f) => (
                <label key={f.key} className="flex items-center gap-1.5 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={!!fields[f.key]}
                    onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.checked }))}
                    className="h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue"
                  />
                  {f.label}
                </label>
              ))}
              <span className="text-xs text-gray-400 self-center">(Name is always collected)</span>
            </div>
          </div>
          <Input
            label="Redirect after submit"
            value={redirectUrl} onChange={(e) => setRedirectUrl(e.target.value)}
            placeholder="Optional, https://…"
            wrapperClassName="sm:max-w-md"
          />
          <Button size="sm" onClick={create} loading={busy} loadingLabel="Creating…">Create form</Button>
        </div>
      )}

      {forms.length > 0 && (
        <ul className={`divide-y divide-gray-100 ${creating ? 'mt-4 border-t border-gray-100' : ''}`}>
          {forms.map((f) => (
            <li key={f.id} className="py-2.5 flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 truncate">{f.name}</span>
                  <StatusBadge tone={f.is_active ? 'success' : 'neutral'} label={f.is_active ? 'Active' : 'Paused'} />
                  <span className="text-[11px] text-gray-400">{f.submit_count} submission{f.submit_count === 1 ? '' : 's'}</span>
                </div>
                <div className="text-xs text-gray-500 truncate mt-0.5 font-mono">{publicFormUrl(f.public_token)}</div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <Button variant="ghost" size="sm" icon="copy" onClick={() => copy(f.id, 'url', publicFormUrl(f.public_token))}>
                  {copied === `${f.id}:url` ? 'Copied' : 'Copy link'}
                </Button>
                <Button variant="ghost" size="sm" icon="external" onClick={() => copy(f.id, 'embed', embedSnippet(f.public_token))}>
                  {copied === `${f.id}:embed` ? 'Copied' : 'Copy embed'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => toggleActive(f)}>
                  {f.is_active ? 'Pause' : 'Resume'}
                </Button>
                <Button variant="ghost" size="sm" className="text-danger-600 hover:bg-danger-50" onClick={() => remove(f)}>Delete</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Scoring-rules editor (migration 147). Field/op options mirror the backend
// allowlist in services/leadScoring.js — anything else is a 400 anyway.
// Writes are org-admin-gated server-side; non-admins see the 403 message.
// ---------------------------------------------------------------------------

const SCORING_FIELD_OPTIONS = [
  { key: 'source',       label: 'Source' },
  { key: 'title',        label: 'Job title' },
  { key: 'company_name', label: 'Company' },
  { key: 'has_email',    label: 'Has email' },
  { key: 'has_phone',    label: 'Has phone' },
];
const SCORING_OP_OPTIONS = [
  { key: 'eq',       label: 'equals' },
  { key: 'contains', label: 'contains' },
  { key: 'exists',   label: 'is present' },
];

function ScoringPanel() {
  const [rules, setRules] = useState(null); // null = loading
  const [draft, setDraft] = useState({ field: 'source', op: 'eq', value: '', points: 10 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const loadRules = async () => {
    try {
      const res = await api.get('/leads/scoring-rules');
      setRules(res.data);
    } catch {
      setRules([]);
    }
  };
  useEffect(() => { loadRules(); }, []);

  const addRule = async () => {
    setBusy(true); setError(null);
    try {
      await api.post('/leads/scoring-rules', {
        field: draft.field,
        op: draft.op,
        value: draft.op === 'exists' ? undefined : draft.value,
        points: Number(draft.points),
      });
      setDraft((d) => ({ ...d, value: '' }));
      loadRules();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add rule');
    } finally {
      setBusy(false);
    }
  };

  const toggleRule = async (rule) => {
    setError(null);
    try {
      await api.put(`/leads/scoring-rules/${rule.id}`, { is_active: !rule.is_active });
      loadRules();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update rule');
    }
  };

  const removeRule = async (rule) => {
    setError(null);
    try {
      await api.delete(`/leads/scoring-rules/${rule.id}`);
      loadRules();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete rule');
    }
  };

  const opLabel = (op) => (SCORING_OP_OPTIONS.find((o) => o.key === op)?.label || op);
  const fieldLabel = (f) => (SCORING_FIELD_OPTIONS.find((o) => o.key === f)?.label || f);

  return (
    <Card
      className="mb-5"
      title="Scoring rules"
      subtitle="Each matching rule adds its points to a lead's score — computed on create and kept fresh on every edit. Editing rules requires an org owner/admin."
    >
      {error && <Alert tone="danger" className="mb-3">{error}</Alert>}

      {rules === null ? (
        <Spinner size="sm" className="block mb-3" />
      ) : rules.length === 0 ? (
        <p className="text-sm text-gray-400 mb-3">No rules yet — add one below.</p>
      ) : (
        <ul className="divide-y divide-gray-100 mb-3">
          {rules.map((r) => (
            <li key={r.id} className="py-2 flex items-center justify-between gap-3 flex-wrap">
              <span className="text-sm text-gray-800">
                <span className="font-medium">{fieldLabel(r.field)}</span>{' '}
                {opLabel(r.op)}{r.op !== 'exists' && r.value ? <> <span className="font-mono text-xs bg-gray-50 px-1 rounded">{r.value}</span></> : null}
                {' → '}
                <span className={`font-semibold ${r.points >= 0 ? 'text-success-700' : 'text-danger-700'}`}>{r.points > 0 ? `+${r.points}` : r.points} pts</span>
                {!r.is_active && <StatusBadge tone="neutral" label="Paused" className="ml-2" />}
              </span>
              <span className="flex items-center gap-1 flex-shrink-0">
                <Button variant="ghost" size="sm" onClick={() => toggleRule(r)}>{r.is_active ? 'Pause' : 'Resume'}</Button>
                <Button variant="ghost" size="sm" className="text-danger-600 hover:bg-danger-50" onClick={() => removeRule(r)}>Delete</Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2 border-t border-gray-100 pt-4">
        <Select label="Field" size="sm" value={draft.field} onChange={(e) => setDraft((d) => ({ ...d, field: e.target.value }))} wrapperClassName="w-36">
          {SCORING_FIELD_OPTIONS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </Select>
        <Select label="Condition" size="sm" value={draft.op} onChange={(e) => setDraft((d) => ({ ...d, op: e.target.value }))} wrapperClassName="w-36">
          {SCORING_OP_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </Select>
        {draft.op !== 'exists' && (
          <Input
            label="Value"
            size="sm"
            value={draft.value}
            onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
            placeholder="e.g. web form"
            wrapperClassName="w-40"
          />
        )}
        <Input
          label="Points"
          size="sm"
          type="number"
          value={draft.points}
          onChange={(e) => setDraft((d) => ({ ...d, points: e.target.value }))}
          wrapperClassName="w-24"
        />
        <Button size="sm" icon="plus" onClick={addRule} loading={busy} loadingLabel="Adding…">Add rule</Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Leads() {
  const [leadsList, setLeadsList] = useState(null); // null = loading
  const [forms, setForms] = useState([]);
  const [members, setMembers] = useState([]);
  const [modal, setModal] = useState(null); // lead object ({} for new)
  const [showForms, setShowForms] = useState(false);
  const [showScoring, setShowScoring] = useState(false);
  const [sortByScore, setSortByScore] = useState(false);
  const [toast, setToast] = useState(null);
  const [gated, setGated] = useState(false);
  // Phone fallback (below md, mirrors the Deals "Focus mode" pattern): a
  // single status picked from a Select instead of five w-64 lanes.
  const [mobileStatus, setMobileStatus] = useState(null);

  // Ref-free trick not needed: load reads the current sort flag via arg.
  const load = async (byScore = sortByScore) => {
    try {
      const res = await api.get(byScore ? '/leads?sort=score' : '/leads');
      setLeadsList(res.data);
    } catch (e) {
      // A leads_enabled 403 must NOT masquerade as the friendly "no leads yet"
      // empty state — those CTAs would all 403. Show the module-off banner.
      if (e?.response?.data?.code === 'FEATURE_DISABLED') setGated(true);
      setLeadsList([]);
    }
  };
  const loadForms = async () => {
    try {
      const res = await api.get('/lead-forms');
      setForms(res.data);
    } catch {
      setForms([]);
    }
  };

  useEffect(() => {
    load(sortByScore);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortByScore]);

  useEffect(() => {
    loadForms();
    // Org members drive the owner select; org-less workspaces 404 here and
    // simply get an empty owner list.
    api.get('/org').then((r) => setMembers(r.data.members || [])).catch(() => setMembers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byStatus = useMemo(() => {
    const map = Object.fromEntries(STATUSES.map((s) => [s.id, []]));
    (leadsList || []).forEach((l) => { (map[l.status] || map.new).push(l); });
    return map;
  }, [leadsList]);

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const move = async (lead, status) => {
    // Optimistic move; reconcile on failure.
    setLeadsList((list) => list.map((l) => (l.id === lead.id ? { ...l, status } : l)));
    try {
      await api.put(`/leads/${lead.id}`, { status });
    } catch {
      load();
    }
  };

  const empty = leadsList !== null && leadsList.length === 0;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Nav active="leads" />
      <Container size="full" className="flex-1 flex flex-col overflow-x-hidden">
        <PageHeader
          className="mb-4"
          title="Leads"
          subtitle="Triage incoming interest, then convert the real ones into contacts and deals."
          actions={!gated && (
            <Button
              variant="secondary"
              icon="star"
              aria-pressed={sortByScore}
              className={sortByScore ? 'border-brand-blue text-brand-blue bg-info-50 hover:bg-info-50' : ''}
              onClick={() => setSortByScore((s) => !s)}
              title="Order the cards in each column by lead score"
            >
              {sortByScore ? 'Sorted by score' : 'Sort by score'}
            </Button>
          )}
          primaryAction={!gated ? { label: 'New lead', onClick: () => setModal({}) } : null}
          secondaryActions={!gated ? [
            { label: showScoring ? 'Hide scoring rules' : 'Scoring rules', icon: 'settings', onClick: () => setShowScoring((s) => !s) },
            { label: showForms ? 'Hide capture forms' : `Capture forms${forms.length ? ` (${forms.length})` : ''}`, icon: 'inbox', onClick: () => setShowForms((s) => !s) },
          ] : []}
        />

        {toast && (
          <Alert tone="success" className="mb-3" onDismiss={() => setToast(null)}>{toast}</Alert>
        )}

        {!gated && showScoring && <ScoringPanel />}
        {!gated && showForms && <FormsPanel forms={forms} onChanged={loadForms} />}

        {gated ? (
          <Alert tone="warning" icon="lock" title="Leads is switched off for your organization">
            An owner or admin can enable the Leads module in Admin → Feature Flags.
          </Alert>
        ) : leadsList === null ? (
          <div className="flex-1 flex items-center justify-center">
            <Spinner size="lg" />
          </div>
        ) : empty ? (
          <Card padding="none">
            <EmptyState
              icon="users"
              title="No leads yet — let's fix that"
              message="Add your first lead by hand, or create a capture form and put it on your website: every submission lands here automatically, already assigned to someone on your team."
              action={
                <div className="flex gap-2">
                  <Button variant="primary" icon="plus" onClick={() => setModal({})}>Add a lead</Button>
                  <Button variant="secondary" onClick={() => setShowForms(true)}>Create a capture form</Button>
                </div>
              }
            />
          </Card>
        ) : (
          <>
            {/* Lane board — md+ only. Five w-64 lanes are 1,300px wide, which
                forces sideways scroll a phone shouldn't have to fight. */}
            <div className="hidden md:flex md:flex-1 md:overflow-x-auto">
              <div className="flex gap-4 min-h-full pb-4">
                {STATUSES.map((stage) => (
                  <div key={stage.id} className="flex flex-col w-64 xl:w-72 flex-shrink-0">
                    <div className={`${stage.header} rounded-t px-3 py-2.5 border border-b-0 ${stage.border}`}>
                      <div className="flex justify-between items-center gap-2">
                        <span className="font-semibold text-gray-800 text-sm flex items-baseline gap-2 min-w-0">
                          <span className="truncate">{stage.label}</span>
                          <span className="font-normal text-gray-500 text-xs">{byStatus[stage.id].length}</span>
                        </span>
                        {stage.id !== 'converted' && (
                          <button
                            onClick={() => setModal({ status: stage.id })}
                            aria-label={`Add lead to ${stage.label}`}
                            title={`Add lead to ${stage.label}`}
                            className="text-gray-400 hover:text-brand-blue hover:bg-info-50 w-7 h-7 flex items-center justify-center rounded-md"
                          ><Icon name="plus" size={16} /></button>
                        )}
                      </div>
                      <div className="text-[11px] text-gray-500 mt-1 line-clamp-1" title={stage.desc}>{stage.desc}</div>
                    </div>
                    <div className={`flex-1 min-h-32 rounded-b border ${stage.border} p-2 space-y-2 ${stage.bg}`}>
                      {byStatus[stage.id].map((l) => (
                        <LeadCard key={l.id} lead={l} members={members} onClick={setModal} onMove={move} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Phone fallback (below md) — single-status selector + a
                vertical card list, mirroring Deals' Focus mode. */}
            <div className="md:hidden flex-1 overflow-y-auto pb-6">
              <div className="px-3 py-3 sticky top-0 bg-white z-10 border-b border-gray-200">
                <Select
                  label="Status"
                  value={mobileStatus || STATUSES[0].id}
                  onChange={(e) => setMobileStatus(e.target.value)}
                  aria-label="Lead status to focus on"
                  wrapperClassName="w-full max-w-md"
                >
                  {STATUSES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label} ({byStatus[s.id].length})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="px-3 pt-3 max-w-3xl mx-auto">
                {(() => {
                  const statusId = mobileStatus || STATUSES[0].id;
                  const stage = STATUSES.find((s) => s.id === statusId) || STATUSES[0];
                  const stageLeads = byStatus[statusId] || [];
                  return (
                    <>
                      <div className="flex items-center justify-between mb-3 gap-2">
                        <div className="min-w-0">
                          <h2 className="text-lg font-semibold text-gray-900 truncate">{stage.label}</h2>
                          <p className="text-xs text-gray-500 line-clamp-2">{stage.desc}</p>
                        </div>
                        {stage.id !== 'converted' && (
                          <Button size="sm" icon="plus" className="flex-shrink-0" onClick={() => setModal({ status: statusId })}>
                            Add
                          </Button>
                        )}
                      </div>
                      {stageLeads.length === 0 ? (
                        <div className="bg-white rounded-lg border border-dashed border-gray-200 p-6 text-center text-sm text-gray-400">
                          No leads in {stage.label.toLowerCase()}.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {stageLeads.map((l) => (
                            <LeadCard key={l.id} lead={l} members={members} onClick={setModal} onMove={move} />
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          </>
        )}
      </Container>

      {modal && (
        <LeadModal
          lead={modal}
          members={members}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
          onDeleted={() => { setModal(null); load(); }}
          onConverted={(result) => {
            setModal(null);
            load();
            flash(result.deal
              ? `Converted — contact and deal created. Find the deal on the Deals board.`
              : `Converted — contact created. Find them under Contacts.`);
          }}
        />
      )}
    </div>
  );
}
