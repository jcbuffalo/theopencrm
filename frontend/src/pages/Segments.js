// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { segments as segmentsApi, LIFECYCLE_STAGES, api } from '../api';
import Nav from '../components/Nav';
import { Alert, Button, Card, Container, EmptyState, Icon, Input, Modal, PageHeader, Select, Skeleton, StatusBadge } from '../components/ui';

// Segments — saved, dynamic cohorts of companies/contacts + bulk actions.
//
// The builder only offers fields/ops from the backend compiler's allowlist
// (FIELD_DEFS below mirrors services/segments.js; GET /segments/schema is the
// runtime source of truth and prunes anything the server no longer allows).
// A debounced POST /preview keeps a live "N records match" count while
// criteria are edited. Bulk actions are CONFIRM-FIRST: the dialog shows the
// exact affected-member count before anything writes, and membership is
// re-evaluated server-side at write time.

const ENTITY_LABELS = { company: 'Companies', contact: 'Contacts' };

const LIFECYCLE_LABELS = {
  prospect: 'Prospect', onboarding: 'Onboarding', active: 'Active',
  at_risk: 'At risk', renewed: 'Renewed', churned: 'Churned',
};

const OP_LABELS = {
  eq: 'is', in: 'is any of', ilike: 'contains', gt: 'more than',
};

// Client-side mirror of the backend allowlist (labels + input widgets).
// `input` drives which control renders for the value.
const FIELD_DEFS = {
  company: [
    { field: 'lifecycle_stage', label: 'Lifecycle stage', ops: ['eq', 'in'], input: 'stage' },
    { field: 'industry', label: 'Industry', ops: ['eq', 'in', 'ilike'], input: 'text' },
    { field: 'last_touch_older_than_days', label: 'Last touch older than', ops: ['gt'], input: 'days' },
  ],
  contact: [
    { field: 'owner_user_id', label: 'Owner', ops: ['eq'], input: 'owner' },
    { field: 'title', label: 'Job title', ops: ['ilike'], input: 'text' },
    { field: 'cadence_overdue', label: 'Cadence overdue (30d, no touch)', ops: ['eq'], input: 'bool' },
  ],
};

const BULK_ACTION_DEFS = {
  company: [
    { action: 'set_lifecycle_stage', label: 'Set lifecycle stage' },
    { action: 'assign_owner', label: 'Assign owner' },
    { action: 'create_task', label: 'Create a task per company' },
  ],
  contact: [
    { action: 'assign_owner', label: 'Assign owner' },
    { action: 'create_task', label: 'Create a task per contact' },
  ],
};

// Revenue plays — one-click starter segments that map a cohort to a money
// outcome. These turn a blank builder into "pick the win you want" and are the
// fastest path from opening the page to acting on revenue. Each seeds the
// builder (name + entity + criteria); the user previews the live count and
// saves. Criteria use only allowlisted fields so they always compile.
const SEGMENT_TEMPLATES = [
  {
    key: 'rescue-at-risk', icon: 'flame',
    title: 'Rescue at-risk accounts',
    outcome: 'Protect revenue before it churns',
    entity_type: 'company', name: 'At-risk accounts to rescue',
    criteria: [{ field: 'lifecycle_stage', op: 'eq', value: 'at_risk' }],
  },
  {
    key: 'winback-quiet', icon: 'refresh',
    title: 'Win back gone-quiet customers',
    outcome: 'Re-open dormant relationships',
    entity_type: 'company', name: 'Gone quiet 45+ days',
    criteria: [{ field: 'last_touch_older_than_days', op: 'gt', value: 45 }],
  },
  {
    key: 'upsell-champions', icon: 'star',
    title: 'Upsell your champions',
    outcome: 'Expansion revenue from decision-makers',
    entity_type: 'contact', name: 'Decision-maker champions',
    criteria: [{ field: 'title', op: 'ilike', value: 'director' }],
  },
  {
    key: 'activate-onboarding', icon: 'trending-up',
    title: 'Activate onboarding accounts',
    outcome: 'Speed time-to-value, cut early churn',
    entity_type: 'company', name: 'Onboarding — needs a nudge',
    criteria: [{ field: 'lifecycle_stage', op: 'eq', value: 'onboarding' }],
  },
];

