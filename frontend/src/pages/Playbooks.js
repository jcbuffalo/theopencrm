// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { playbooks as playbooksApi, LIFECYCLE_STAGES } from '../api';
import Nav from '../components/Nav';
import { useAuth } from '../AuthContext';
import { Alert, Button, Card, Container, EmptyState, Icon, Input, PageHeader, Select, Skeleton, StatusBadge } from '../components/ui';

// Success Playbooks — the "what happens next" layer on top of the account
// lifecycle AND the deal pipeline (migration 158). Each playbook watches one
// stage — either an account lifecycle stage or a deal pipeline stage
// (optionally filtered to one pipeline / deal_type); when a record enters it,
// the playbook spawns its checklist as real tasks (due today + each step's
// offset), at most once per record. This page is the template editor: list /
// create / edit playbooks and their ordered steps.
//
// Visual language mirrors Accounts.js / Retention.js: gray-50 canvas, white
// cards, lifecycle stages as StatusBadge pills (same tone map as the Accounts
// lifecycle select).

const LIFECYCLE_META = {
  prospect:   { label: 'Prospect',   tone: 'neutral' },
  onboarding: { label: 'Onboarding', tone: 'info'    },
  active:     { label: 'Active',     tone: 'success' },
  at_risk:    { label: 'At risk',    tone: 'error'   },
  renewed:    { label: 'Renewed',    tone: 'success' },
  churned:    { label: 'Churned',    tone: 'neutral' },
};

function StageBadge({ stage }) {
  const meta = LIFECYCLE_META[stage] || { label: stage, tone: 'neutral' };
  return <StatusBadge tone={meta.tone} label={meta.label} />;
}

// Every pipeline of the org as [{ dealType, label, stages }] — from the
// /auth/me registry (AuthContext). Falls back to a single default entry (or
// none, when the backend predates pipelines — the editor then degrades to a
// free-text stage input).
function usePipelineOptions() {
  const { orgPipeline, orgPipelines } = useAuth();
  return useMemo(() => {
    const map = orgPipelines || (orgPipeline ? { default: orgPipeline } : {});
    return Object.entries(map)
      .filter(([, p]) => p && Array.isArray(p.stages) && p.stages.length > 0)
      .map(([dealType, p]) => ({
        dealType,
        label: dealType === 'default' ? 'Default pipeline' : `${dealType} pipeline`,
        stages: p.stages,
      }));
  }, [orgPipeline, orgPipelines]);
}

// Resolve a deal-stage id to its human label across the org's pipelines.
function dealStageLabel(pipelines, stageId) {
  for (const p of pipelines) {
    const st = p.stages.find((s) => s.id === stageId);
    if (st) return st.label || stageId;
  }
  return stageId;
}

const EMPTY_STEP = { title: '', description: '', offset_days: 0 };

// Small square icon button for the step-reorder / remove controls.
function StepControl({ icon, label, onClick, disabled, danger }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`w-7 h-7 inline-flex items-center justify-center rounded-md disabled:opacity-30 ${danger ? 'text-gray-400 hover:text-danger-600 hover:bg-danger-50' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-100'}`}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

