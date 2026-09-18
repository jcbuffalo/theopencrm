// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// /settings/pipeline — per-org editable pipeline stages (migration 155;
// multiple pipelines per org via deal_type, spec 201).
//
// The org's EFFECTIVE pipeline comes from GET /api/pipelines (custom row or
// profile default); ?deal_type= addresses one of the org's other pipelines.
// Owners/admins reorder, rename, recolor, mark won/lost, add and remove
// stages, then Save (PUT /api/pipelines) or Reset to the profile default
// (POST /api/pipelines/reset). A selector switches between pipelines when
// more than one exists; "New pipeline" creates a second one (name + deal-
// type slug + start-from template) and a type pipeline can be deleted, with
// its deals re-typed onto the default board. Members see it all read-only.
//
// Deals are never orphaned: removing a stage that still holds deals (or a
// stray stage that has deals but isn't on the board) asks where those deals
// go, and the server moves them in the same save.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import Nav from '../components/Nav';
import { useAuth } from '../AuthContext';
import { TONES, toneClasses, getStageConfig } from '../stages';
import {
  Alert, Button, Card, Container, Icon, Input, Modal, PageHeader, Select, Skeleton, StatusBadge,
} from '../components/ui';

const MAX_LABEL = 40;
const PHASE_OPTIONS = [
  { value: 'pre_sale', label: 'Pre-Sale' },
  { value: 'post_sale', label: 'Post-Sale' },
  { value: 'post_ship', label: 'Post-Shipment' },
];

function slugify(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([^a-z])/, 's_$1')
    .slice(0, 40) || 'stage';
}

function uniqueSlug(base, taken) {
  let slug = base;
  let n = 2;
  const lower = new Set(taken.map(s => s.toLowerCase()));
  while (lower.has(slug.toLowerCase())) slug = `${base}_${n++}`;
  return slug;
}

function normalize(stages) {
  return (stages || []).map(st => ({
    id: st.id,
    label: st.label || '',
    desc: st.desc || '',
    tone: st.tone || 'gray',
    phase: st.phase || null,
    is_won: !!st.is_won,
    is_lost: !!st.is_lost,
    probability: st.probability ?? null,
  }));
}

function stripForSave(stages) {
  return stages.map(({ isNew, ...st }) => st);
}

// Client-side mirror of services/pipelines.validateStages — the server is
// authoritative; this just keeps the Save button honest.
function validate(stages, maxStages) {
  const errors = [];
  if (!stages.length) errors.push('Add at least one stage.');
  if (maxStages && stages.length > maxStages) errors.push(`At most ${maxStages} stages are allowed.`);
  const seen = new Set();
  stages.forEach((st, i) => {
    const label = st.label.trim();
    if (!label) errors.push(`Stage ${i + 1} needs a name.`);
    else if (label.length > MAX_LABEL) errors.push(`"${label.slice(0, 20)}…" is longer than ${MAX_LABEL} characters.`);
    const key = st.id.toLowerCase();
    if (seen.has(key)) errors.push(`Two stages share the id "${st.id}".`);
    seen.add(key);
    if (st.is_won && st.is_lost) errors.push(`"${label || st.id}" cannot be both won and lost.`);
  });
  if (stages.length && !stages.some(st => st.is_won)) errors.push('Mark at least one stage as Won.');
  if (stages.length && !stages.some(st => st.is_lost)) errors.push('Mark at least one stage as Lost.');
  return errors;
}

function Swatch({ tone, className = '' }) {
  return <span aria-hidden="true" className={`inline-block h-3.5 w-3.5 rounded-full ${toneClasses(tone).swatch} ${className}`} />;
}

function TonePicker({ value, onChange, disabled }) {
  return (
    <div role="radiogroup" aria-label="Stage color" className="flex flex-wrap gap-1.5">
      {TONES.map(t => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={value === t}
          aria-label={t}
          title={t}
          disabled={disabled}
          onClick={() => onChange(t)}
          className={`h-6 w-6 rounded-full border-2 ${toneClasses(t).swatch} ${value === t ? 'border-gray-900 ring-2 ring-brand-blue/30' : 'border-white'} shadow-sm disabled:opacity-50`}
        />
      ))}
    </div>
  );
}