function fieldDef(entityType, field) {
  return (FIELD_DEFS[entityType] || []).find((f) => f.field === field);
}

function defaultValueFor(def, op) {
  if (!def) return '';
  if (def.input === 'stage') return op === 'in' ? [] : 'at_risk';
  if (def.input === 'bool') return true;
  if (def.input === 'days') return 30;
  return op === 'in' ? [] : '';
}

// Human-readable one-liner for a criteria row (list + confirm dialog).
function describeCriterion(entityType, row) {
  const def = fieldDef(entityType, row.field);
  const label = def?.label || row.field;
  const op = OP_LABELS[row.op] || row.op;
  let v = row.value;
  if (Array.isArray(v)) v = v.map((x) => LIFECYCLE_LABELS[x] || x).join(', ');
  else if (typeof v === 'boolean') v = v ? 'yes' : 'no';
  else v = LIFECYCLE_LABELS[v] || String(v);
  const suffix = row.field === 'last_touch_older_than_days' ? ' days ago' : '';
  return `${label} ${op} ${v}${suffix}`;
}

export default function Segments() {
  const [segments, setSegments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Builder state. selectedId === null → creating a new segment.
  const [selectedId, setSelectedId] = useState(null);
  const [name, setName] = useState('');
  const [entityType, setEntityType] = useState('company');
  const [criteria, setCriteria] = useState([]);
  const [saving, setSaving] = useState(false);

  // Live preview of the criteria being edited.
  const [preview, setPreview] = useState({ count: null, error: '' });
  const previewSeq = useRef(0);

  // Members of the currently selected SAVED segment.
  const [members, setMembers] = useState({ total: 0, rows: [], loading: false });

  // Bulk action state + the confirm-first dialog.
  const [bulkAction, setBulkAction] = useState('');
  const [bulkParams, setBulkParams] = useState({});
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);

  // Org members for the assign-owner dropdown (best-effort; the input degrades
  // to a plain numeric field for personal workspaces / fetch failures).
  const [orgMembers, setOrgMembers] = useState([]);

  const loadSegments = useCallback(() => {
    segmentsApi.list()
      .then((rows) => { setSegments(Array.isArray(rows) ? rows : []); setError(''); })
      .catch((err) => setError(err.response?.data?.error || 'Failed to load segments'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadSegments(); }, [loadSegments]);
  useEffect(() => {
    api.get('/org')
      .then((r) => setOrgMembers(Array.isArray(r.data?.members) ? r.data.members : []))
      .catch(() => setOrgMembers([]));
  }, []);

  // Debounced live member-count preview for whatever is in the builder.
  useEffect(() => {
    const seq = ++previewSeq.current;
    const t = setTimeout(() => {
      segmentsApi.preview(entityType, criteria)
        .then((d) => { if (previewSeq.current === seq) setPreview({ count: d.count, error: '' }); })
        .catch((err) => {
          if (previewSeq.current === seq) {
            setPreview({ count: null, error: err.response?.data?.error || 'Preview failed' });
          }
        });
    }, 350);
    return () => clearTimeout(t);
  }, [entityType, criteria]);

  const loadMembers = useCallback((segmentId) => {
    setMembers((m) => ({ ...m, loading: true }));
    segmentsApi.members(segmentId, { limit: 50 })
      .then((d) => setMembers({ total: d.total, rows: d.members || [], loading: false }))
      .catch((err) => {
        setMembers({ total: 0, rows: [], loading: false });
        setError(err.response?.data?.error || 'Failed to load segment members');
      });
  }, []);

  const selectSegment = (seg) => {
    setSelectedId(seg.id);
    setName(seg.name);
    setEntityType(seg.entity_type);
    setCriteria(Array.isArray(seg.criteria) ? seg.criteria : []);
    setBulkAction('');
    setBulkParams({});
    setNotice('');
    loadMembers(seg.id);
  };

  const startNew = () => {
    setSelectedId(null);
    setName('');
    setEntityType('company');
    setCriteria([]);
    setMembers({ total: 0, rows: [], loading: false });
    setBulkAction('');
    setBulkParams({});
    setNotice('');
  };

  // Seed the builder from a revenue play. Leaves it unsaved (selectedId null)
  // so the user previews the live count and clicks Save — one click from a
  // blank page to a revenue-shaped cohort.
  const applyTemplate = (t) => {
    setSelectedId(null);
    setName(t.name);
    setEntityType(t.entity_type);
    setCriteria(t.criteria.map((c) => ({ ...c })));
    setMembers({ total: 0, rows: [], loading: false });
    setBulkAction('');
    setBulkParams({});
    setNotice('');
    setError('');
  };

  const onChangeEntityType = (next) => {
    setEntityType(next);
    setCriteria([]); // criteria are per-entity; a type switch resets them
    setBulkAction('');
    setBulkParams({});
  };

  const addCriterion = () => {
    const def = FIELD_DEFS[entityType][0];
    const op = def.ops[0];
    setCriteria((c) => [...c, { field: def.field, op, value: defaultValueFor(def, op) }]);
  };

  const updateCriterion = (idx, patch) => {
    setCriteria((c) => c.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  };

  const removeCriterion = (idx) => {
    setCriteria((c) => c.filter((_, i) => i !== idx));
  };

  const save = async () => {
    if (!name.trim()) { setError('Give the segment a name first.'); return; }
    setSaving(true);
    setError('');
    try {
      if (selectedId) {
        const updated = await segmentsApi.update(selectedId, { name: name.trim(), criteria });
        setSegments((rows) => rows.map((r) => (r.id === updated.id ? updated : r)));
        setNotice('Segment saved.');
        loadMembers(selectedId);
      } else {
        const created = await segmentsApi.create({ name: name.trim(), entity_type: entityType, criteria });
        setSegments((rows) => [created, ...rows]);
        setSelectedId(created.id);
        setNotice('Segment created.');
        loadMembers(created.id);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save segment');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selectedId) return;
    if (!window.confirm('Delete this segment? The companies/contacts themselves are untouched.')) return;
    try {
      await segmentsApi.remove(selectedId);
      setSegments((rows) => rows.filter((r) => r.id !== selectedId));
      startNew();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete segment');
    }
  };

  // Bulk-action param completeness — gates the Run button.
  const bulkReady = useMemo(() => {
    if (!bulkAction) return false;
    if (bulkAction === 'set_lifecycle_stage') return LIFECYCLE_STAGES.includes(bulkParams.lifecycle_stage);
    if (bulkAction === 'assign_owner') return Number(bulkParams.owner_id) > 0;
    if (bulkAction === 'create_task') return !!(bulkParams.title || '').trim();
    return false;
  }, [bulkAction, bulkParams]);

  const runBulk = async () => {
    setRunning(true);
    setError('');
    try {
      const params = bulkAction === 'assign_owner'
        ? { owner_id: Number(bulkParams.owner_id) }
        : bulkParams;
      const result = await segmentsApi.bulk(selectedId, bulkAction, params);
      setConfirming(false);
      setBulkAction('');
      setBulkParams({});
      setNotice(`Done — ${result.affected} record${result.affected === 1 ? '' : 's'} affected.`);
      loadMembers(selectedId);
    } catch (err) {
      setConfirming(false);
      setError(err.response?.data?.error || 'Bulk action failed');
    } finally {
      setRunning(false);
    }
  };

  const bulkActionLabel = (BULK_ACTION_DEFS[entityType] || []).find((a) => a.action === bulkAction)?.label || bulkAction;

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="segments" />
      <Container size="wide">
        <PageHeader
          title="Segments"
          subtitle="Group the accounts and people that move revenue — at-risk, gone quiet, ready to upsell — and act on the whole cohort in one click. Turn a list into a play."
          primaryAction={{ label: 'New segment', onClick: startNew }}
        />

        <div className="space-y-6">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}
          {notice && <Alert tone="success" onDismiss={() => setNotice('')}>{notice}</Alert>}

          {/* Revenue plays — one-click starters. Shown while building a NEW
              segment (the fastest path from a blank page to acting on revenue). */}
          {!selectedId && (
            <Card title="Start from a revenue play" subtitle="One click seeds the builder — preview, then save.">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {SEGMENT_TEMPLATES.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => applyTemplate(t)}
                    className="text-left bg-white border border-gray-200 rounded p-4 hover:border-brand-blue hover:shadow-card transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
                  >
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-info-50 text-brand-blue mb-2">
                      <Icon name={t.icon} size={16} />
                    </span>
                    <div className="font-semibold text-gray-900 text-sm">{t.title}</div>
                    <div className="text-xs text-gray-600 mt-0.5">{t.outcome}</div>
                    <div className="text-[11px] text-brand-blue font-medium mt-2 inline-flex items-center gap-1">
                      Use this play <Icon name="arrow-right" size={12} />
                    </div>
                  </button>
                ))}
              </div>
            </Card>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Saved segments */}
            <div className="lg:col-span-1">
              <Card
                padding="none"
                title="Saved segments"
                actions={<Button size="sm" variant="secondary" icon="plus" onClick={startNew}>New</Button>}
              >
                {loading ? (
                  <div className="p-4"><Skeleton lines={4} /></div>
                ) : segments.length === 0 ? (
                  <EmptyState
                    icon="filter"
                    title="No segments yet"
                    message='Build your first cohort on the right — like "active accounts we haven’t touched in 45 days" — and it stays live as your data changes.'
                  />
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {segments.map((seg) => (
                      <li key={seg.id}>
                        <button
                          type="button"
                          onClick={() => selectSegment(seg)}
                          aria-current={selectedId === seg.id ? 'true' : undefined}
                          className={`w-full text-left px-4 py-3 hover:bg-gray-50 transition ${selectedId === seg.id ? 'bg-info-50/60' : ''}`}
                        >
                          <div className="font-medium text-gray-900 text-sm">{seg.name}</div>
                          <div className="text-xs text-gray-500 mt-0.5">
                            {ENTITY_LABELS[seg.entity_type] || seg.entity_type}
                            {' · '}
                            {(seg.criteria || []).length === 0
                              ? 'all records'
                              : `${seg.criteria.length} rule${seg.criteria.length === 1 ? '' : 's'}`}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            {/* Builder + members */}
            <div className="lg:col-span-2 space-y-6">
              <Card title={selectedId ? 'Edit segment' : 'Build a segment'}>
                <div className="flex flex-wrap items-start gap-3 mb-4">
                  <Input
                    placeholder="Segment name (e.g. Gone-quiet manufacturers)"
                    aria-label="Segment name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    wrapperClassName="flex-1 min-w-[220px]"
                  />
                  <Select
                    value={entityType}
                    disabled={!!selectedId}
                    onChange={(e) => onChangeEntityType(e.target.value)}
                    aria-label="Segment entity type"
                    wrapperClassName="w-40"
                    options={[{ value: 'company', label: 'Companies' }, { value: 'contact', label: 'Contacts' }]}
                  />
                </div>

                {/* Criteria rows */}
                <div className="space-y-2">
                  {criteria.length === 0 && (
                    <p className="text-sm text-gray-500 italic">
                      No rules yet — this matches every {entityType}. Add a rule to narrow the cohort.
                    </p>
                  )}
                  {criteria.map((row, idx) => (
                    <CriterionRow
                      key={idx}
                      entityType={entityType}
                      row={row}
                      orgMembers={orgMembers}
                      onChange={(patch) => updateCriterion(idx, patch)}
                      onRemove={() => removeCriterion(idx)}
                    />
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-3 mt-4">
                  <Button variant="secondary" size="sm" icon="plus" onClick={addCriterion}>Add rule</Button>
                  <div className="flex-1" />
                  <PreviewBadge preview={preview} entityType={entityType} />
                  <Button onClick={save} loading={saving} loadingLabel="Saving…">
                    {selectedId ? 'Save changes' : 'Save segment'}
                  </Button>
                  {selectedId && (
                    <Button variant="ghost" icon="trash" className="text-danger-600 hover:bg-danger-50" onClick={remove}>Delete</Button>
                  )}
                </div>
              </Card>

              {/* Members + bulk actions (saved segments only) */}
              {selectedId && (
                <Card
                  padding="none"
                  title="Members"
                  subtitle={members.loading ? 'Loading…' : `${members.total} total${members.total > members.rows.length ? ` · showing ${members.rows.length}` : ''}`}
                  actions={
                    <div className="flex flex-wrap items-center gap-2 justify-end">
                      <Select
                        size="sm"
                        value={bulkAction}
                        onChange={(e) => { setBulkAction(e.target.value); setBulkParams({}); }}
                        aria-label="Bulk action"
                        wrapperClassName="w-44"
                      >
                        <option value="">Bulk action…</option>
                        {(BULK_ACTION_DEFS[entityType] || []).map((a) => (
                          <option key={a.action} value={a.action}>{a.label}</option>
                        ))}
                      </Select>
                      <BulkParamInputs
                        action={bulkAction}
                        params={bulkParams}
                        orgMembers={orgMembers}
                        onChange={setBulkParams}
                      />
                      {bulkAction && (
                        <Button
                          size="sm"
                          onClick={() => setConfirming(true)}
                          disabled={!bulkReady || members.total === 0}
                          className="bg-warning-600 hover:bg-warning-700 disabled:bg-warning-600/50"
                        >
                          Run…
                        </Button>
                      )}
                    </div>
                  }
                >
                  <MembersTable entityType={entityType} members={members} />
                </Card>
              )}
            </div>
          </div>
        </div>
      </Container>

      {/* Confirm-first dialog — nothing writes until this is accepted. */}
      <Modal
        open={confirming}
        onClose={() => { if (!running) setConfirming(false); }}
        title="Confirm bulk action"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={running}>Cancel</Button>
            <Button
              onClick={runBulk}
              loading={running}
              loadingLabel="Running…"
              className="bg-warning-600 hover:bg-warning-700"
            >
              {`Yes, update ${members.total} record${members.total === 1 ? '' : 's'}`}
            </Button>
          </>
        }
      >
        <p className="text-sm text-gray-600">
          <span className="font-semibold">{bulkActionLabel}</span>
          {bulkAction === 'set_lifecycle_stage' && bulkParams.lifecycle_stage && (
            <> → <span className="font-semibold">{LIFECYCLE_LABELS[bulkParams.lifecycle_stage]}</span></>
          )}
          {bulkAction === 'create_task' && bulkParams.title && (
            <> — "{bulkParams.title}"</>
          )}
        </p>
        <div className="mt-3 bg-warning-50 border border-warning-200 rounded px-4 py-3 text-sm text-warning-800">
          This will affect <span className="font-bold">{members.total}</span>{' '}
          {members.total === 1 ? entityType : `${entityType}s`} currently matching{' '}
          <span className="font-medium">"{name}"</span>. Membership is re-checked at write time.
        </div>
      </Modal>
    </div>
  );
}

// One {field, op, value} row of the builder.
function CriterionRow({ entityType, row, orgMembers, onChange, onRemove }) {
  const def = fieldDef(entityType, row.field) || FIELD_DEFS[entityType][0];

  const onFieldChange = (field) => {
    const nextDef = fieldDef(entityType, field);
    const op = nextDef.ops[0];
    onChange({ field, op, value: defaultValueFor(nextDef, op) });
  };
  const onOpChange = (op) => onChange({ op, value: defaultValueFor(def, op) });

  return (
    <div className="flex flex-wrap items-center gap-2 bg-gray-50 border border-gray-200 rounded px-3 py-2">
      <Select
        size="sm"
        value={row.field}
        onChange={(e) => onFieldChange(e.target.value)}
        aria-label="Criteria field"
        wrapperClassName="w-auto"
        options={FIELD_DEFS[entityType].map((f) => ({ value: f.field, label: f.label }))}
      />
      <Select
        size="sm"
        value={row.op}
        onChange={(e) => onOpChange(e.target.value)}
        aria-label="Criteria operator"
        wrapperClassName="w-auto"
        options={def.ops.map((op) => ({ value: op, label: OP_LABELS[op] || op }))}
      />
      <CriterionValueInput def={def} row={row} orgMembers={orgMembers} onChange={onChange} />
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove rule"
        className="ml-auto w-7 h-7 inline-flex items-center justify-center rounded-md text-gray-400 hover:text-danger-600 hover:bg-danger-50 transition"
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

function CriterionValueInput({ def, row, orgMembers, onChange }) {
  if (def.input === 'stage') {
    if (row.op === 'in') {
      const selected = Array.isArray(row.value) ? row.value : [];
      const toggle = (s) => onChange({
        value: selected.includes(s) ? selected.filter((x) => x !== s) : [...selected, s],
      });
      return (
        <div className="flex flex-wrap gap-1">
          {LIFECYCLE_STAGES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => toggle(s)}
              aria-pressed={selected.includes(s)}
              className={`text-xs px-2 py-1 rounded-full border transition ${selected.includes(s)
                ? 'bg-brand-blue text-white border-brand-blue'
                : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'}`}
            >
              {LIFECYCLE_LABELS[s]}
            </button>
          ))}
        </div>
      );
    }
    return (
      <Select
        size="sm"
        value={row.value}
        onChange={(e) => onChange({ value: e.target.value })}
        aria-label="Stage"
        wrapperClassName="w-auto"
        options={LIFECYCLE_STAGES.map((s) => ({ value: s, label: LIFECYCLE_LABELS[s] }))}
      />
    );
  }

  if (def.input === 'days') {
    return (
      <span className="flex items-center gap-1.5">
        <Input
          size="sm"
          type="number" min="1" max="3650"
          value={row.value}
          onChange={(e) => onChange({ value: e.target.value === '' ? '' : parseInt(e.target.value, 10) })}
          aria-label="Days"
          wrapperClassName="w-20"
        />
        <span className="text-sm text-gray-500">days ago</span>
      </span>
    );
  }

  if (def.input === 'bool') {
    return (
      <Select
        size="sm"
        value={row.value ? 'true' : 'false'}
        onChange={(e) => onChange({ value: e.target.value === 'true' })}
        aria-label="Yes or no"
        wrapperClassName="w-auto"
        options={[{ value: 'true', label: 'yes' }, { value: 'false', label: 'no' }]}
      />
    );
  }

  if (def.input === 'owner') {
    if (orgMembers.length > 0) {
      return (
        <Select
          size="sm"
          value={row.value || ''}
          onChange={(e) => onChange({ value: parseInt(e.target.value, 10) || '' })}
          aria-label="Owner"
          wrapperClassName="w-auto"
        >
          <option value="">Choose a teammate…</option>
          {orgMembers.map((m) => (
            <option key={m.id} value={m.id}>{m.name || m.email}</option>
          ))}
        </Select>
      );
    }
    return (
      <Input
        size="sm"
        type="number" min="1" placeholder="User id"
        value={row.value || ''}
        onChange={(e) => onChange({ value: e.target.value === '' ? '' : parseInt(e.target.value, 10) })}
        aria-label="Owner user id"
        wrapperClassName="w-28"
      />
    );
  }

  // text — for 'in' ops the value is comma-separated → array.
  if (row.op === 'in') {
    return (
      <Input
        size="sm"
        type="text"
        placeholder="Comma-separated values"
        value={Array.isArray(row.value) ? row.value.join(', ') : ''}
        onChange={(e) => onChange({ value: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
        aria-label="Values"
        wrapperClassName="flex-1 min-w-[160px]"
      />
    );
  }
  return (
    <Input
      size="sm"
      type="text"
      placeholder="Value"
      value={row.value || ''}
      onChange={(e) => onChange({ value: e.target.value })}
      aria-label="Value"
      wrapperClassName="flex-1 min-w-[140px]"
    />
  );
}

function PreviewBadge({ preview, entityType }) {
  if (preview.error) {
    return <span className="text-xs text-danger-600">{preview.error}</span>;
  }
  if (preview.count == null) {
    return <span className="text-xs text-gray-500">Counting…</span>;
  }
  return (
    <StatusBadge
      tone="info"
      size="md"
      label={<><span className="font-bold">{preview.count}</span>{' '}{preview.count === 1 ? entityType.replace(/^./, (c) => c.toUpperCase()) : `${ENTITY_LABELS[entityType].toLowerCase()}`} match</>}
    />
  );
}

// Hand-rolled (not DataTable) on purpose: it is a read-only, single-layout
// list inside a Card, and DataTable's dual desktop/mobile DOM would double
// every member name for screen readers and tests.
function MembersTable({ entityType, members }) {
  if (members.loading) {
    return <div className="p-4"><Skeleton lines={4} /></div>;
  }
  if (members.rows.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-gray-500">
        Nothing matches this segment right now — it will fill in automatically as records qualify.
      </div>
    );
  }
  return (
    // tabIndex + role/aria-label give keyboard users access to horizontally
    // scroll the member table on narrow viewports (axe: scrollable-region-focusable).
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Segment members">
      <table className="min-w-full text-sm">
        <thead>
          <tr>
            {entityType === 'company' ? (
              <>
                <Th>Company</Th><Th>Industry</Th><Th>Lifecycle</Th><Th>Status</Th>
              </>
            ) : (
              <>
                <Th>Contact</Th><Th>Email</Th><Th>Job title</Th>
              </>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {members.rows.map((m) => (
            <tr key={m.id} className="hover:bg-gray-50 transition-colors">
              {entityType === 'company' ? (
                <>
                  <td className="px-4 py-3 font-medium text-gray-900">{m.name}</td>
                  <td className="px-4 py-3 text-gray-700">{m.industry || '—'}</td>
                  <td className="px-4 py-3 text-gray-700">{LIFECYCLE_LABELS[m.lifecycle_stage] || m.lifecycle_stage || '—'}</td>
                  <td className="px-4 py-3 text-gray-700">{m.status || '—'}</td>
                </>
              ) : (
                <>
                  <td className="px-4 py-3 font-medium text-gray-900">{`${m.first_name || ''} ${m.last_name || ''}`.trim() || '—'}</td>
                  <td className="px-4 py-3 text-gray-700">{m.email || '—'}</td>
                  <td className="px-4 py-3 text-gray-700">{m.job_title || '—'}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Inline inputs for the chosen bulk action's parameters.
function BulkParamInputs({ action, params, orgMembers, onChange }) {
  if (!action) return null;

  if (action === 'set_lifecycle_stage') {
    return (
      <Select
        size="sm"
        value={params.lifecycle_stage || ''}
        onChange={(e) => onChange({ lifecycle_stage: e.target.value })}
        aria-label="New lifecycle stage"
        wrapperClassName="w-40"
      >
        <option value="">New stage…</option>
        {LIFECYCLE_STAGES.map((s) => <option key={s} value={s}>{LIFECYCLE_LABELS[s]}</option>)}
      </Select>
    );
  }

  if (action === 'assign_owner') {
    if (orgMembers.length > 0) {
      return (
        <Select
          size="sm"
          value={params.owner_id || ''}
          onChange={(e) => onChange({ owner_id: e.target.value })}
          aria-label="New owner"
          wrapperClassName="w-44"
        >
          <option value="">New owner…</option>
          {orgMembers.map((m) => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
        </Select>
      );
    }
    return (
      <Input
        size="sm"
        type="number" min="1" placeholder="Owner user id"
        value={params.owner_id || ''}
        onChange={(e) => onChange({ owner_id: e.target.value })}
        aria-label="New owner user id"
        wrapperClassName="w-32"
      />
    );
  }

  // create_task
  return (
    <span className="flex items-center gap-2">
      <Input
        size="sm"
        type="text" placeholder="Task title"
        value={params.title || ''}
        onChange={(e) => onChange({ ...params, title: e.target.value })}
        aria-label="Task title"
        wrapperClassName="w-44"
      />
      <Input
        size="sm"
        type="date"
        value={params.due_date || ''}
        onChange={(e) => onChange({ ...params, due_date: e.target.value })}
        aria-label="Task due date"
        wrapperClassName="w-40"
      />
    </span>
  );
}

function Th({ children }) {
  return (
    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 bg-gray-50 border-b border-gray-200 whitespace-nowrap">
      {children}
    </th>
  );
}