// The create/edit form — a name + trigger stage + an ordered step builder.
// Used for both "new playbook" (playbook == null) and editing an existing one.
function PlaybookEditor({ playbook, onSaved, onCancel }) {
  const isEdit = !!playbook;
  const pipelines = usePipelineOptions();
  const [name, setName] = useState(playbook?.name || '');
  const [triggerKind, setTriggerKind] = useState(playbook?.trigger_kind === 'deal_stage' ? 'deal_stage' : 'lifecycle_stage');
  const [triggerStage, setTriggerStage] = useState(
    playbook?.trigger_kind === 'deal_stage' ? 'onboarding' : (playbook?.trigger_stage || 'onboarding')
  );
  // 'any' = no deal_type filter (fires for deals of every pipeline).
  const [dealType, setDealType] = useState(playbook?.trigger_deal_type || 'any');
  const [dealStage, setDealStage] = useState(playbook?.trigger_kind === 'deal_stage' ? (playbook?.trigger_stage || '') : '');
  const [isActive, setIsActive] = useState(playbook ? !!playbook.is_active : true);

  // Stage options for the deal-stage picker, sourced from the org's
  // pipeline(s): the selected pipeline's stages, or the de-duplicated union
  // across all pipelines when no type filter is chosen.
  const dealStageOptions = useMemo(() => {
    const scoped = dealType === 'any' ? pipelines : pipelines.filter((p) => p.dealType === dealType);
    const seen = new Set();
    const opts = [];
    for (const p of scoped) {
      for (const st of p.stages) {
        if (seen.has(st.id)) continue;
        seen.add(st.id);
        const hint = dealType === 'any' && pipelines.length > 1 ? ` (${p.label})` : '';
        opts.push({ value: st.id, label: `${st.label || st.id}${hint}` });
      }
    }
    return opts;
  }, [pipelines, dealType]);
  const [steps, setSteps] = useState(
    playbook?.steps?.length
      ? playbook.steps.map((s) => ({ id: s.id, title: s.title, description: s.description || '', offset_days: s.offset_days || 0 }))
      : [{ ...EMPTY_STEP }]
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setStep = (i, patch) => setSteps((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeStep = (i) => setSteps((rows) => rows.filter((_, idx) => idx !== i));
  const moveStep = (i, dir) => setSteps((rows) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return rows;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const save = async () => {
    setError('');
    if (!name.trim()) { setError('Give the playbook a name.'); return; }
    if (triggerKind === 'deal_stage' && !String(dealStage).trim()) {
      setError('Pick the pipeline stage that should fire this playbook.');
      return;
    }
    const trigger = triggerKind === 'deal_stage'
      ? {
          trigger_kind: 'deal_stage',
          trigger_stage: String(dealStage).trim(),
          trigger_deal_type: dealType === 'any' ? null : dealType,
        }
      : { trigger_kind: 'lifecycle_stage', trigger_stage: triggerStage, trigger_deal_type: null };
    const cleanSteps = steps
      .filter((s) => s.title.trim())
      .map((s, i) => ({
        title: s.title.trim(),
        description: s.description.trim() || undefined,
        offset_days: Math.max(0, parseInt(s.offset_days, 10) || 0),
        sort_order: i,
        id: s.id,
      }));
    if (cleanSteps.length === 0) { setError('Add at least one step with a title.'); return; }

    setSaving(true);
    try {
      if (!isEdit) {
        await playbooksApi.create({
          name: name.trim(),
          ...trigger,
          is_active: isActive,
          steps: cleanSteps.map(({ id, ...s }) => s),
        });
      } else {
        // Update header, then reconcile steps: simplest correct strategy is
        // update/keep existing rows and add/remove the diff.
        await playbooksApi.update(playbook.id, { name: name.trim(), ...trigger, is_active: isActive });
        const keptIds = new Set(cleanSteps.filter((s) => s.id).map((s) => s.id));
        for (const old of playbook.steps || []) {
          if (!keptIds.has(old.id)) await playbooksApi.removeStep(playbook.id, old.id);
        }
        for (const s of cleanSteps) {
          const payload = { title: s.title, description: s.description, offset_days: s.offset_days, sort_order: s.sort_order };
          if (s.id) await playbooksApi.updateStep(playbook.id, s.id, payload);
          else await playbooksApi.addStep(playbook.id, payload);
        }
      }
      onSaved();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save playbook.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={isEdit ? 'Edit playbook' : 'New playbook'} subtitle="Each step becomes a task when a record enters the trigger stage.">
      <div className="space-y-5">
        {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Input
            label="Name"
            wrapperClassName="sm:col-span-2"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. New customer onboarding"
            autoFocus
          />
          <Select
            label="Trigger"
            value={triggerKind}
            onChange={(e) => setTriggerKind(e.target.value)}
            options={[
              { value: 'lifecycle_stage', label: 'Account enters a lifecycle stage' },
              { value: 'deal_stage', label: 'Deal enters a pipeline stage' },
            ]}
          />
          {triggerKind === 'lifecycle_stage' && (
            <Select
              label="When account enters"
              value={triggerStage}
              onChange={(e) => setTriggerStage(e.target.value)}
              options={LIFECYCLE_STAGES.map((s) => ({ value: s, label: LIFECYCLE_META[s]?.label || s }))}
            />
          )}
          {triggerKind === 'deal_stage' && pipelines.length > 1 && (
            <Select
              label="Pipeline"
              value={dealType}
              onChange={(e) => { setDealType(e.target.value); setDealStage(''); }}
              options={[{ value: 'any', label: 'Any pipeline' }, ...pipelines.map((p) => ({ value: p.dealType, label: p.label }))]}
            />
          )}
          {triggerKind === 'deal_stage' && (
            dealStageOptions.length > 0 ? (
              <Select
                label="When deal enters"
                value={dealStage}
                onChange={(e) => setDealStage(e.target.value)}
                options={[{ value: '', label: 'Pick a stage…' }, ...dealStageOptions]}
              />
            ) : (
              <Input
                label="When deal enters (stage id)"
                value={dealStage}
                onChange={(e) => setDealStage(e.target.value)}
                placeholder="e.g. closed_won"
              />
            )
          )}
        </div>

        <div>
          <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
            <span className="block text-sm font-medium text-gray-700">Steps (become tasks, in order)</span>
            <span className="text-xs text-gray-500">Due date = day the account enters the stage + offset</span>
          </div>
          <div className="space-y-2">
            {steps.map((s, i) => (
              <div key={s.id ?? `new-${i}`} className="flex flex-col sm:flex-row gap-2 items-start bg-gray-50 border border-gray-200 rounded p-3">
                <div className="flex sm:flex-col gap-0.5">
                  <StepControl icon="chevron-up" label="Move step up" onClick={() => moveStep(i, -1)} disabled={i === 0} />
                  <StepControl icon="chevron-down" label="Move step down" onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} />
                </div>
                <div className="flex-1 w-full space-y-2">
                  <Input
                    size="sm"
                    value={s.title}
                    onChange={(e) => setStep(i, { title: e.target.value })}
                    placeholder={`Step ${i + 1} — e.g. Send welcome email`}
                    aria-label={`Step ${i + 1} title`}
                  />
                  <Input
                    size="sm"
                    value={s.description}
                    onChange={(e) => setStep(i, { description: e.target.value })}
                    placeholder="Details (optional)"
                    aria-label={`Step ${i + 1} details`}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 whitespace-nowrap">Day +</span>
                  <Input
                    type="number"
                    size="sm"
                    min="0"
                    max="365"
                    value={s.offset_days}
                    onChange={(e) => setStep(i, { offset_days: e.target.value })}
                    wrapperClassName="w-20"
                    aria-label="Due-date offset in days"
                  />
                  <StepControl icon="x" label="Remove step" onClick={() => removeStep(i)} danger />
                </div>
              </div>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon="plus"
            className="mt-2 text-brand-blue"
            onClick={() => setSteps((rows) => [...rows, { ...EMPTY_STEP }])}
          >
            Add step
          </Button>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-100 pt-4 flex-wrap">
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue" />
            Active — fires automatically on stage changes
          </label>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onCancel}>Cancel</Button>
            <Button onClick={save} loading={saving} loadingLabel="Saving…">
              {isEdit ? 'Save changes' : 'Create playbook'}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

export default function Playbooks() {
  const pipelines = usePipelineOptions();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // null = closed, 'new' = create form, or the full playbook (with steps) being edited.
  const [editing, setEditing] = useState(null);
  const [togglingIds, setTogglingIds] = useState(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await playbooksApi.list();
      setRows(data.playbooks || []);
    } catch (e) {
      const status = e?.response?.status;
      if (status === 403) setError('Customer Success isn’t enabled for this workspace. An admin can turn it on under Feature Flags.');
      else setError('Could not load playbooks. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const startEdit = async (id) => {
    try {
      const full = await playbooksApi.get(id);
      setEditing(full);
    } catch {
      setError('Could not open that playbook for editing.');
    }
  };

  const toggleActive = async (pb) => {
    setTogglingIds((s) => new Set(s).add(pb.id));
    const prev = pb.is_active;
    setRows((r) => r.map((x) => (x.id === pb.id ? { ...x, is_active: !prev } : x)));
    try {
      await playbooksApi.update(pb.id, { is_active: !prev });
    } catch (e) {
      setRows((r) => r.map((x) => (x.id === pb.id ? { ...x, is_active: prev } : x)));
      setError(e.response?.data?.error || 'Failed to update playbook.');
    } finally {
      setTogglingIds((s) => { const n = new Set(s); n.delete(pb.id); return n; });
    }
  };

  const remove = async (pb) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete “${pb.name}”? Its steps go with it; tasks it already created stay.`)) return;
    try {
      await playbooksApi.remove(pb.id);
      setRows((r) => r.filter((x) => x.id !== pb.id));
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to delete playbook.');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="playbooks" />
      <Container>
        <PageHeader
          title="Success playbooks"
          subtitle="When an account enters a lifecycle stage, its playbook spawns a task checklist — so onboarding, saves, and renewals actually run."
          primaryAction={!editing ? { label: 'New playbook', onClick: () => setEditing('new') } : undefined}
        />

        <div className="space-y-6">
          {error && <Alert tone="warning" onDismiss={() => setError('')}>{error}</Alert>}

          {editing && (
            <PlaybookEditor
              playbook={editing === 'new' ? null : editing}
              onSaved={() => { setEditing(null); load(); }}
              onCancel={() => setEditing(null)}
            />
          )}

          {loading && (
            <Card><Skeleton lines={5} /></Card>
          )}

          {!loading && !error && rows.length === 0 && !editing && (
            <Card padding="none">
              <EmptyState
                icon="check-circle"
                title="No playbooks yet"
                message="Turn your customer-success motion into muscle memory. Create a playbook — say, a 5-step onboarding checklist — and every account that enters that stage gets its tasks spawned automatically."
                action={<Button icon="plus" onClick={() => setEditing('new')}>Create your first playbook</Button>}
              />
            </Card>
          )}

          {!loading && rows.length > 0 && (
            <div className="space-y-3">
              {rows.map((pb) => (
                <Card key={pb.id} padding="sm" className={pb.is_active ? '' : 'opacity-60'}>
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-sm font-semibold text-gray-900 truncate">{pb.name}</h3>
                        {!pb.is_active && <StatusBadge tone="neutral" label="Paused" />}
                      </div>
                      <div className="flex items-center gap-2 mt-1.5 text-xs text-gray-500 flex-wrap">
                        {pb.trigger_kind === 'deal_stage' ? (
                          <>
                            <span>Fires when a{pb.trigger_deal_type ? ` “${pb.trigger_deal_type}”` : ''} deal enters</span>
                            <StatusBadge tone="info" label={dealStageLabel(pipelines, pb.trigger_stage)} />
                          </>
                        ) : (
                          <>
                            <span>Fires when an account enters</span>
                            <StageBadge stage={pb.trigger_stage} />
                          </>
                        )}
                        <span className="text-gray-300">·</span>
                        <span>{pb.step_count || 0} step{pb.step_count === 1 ? '' : 's'}</span>
                        <span className="text-gray-300">·</span>
                        <span>run for {pb.run_count || 0} {pb.trigger_kind === 'deal_stage' ? 'deal' : 'account'}{pb.run_count === 1 ? '' : 's'}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Button variant="secondary" size="sm" onClick={() => toggleActive(pb)} disabled={togglingIds.has(pb.id)}>
                        {pb.is_active ? 'Pause' : 'Resume'}
                      </Button>
                      <Button variant="secondary" size="sm" icon="edit" onClick={() => startEdit(pb.id)}>Edit</Button>
                      <Button variant="ghost" size="sm" icon="trash" className="text-danger-600 hover:bg-danger-50" onClick={() => remove(pb)}>Delete</Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </Container>
    </div>
  );
}