function PreviewStrip({ stages, phases }) {
  const groups = phases && phases.length > 1 ? phases : [{ id: 'all', label: null, stages }];
  return (
    <div className="overflow-x-auto">
      <div className="flex items-start gap-4 min-w-max py-1">
        {groups.map(g => (
          <div key={g.id} className="flex flex-col gap-1.5">
            {g.label && <div className="text-xs uppercase tracking-wider text-gray-500">{g.label}</div>}
            <div className="flex items-center gap-1.5">
              {g.stages.map((st, i) => {
                const c = toneClasses(st.tone);
                return (
                  <React.Fragment key={st.id}>
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium text-gray-800 ${c.header} ${c.border}`}>
                      {st.label || 'Untitled'}
                      {st.is_won && <Icon name="check" size={12} />}
                      {st.is_lost && <Icon name="x" size={12} />}
                    </span>
                    {i < g.stages.length - 1 && <Icon name="chevron-right" size={12} className="text-gray-300" />}
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StageRow({ stage, index, count, total, canEdit, showPhase, paletteOpen, onTogglePalette, onChange, onMove, onRemove }) {
  const c = toneClasses(stage.tone);
  return (
    <li className={`rounded border ${c.border} bg-white`}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <div className="flex flex-col">
          <button
            type="button"
            aria-label={`Move ${stage.label || 'stage'} up`}
            disabled={!canEdit || index === 0}
            onClick={() => onMove(index, index - 1)}
            className="rounded p-0.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
          >
            <Icon name="chevron-up" size={14} />
          </button>
          <button
            type="button"
            aria-label={`Move ${stage.label || 'stage'} down`}
            disabled={!canEdit || index === total - 1}
            onClick={() => onMove(index, index + 1)}
            className="rounded p-0.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
          >
            <Icon name="chevron-down" size={14} />
          </button>
        </div>
        <span className="w-6 text-center text-xs tabular-nums text-gray-400">{index + 1}</span>
        <button
          type="button"
          aria-label={`Color: ${stage.tone}`}
          aria-expanded={paletteOpen}
          disabled={!canEdit}
          onClick={onTogglePalette}
          className={`h-7 w-7 rounded-full ${c.swatch} border-2 border-white shadow-sm ring-1 ring-gray-200 disabled:opacity-60`}
        />
        <div className="min-w-[10rem] flex-1">
          <Input
            aria-label={`Stage ${index + 1} name`}
            size="sm"
            value={stage.label}
            maxLength={MAX_LABEL}
            disabled={!canEdit}
            onChange={e => onChange({ label: e.target.value })}
            placeholder="Stage name"
          />
          <div className="mt-0.5 font-mono text-[11px] text-gray-500">{stage.id}</div>
        </div>
        {showPhase && (
          <Select
            aria-label={`Stage ${index + 1} phase`}
            size="sm"
            wrapperClassName="w-36"
            value={stage.phase || 'pre_sale'}
            disabled={!canEdit}
            onChange={e => onChange({ phase: e.target.value })}
            options={PHASE_OPTIONS}
          />
        )}
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={stage.is_won ? 'primary' : 'secondary'}
            aria-pressed={stage.is_won}
            disabled={!canEdit}
            onClick={() => onChange({ is_won: !stage.is_won, is_lost: stage.is_won ? stage.is_lost : false })}
          >
            Won
          </Button>
          <Button
            size="sm"
            variant={stage.is_lost ? 'danger' : 'secondary'}
            aria-pressed={stage.is_lost}
            disabled={!canEdit}
            onClick={() => onChange({ is_lost: !stage.is_lost, is_won: stage.is_lost ? stage.is_won : false })}
          >
            Lost
          </Button>
        </div>
        <StatusBadge tone={count ? 'info' : 'neutral'} label={`${count || 0} deal${count === 1 ? '' : 's'}`} />
        {canEdit && (
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            aria-label={`Remove ${stage.label || 'stage'}`}
            onClick={() => onRemove(index)}
          />
        )}
      </div>
      {paletteOpen && canEdit && (
        <div className="border-t border-gray-100 px-3 py-2">
          <TonePicker value={stage.tone} onChange={tone => { onChange({ tone }); onTogglePalette(); }} />
        </div>
      )}
    </li>
  );
}

export default function PipelineSettings() {
  const { user, orgProfile, orgRole, isAdmin, refreshPipeline } = useAuth();
  const [data, setData] = useState(null);
  const [stages, setStages] = useState([]);
  // { [staleStageId]: { count, to } } — stages whose deals must be re-homed
  // before Save: removed stages with deals + strays not on the board.
  const [moves, setMoves] = useState({});
  const [paletteFor, setPaletteFor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [resetOpen, setResetOpen] = useState(false);
  const [resetMoves, setResetMoves] = useState({});
  // Multiple pipelines (spec 201): which of the org's pipelines is being
  // edited ('default' = the main one), plus the create + delete flows.
  const [dealType, setDealType] = useState('default');
  const [newOpen, setNewOpen] = useState(false);
  const [newForm, setNewForm] = useState({ name: '', slug: '', slugTouched: false, from: 'default' });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteMoves, setDeleteMoves] = useState({});

  const roleCanEdit = orgRole === 'owner' || orgRole === 'admin' || isAdmin;
  const canEdit = data ? !!data.can_edit : roleCanEdit;
  const hasOrg = !!user?.org_id;
  const isTypePipeline = dealType !== 'default';

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = dealType === 'default'
        ? await api.get('/pipelines')
        : await api.get('/pipelines', { params: { deal_type: dealType } });
      const p = r.data || {};
      setData(p);
      const next = normalize(p.stages);
      setStages(next);
      // Strays: deals sitting in a stage that is not on the effective pipeline.
      const onBoard = new Set(next.map(st => st.id));
      const strays = {};
      Object.entries(p.deal_counts || {}).forEach(([stage, n]) => {
        if (n > 0 && !onBoard.has(stage)) strays[stage] = { count: n, to: '' };
      });
      setMoves(strays);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to load the pipeline.');
    } finally {
      setLoading(false);
    }
  }, [dealType]);

  useEffect(() => { load(); }, [load]);

  const counts = data?.deal_counts || {};
  const showPhase = (data?.profile || orgProfile) === 'zang';
  const maxStages = data?.max_stages || 15;
  const errors = useMemo(() => validate(stages, maxStages), [stages, maxStages]);
  const unresolvedMoves = Object.entries(moves).filter(([, m]) => !m.to);
  const dirty = useMemo(() => {
    if (!data) return false;
    const before = JSON.stringify(normalize(data.stages));
    return before !== JSON.stringify(stripForSave(stages)) || Object.keys(moves).length > 0;
  }, [data, stages, moves]);

  const update = (index, patch) => {
    setStages(prev => prev.map((st, i) => {
      if (i !== index) return st;
      const next = { ...st, ...patch };
      // New (unsaved) stages keep their id in step with the name until saved.
      if (st.isNew && patch.label !== undefined) {
        const taken = prev.filter((_, j) => j !== index).map(x => x.id);
        next.id = uniqueSlug(slugify(patch.label) || 'stage', taken);
      }
      return next;
    }));
  };

  const move = (from, to) => {
    if (to < 0 || to >= stages.length) return;
    setStages(prev => {
      const next = prev.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const addStage = () => {
    setStages(prev => {
      const taken = prev.map(st => st.id);
      const last = prev[prev.length - 1];
      return [...prev, {
        id: uniqueSlug('new_stage', taken),
        label: '',
        desc: '',
        tone: 'gray',
        phase: showPhase ? (last?.phase || 'pre_sale') : null,
        is_won: false,
        is_lost: false,
        probability: null,
        isNew: true,
      }];
    });
  };

  const remove = (index) => {
    const st = stages[index];
    setStages(prev => prev.filter((_, i) => i !== index));
    const n = counts[st.id] || 0;
    if (n > 0 && !st.isNew) setMoves(prev => ({ ...prev, [st.id]: { count: n, to: '' } }));
    if (paletteFor === index) setPaletteFor(null);
  };

  const restore = (stageId) => {
    // Bring a removed stage back (from the original list) instead of moving its deals.
    const original = normalize(data?.stages).find(st => st.id === stageId);
    if (original) setStages(prev => [...prev, original]);
    setMoves(prev => { const next = { ...prev }; delete next[stageId]; return next; });
  };

  const save = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const moveDealsTo = {};
      Object.entries(moves).forEach(([from, m]) => { if (m.to) moveDealsTo[from] = m.to; });
      const r = await api.put('/pipelines', {
        stages: stripForSave(stages),
        ...(Object.keys(moveDealsTo).length ? { moveDealsTo } : {}),
        ...(isTypePipeline ? { deal_type: dealType } : {}),
      });
      const moved = r.data?.moved || [];
      await refreshPipeline?.();
      await load();
      setNotice(
        moved.length
          ? `Pipeline saved. Moved ${moved.reduce((a, m) => a + (m.count || 0), 0)} deal(s) to their new stage.`
          : 'Pipeline saved. The deal board now uses these stages.'
      );
    } catch (err) {
      const body = err?.response?.data || {};
      if (body.error === 'stages_have_deals' && Array.isArray(body.stages_with_deals)) {
        setMoves(prev => {
          const next = { ...prev };
          body.stages_with_deals.forEach(s => { if (!next[s.stage]) next[s.stage] = { count: s.count, to: '' }; });
          return next;
        });
        setError('Some deals sit in stages that are being removed. Choose where they go below, then save again.');
      } else if (Array.isArray(body.validation_errors)) {
        setError(body.validation_errors.join(' '));
      } else {
        setError(body.error || 'Failed to save the pipeline.');
      }
    } finally {
      setSaving(false);
    }
  };

  const openReset = () => {
    // Deals in stages the profile default lacks need a destination.
    const defaults = new Set((data?.default_stages || []).map(st => st.id));
    const need = {};
    Object.entries(counts).forEach(([stage, n]) => { if (n > 0 && !defaults.has(stage)) need[stage] = { count: n, to: '' }; });
    setResetMoves(need);
    setResetOpen(true);
  };

  const doReset = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const moveDealsTo = {};
      Object.entries(resetMoves).forEach(([from, m]) => { if (m.to) moveDealsTo[from] = m.to; });
      await api.post('/pipelines/reset', Object.keys(moveDealsTo).length ? { moveDealsTo } : {});
      setResetOpen(false);
      await refreshPipeline?.();
      await load();
      setNotice('Pipeline reset to the default stages.');
    } catch (err) {
      const body = err?.response?.data || {};
      setError(body.message || body.error || 'Failed to reset the pipeline.');
    } finally {
      setSaving(false);
    }
  };

  const stageOptions = stages.filter(st => st.label.trim()).map(st => ({ value: st.id, label: st.label }));
  const defaultOptions = (data?.default_stages || []).map(st => ({ value: st.id, label: st.label }));
  const resetUnresolved = Object.values(resetMoves).some(m => !m.to);

  // ---- Multiple pipelines (spec 201) --------------------------------------
  const pipelinesList = data?.pipelines || [];
  const SLUG_OK = /^[a-z][a-z0-9_]{0,39}$/;
  const takenTypes = new Set(pipelinesList.map(p => p.deal_type));
  const newSlug = newForm.slug.trim();
  const newSlugError = !newSlug ? '' :
    !SLUG_OK.test(newSlug) ? 'Slug must be lowercase letters, digits, or _ and start with a letter.' :
    newSlug === 'default' ? '"default" is the main pipeline.' :
    takenTypes.has(newSlug) ? 'That deal type already has a pipeline.' : '';
  const canCreate = !!newForm.name.trim() && !!newSlug && !newSlugError;

  const openNew = () => {
    setNewForm({ name: '', slug: '', slugTouched: false, from: 'default' });
    setNewOpen(true);
  };

  const doCreate = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const template = newForm.from === 'current'
        ? stripForSave(normalize(data?.stages))
        : normalize(data?.default_stages);
      await api.put('/pipelines', { stages: template, deal_type: newSlug, name: newForm.name.trim() });
      setNewOpen(false);
      await refreshPipeline?.();
      setDealType(newSlug); // triggers a reload of the new pipeline
      setNotice(`Pipeline "${newForm.name.trim()}" created. Deals with type "${newSlug}" now use these stages.`);
    } catch (err) {
      const body = err?.response?.data || {};
      setError((Array.isArray(body.validation_errors) && body.validation_errors.join(' ')) || body.error || 'Failed to create the pipeline.');
    } finally {
      setSaving(false);
    }
  };

  // Deleting a type pipeline re-types its deals onto the DEFAULT board;
  // deals in stages the default board lacks need a destination first. The
  // default board's stages come from the stages.js registry (the org's
  // custom default pipeline, or the profile default).
  const defaultBoard = getStageConfig(orgProfile, { dealType: 'default' });
  const defaultBoardIds = new Set((defaultBoard.allStages || []).map(st => st.id));
  const deleteTargetOptions = (defaultBoard.allStages || []).map(st => ({ value: st.id, label: st.label }));

  const openDelete = () => {
    const need = {};
    Object.entries(counts).forEach(([stage, n]) => { if (n > 0 && !defaultBoardIds.has(stage)) need[stage] = { count: n, to: '' }; });
    setDeleteMoves(need);
    setDeleteOpen(true);
  };

  const deleteUnresolved = Object.values(deleteMoves).some(m => !m.to);

  const doDelete = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const moveDealsTo = {};
      Object.entries(deleteMoves).forEach(([from, m]) => { if (m.to) moveDealsTo[from] = m.to; });
      await api.delete('/pipelines', {
        params: { deal_type: dealType },
        data: Object.keys(moveDealsTo).length ? { moveDealsTo } : {},
      });
      setDeleteOpen(false);
      await refreshPipeline?.();
      setDealType('default'); // triggers a reload of the default pipeline
      setNotice('Pipeline deleted. Its deals moved to the default pipeline.');
    } catch (err) {
      const body = err?.response?.data || {};
      if (body.error === 'stages_have_deals' && Array.isArray(body.stages_with_deals)) {
        setDeleteMoves(prev => {
          const next = { ...prev };
          body.stages_with_deals.forEach(s => { if (!next[s.stage]) next[s.stage] = { count: s.count, to: '' }; });
          return next;
        });
        setError('Some of this pipeline\'s deals need a stage on the default board. Choose where they go, then delete again.');
      } else {
        setError(body.message || body.error || 'Failed to delete the pipeline.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="settings" />
      <Container>
        <PageHeader
          title="Pipeline stages"
          subtitle="The columns on your deal board. Rename, reorder, recolor, add or remove stages — deals are moved, never lost."
          primaryAction={canEdit && hasOrg ? { label: saving ? 'Saving…' : 'Save changes', onClick: save, icon: 'check', disabled: saving || !dirty || errors.length > 0 || unresolvedMoves.length > 0 } : undefined}
          secondaryActions={canEdit && hasOrg ? [
            { label: 'Add stage', icon: 'plus', onClick: addStage, disabled: stages.length >= maxStages },
            { label: 'New pipeline', icon: 'plus', onClick: openNew },
            ...(isTypePipeline
              ? [{ label: 'Delete pipeline', icon: 'trash', onClick: openDelete }]
              : [{ label: 'Reset to default', icon: 'refresh', onClick: openReset, disabled: !data?.is_custom && Object.keys(counts).every(k => stages.some(st => st.id === k)) }]),
          ] : []}
          actions={data?.is_custom ? <StatusBadge tone="accent" label="Customized" size="md" /> : <StatusBadge tone="neutral" label="Profile default" size="md" />}
        />

        {/* Pipeline selector (spec 201) — only when the org runs several. */}
        {pipelinesList.length > 1 && (
          <div className="mb-4 flex items-center gap-3">
            <Select
              aria-label="Pipeline to edit"
              size="sm"
              wrapperClassName="w-64"
              value={dealType}
              onChange={e => setDealType(e.target.value)}
              options={pipelinesList.map(p => ({ value: p.deal_type, label: `${p.name} (${p.deal_type})` }))}
            />
            <span className="text-xs text-gray-500">
              Deals carry a type; each type can run its own stages.
            </span>
          </div>
        )}

        <div className="space-y-6">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}
          {notice && <Alert tone="success" onDismiss={() => setNotice('')}>{notice}</Alert>}
          {!hasOrg && (
            <Alert tone="info" icon="info" title="Personal workspace">
              Pipeline stages are edited per organization. A personal workspace uses the default stages.
            </Alert>
          )}
          {hasOrg && !canEdit && !loading && (
            <Alert tone="info" icon="lock" title="Read-only">
              Only an organization owner or admin can change stages. Ask them, or ask the copilot to propose the change for them to apply.
            </Alert>
          )}

          <Card title="Preview" subtitle="How the board will read, left to right.">
            {loading ? <Skeleton lines={2} /> : (
              <PreviewStrip
                stages={stages}
                phases={showPhase ? PHASE_OPTIONS.map(p => ({ id: p.value, label: p.label, stages: stages.filter(st => (st.phase || 'pre_sale') === p.value) })).filter(p => p.stages.length) : null}
              />
            )}
          </Card>

          <Card
            title="Stages"
            subtitle={`${stages.length} of ${maxStages} · at least one Won and one Lost stage`}
            padding="sm"
          >
            {loading ? <Skeleton lines={6} /> : (
              <ol className="space-y-2" aria-label="Pipeline stages">
                {stages.map((st, i) => (
                  <StageRow
                    key={st.id}
                    stage={st}
                    index={i}
                    total={stages.length}
                    count={counts[st.id] || 0}
                    canEdit={canEdit && hasOrg}
                    showPhase={showPhase}
                    paletteOpen={paletteFor === i}
                    onTogglePalette={() => setPaletteFor(paletteFor === i ? null : i)}
                    onChange={patch => update(i, patch)}
                    onMove={move}
                    onRemove={remove}
                  />
                ))}
              </ol>
            )}
            {!loading && canEdit && hasOrg && (
              <div className="mt-3 flex items-center justify-between gap-3">
                <Button variant="secondary" size="sm" icon="plus" onClick={addStage} disabled={stages.length >= maxStages}>Add stage</Button>
                {errors.length > 0 && dirty && (
                  <ul className="text-xs text-danger-600 space-y-0.5 text-right" aria-live="polite">
                    {errors.map(e => <li key={e}>{e}</li>)}
                  </ul>
                )}
              </div>
            )}
          </Card>

          {Object.keys(moves).length > 0 && (
            <Card
              title="Deals to move"
              subtitle="These deals are in stages that will no longer exist. Pick where each group goes — they move when you save."
            >
              <ul className="space-y-3">
                {Object.entries(moves).map(([from, m]) => (
                  <li key={from} className="flex flex-wrap items-center gap-3">
                    <span className="text-sm text-gray-800">
                      <span className="font-mono text-xs text-gray-500 mr-1">{from}</span>
                      {m.count} deal{m.count === 1 ? '' : 's'}
                    </span>
                    <Icon name="arrow-right" size={14} className="text-gray-400" />
                    <Select
                      aria-label={`Move ${from} deals to`}
                      size="sm"
                      wrapperClassName="w-56"
                      value={m.to}
                      disabled={!canEdit}
                      onChange={e => setMoves(prev => ({ ...prev, [from]: { ...prev[from], to: e.target.value } }))}
                      options={[{ value: '', label: 'Choose a stage…' }, ...stageOptions]}
                    />
                    {canEdit && normalize(data?.stages).some(st => st.id === from) && (
                      <Button variant="ghost" size="sm" onClick={() => restore(from)}>Keep stage instead</Button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <p className="text-xs text-gray-500">
            Stage ids (shown under each name) are stable and stored on every deal; they are generated once from the name of a new stage.
            You can also ask the copilot: <Link to="/chat" className="text-brand-blue hover:underline">"add a Demo stage after Qualified"</Link>.
          </p>
        </div>
      </Container>

      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset to the default stages?"
        description="Your custom stages are replaced by the profile default. This cannot be undone, but you can edit again afterwards."
        size="md"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setResetOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={doReset} loading={saving} disabled={resetUnresolved}>Reset pipeline</Button>
          </>
        )}
      >
        <div className="space-y-3">
          <PreviewStrip stages={normalize(data?.default_stages)} />
          {Object.keys(resetMoves).length > 0 && (
            <div className="space-y-2">
              <p className="text-sm text-gray-700">Deals in stages the default does not have need a new home:</p>
              {Object.entries(resetMoves).map(([from, m]) => (
                <div key={from} className="flex flex-wrap items-center gap-2">
                  <span className="text-sm"><span className="font-mono text-xs text-gray-500 mr-1">{from}</span>{m.count} deal{m.count === 1 ? '' : 's'}</span>
                  <Icon name="arrow-right" size={14} className="text-gray-400" />
                  <Select
                    aria-label={`After reset, move ${from} deals to`}
                    size="sm"
                    wrapperClassName="w-52"
                    value={m.to}
                    onChange={e => setResetMoves(prev => ({ ...prev, [from]: { ...prev[from], to: e.target.value } }))}
                    options={[{ value: '', label: 'Choose a stage…' }, ...defaultOptions]}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>

      {/* New pipeline (spec 201): name + deal-type slug + start-from template. */}
      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="New pipeline"
        description="A second pipeline for a different motion — its deals carry a deal type and get their own stages, columns, and colors."
        size="md"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setNewOpen(false)}>Cancel</Button>
            <Button onClick={doCreate} loading={saving} disabled={!canCreate}>Create pipeline</Button>
          </>
        )}
      >
        <div className="space-y-4">
          <Input
            label="Pipeline name"
            placeholder="e.g. Supply, Recruiting, Partnerships"
            value={newForm.name}
            autoFocus
            onChange={e => {
              const name = e.target.value;
              setNewForm(f => ({ ...f, name, slug: f.slugTouched ? f.slug : slugify(name) }));
            }}
          />
          <div>
            <Input
              label="Deal type (stable id)"
              value={newForm.slug}
              onChange={e => setNewForm(f => ({ ...f, slug: e.target.value.toLowerCase(), slugTouched: true }))}
              placeholder="supply"
            />
            <p className="mt-1 text-xs text-gray-500">
              Stored on every deal of this pipeline (lowercase, generated from the name). It cannot be renamed later.
            </p>
            {newSlugError && <p className="mt-1 text-xs text-danger-600">{newSlugError}</p>}
          </div>
          <Select
            label="Start from"
            value={newForm.from}
            onChange={e => setNewForm(f => ({ ...f, from: e.target.value }))}
            options={[
              { value: 'default', label: 'The standard default stages' },
              { value: 'current', label: `Copy the stages of "${data?.name || 'this pipeline'}"` },
            ]}
          />
          <PreviewStrip stages={newForm.from === 'current' ? stages : normalize(data?.default_stages)} />
        </div>
      </Modal>

      {/* Delete a type pipeline: its deals are re-typed onto the default board. */}
      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={`Delete the "${data?.name || dealType}" pipeline?`}
        description="Its deals move to the default pipeline (keeping their stage where it exists there). This cannot be undone."
        size="md"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={doDelete} loading={saving} disabled={deleteUnresolved}>Delete pipeline</Button>
          </>
        )}
      >
        <div className="space-y-3">
          {Object.keys(deleteMoves).length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm text-gray-700">Deals in stages the default pipeline does not have need a new home:</p>
              {Object.entries(deleteMoves).map(([from, m]) => (
                <div key={from} className="flex flex-wrap items-center gap-2">
                  <span className="text-sm"><span className="font-mono text-xs text-gray-500 mr-1">{from}</span>{m.count} deal{m.count === 1 ? '' : 's'}</span>
                  <Icon name="arrow-right" size={14} className="text-gray-400" />
                  <Select
                    aria-label={`After delete, move ${from} deals to`}
                    size="sm"
                    wrapperClassName="w-52"
                    value={m.to}
                    onChange={e => setDeleteMoves(prev => ({ ...prev, [from]: { ...prev[from], to: e.target.value } }))}
                    options={[{ value: '', label: 'Choose a stage…' }, ...deleteTargetOptions]}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-700">Every deal on this pipeline already sits in a stage the default board has — nothing needs re-homing.</p>
          )}
        </div>
      </Modal>
    </div>
  );
}
