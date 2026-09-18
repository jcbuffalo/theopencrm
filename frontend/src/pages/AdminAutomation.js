// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Admin Automation Rules page — user-defined "when X happens, do Y" rules.
//
// Available at /admin/automation. Org owner/admin only (the backend
// /api/automation-rules routes enforce org_role owner|admin; this page also
// hides the editor for non-admins). Gated by the automation_enabled feature
// flag at the API layer — a 403 surfaces as an inline banner.
//
// A rule = { name, trigger, conditions, action, enabled }. Triggers and actions
// are small closed enums (kept in sync with backend/schemas/automationRules.js):
//   triggers:  deal_stage_is { stage } · deal_idle_days { days } · task_overdue {}
//              · custom_date_offset { entity, field_name, offset_days }
//   actions:   create_task { title, priority } · notify · set_hot_flag (deal-only)
//              · create_task_and_notify { title, priority } (date rule only)

import React, { useEffect, useState } from 'react';
import api from '../api';
import Nav from '../components/Nav';
import { useAuth } from '../AuthContext';
import { Alert, Button, Card, Container, Input, PageHeader, Select, Skeleton, StatusBadge } from '../components/ui';

const TRIGGERS = [
  { value: 'deal_stage_is',      label: 'Deal reaches a stage' },
  { value: 'deal_idle_days',     label: 'Deal idle for N days' },
  { value: 'task_overdue',       label: 'Task is overdue' },
  { value: 'custom_date_offset', label: 'Around a date custom field' },
];

const ACTIONS = [
  { value: 'create_task',            label: 'Create a follow-up task' },
  { value: 'notify',                 label: 'Notify the owner' },
  { value: 'set_hot_flag',           label: 'Flag the deal as hot' },
  { value: 'create_task_and_notify', label: 'Create a task + notify the owner' },
];

const DEAL_TRIGGERS = ['deal_stage_is', 'deal_idle_days'];
const DATE_RULE_ENTITIES = [
  { value: 'deals',     label: 'Deals' },
  { value: 'companies', label: 'Companies' },
  { value: 'contacts',  label: 'Contacts' },
];

const EMPTY_FORM = {
  name: '',
  trigger: 'deal_stage_is',
  stage: '',
  days: 14,
  entity: 'deals',
  fieldName: '',
  offsetDays: -7,
  action: 'create_task',
  taskTitle: '',
  priority: 'medium',
};

function triggerLabel(v) { return (TRIGGERS.find(t => t.value === v) || {}).label || v; }
function actionLabel(v)  { return (ACTIONS.find(a => a.value === v) || {}).label || v; }

function describeConditions(rule) {
  if (rule.trigger === 'deal_stage_is')  return `stage = ${rule.conditions?.stage ?? '?'}`;
  if (rule.trigger === 'deal_idle_days') return `idle ≥ ${rule.conditions?.days ?? '?'} days`;
  if (rule.trigger === 'custom_date_offset') {
    const c = rule.conditions || {};
    const n = Number(c.offset_days ?? 0);
    const when = n === 0 ? 'on' : `${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'} ${n < 0 ? 'before' : 'after'}`;
    return `${when} ${c.field_name ?? '?'} on ${c.entity ?? '?'}`;
  }
  return '—';
}
function describeAction(rule) {
  const t = rule.action?.type;
  if (t === 'create_task') return `create task "${rule.action.title || ''}" (${rule.action.priority || 'medium'})`;
  if (t === 'create_task_and_notify') return `create task "${rule.action.title || ''}" + notify owner`;
  return actionLabel(t);
}

function formToPayload(form) {
  const conditions = {};
  if (form.trigger === 'deal_stage_is')  conditions.stage = form.stage.trim();
  if (form.trigger === 'deal_idle_days') conditions.days  = Number(form.days);
  if (form.trigger === 'custom_date_offset') {
    conditions.entity = form.entity;
    conditions.field_name = form.fieldName;
    conditions.offset_days = Number(form.offsetDays);
  }

  const action = { type: form.action };
  if (form.action === 'create_task' || form.action === 'create_task_and_notify') {
    action.title = form.taskTitle.trim();
    action.priority = form.priority;
  }
  return { name: form.name.trim(), trigger: form.trigger, conditions, action, enabled: true };
}

export default function AdminAutomation() {
  const { isAdmin, orgRole } = useAuth();
  // Self-service: the backend (/api/automation-rules) authorizes org
  // owner/admin, and platform super-admins pass too. Mirror that here so an
  // org owner is never locked out of UI they are authorized to use.
  const canManage = isAdmin || orgRole === 'owner' || orgRole === 'admin';
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [runMsg, setRunMsg] = useState('');
  // Date custom fields per entity, for the custom_date_offset field picker —
  // loaded lazily the first time the trigger/entity is selected.
  const [dateFields, setDateFields] = useState({}); // entity -> [{name,label}] | 'loading'

  const loadDateFields = async (entity) => {
    if (dateFields[entity]) return;
    setDateFields(f => ({ ...f, [entity]: 'loading' }));
    try {
      const r = await api.get('/custom-fields', { params: { entity } });
      const fields = (Array.isArray(r.data) ? r.data : []).filter(d => d.type === 'date')
        .map(d => ({ value: d.name, label: d.label || d.name }));
      setDateFields(f => ({ ...f, [entity]: fields }));
    } catch {
      setDateFields(f => ({ ...f, [entity]: [] }));
    }
  };

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.get('/automation-rules');
      setRules(r.data?.rules || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load automation rules');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const update = (patch) => setForm(f => ({ ...f, ...patch }));

  const create = async (e) => {
    e.preventDefault();
    setSaving(true);
    setFormError('');
    setRunMsg('');
    try {
      await api.post('/automation-rules', formToPayload(form));
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setFormError(err.response?.data?.error || err.message || 'Failed to create rule');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (rule) => {
    try {
      await api.patch(`/automation-rules/${rule.id}/enabled`, { enabled: !rule.enabled });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to toggle rule');
    }
  };

  const remove = async (rule) => {
    if (!window.confirm(`Delete automation rule "${rule.name}"?`)) return;
    try {
      await api.delete(`/automation-rules/${rule.id}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete rule');
    }
  };

  const runNow = async (rule) => {
    setRunMsg('');
    try {
      const r = await api.post(`/automation-rules/${rule.id}/run`);
      const res = r.data?.result || {};
      setRunMsg(`Ran "${rule.name}": fired ${res.fired ?? 0} of ${res.scanned ?? 0} matched.`);
    } catch (err) {
      setRunMsg(err.response?.data?.error || 'Failed to run rule');
    }
  };

  if (!canManage) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Nav active="admin" />
        <Container size="narrow">
          <Alert tone="danger" icon="lock">Org admin access required.</Alert>
        </Container>
      </div>
    );
  }

  const isDealTrigger = DEAL_TRIGGERS.includes(form.trigger);
  const isDateTrigger = form.trigger === 'custom_date_offset';
  // set_hot_flag is deal-only; create_task_and_notify is date-rule-only — if
  // the current trigger doesn't allow the chosen action, steer the user back.
  const actionOptions = ACTIONS
    .filter(a => a.value !== 'set_hot_flag' || isDealTrigger)
    .filter(a => a.value !== 'create_task_and_notify' || isDateTrigger);
  const entityDateFields = dateFields[form.entity];

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="admin" />
      <Container>
        <PageHeader
          title="Automation rules"
          subtitle='Build simple "when this happens, do that" rules. They run automatically on the same schedule as the built-in automations, and you can run any rule immediately to test it. Rules only ever touch your own organization&apos;s data.'
          primaryAction={{ label: 'Reload', icon: 'refresh', variant: 'secondary', onClick: load }}
        />

        <div className="space-y-6">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}
          {runMsg && <Alert tone="info" onDismiss={() => setRunMsg('')}>{runMsg}</Alert>}

          {/* Create form */}
          <Card title="New rule" as="div">
            <form onSubmit={create}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input
                  label="Name"
                  type="text"
                  required
                  value={form.name}
                  onChange={e => update({ name: e.target.value })}
                  placeholder="e.g. Flag won deals as hot"
                />

                <Select
                  label="When (trigger)"
                  value={form.trigger}
                  onChange={e => {
                    const trigger = e.target.value;
                    // Steer back to create_task when the chosen action isn't
                    // valid for the new trigger (set_hot_flag is deal-only,
                    // create_task_and_notify is date-rule-only).
                    let action = form.action;
                    if (!DEAL_TRIGGERS.includes(trigger) && action === 'set_hot_flag') action = 'create_task';
                    if (trigger !== 'custom_date_offset' && action === 'create_task_and_notify') action = 'create_task';
                    update({ trigger, action });
                    if (trigger === 'custom_date_offset') loadDateFields(form.entity);
                  }}
                  options={TRIGGERS}
                />

                {/* Condition inputs — vary by trigger */}
                {form.trigger === 'deal_stage_is' && (
                  <Input
                    label="Stage"
                    type="text"
                    required
                    value={form.stage}
                    onChange={e => update({ stage: e.target.value })}
                    placeholder="e.g. CLOSED_WON"
                  />
                )}
                {form.trigger === 'deal_idle_days' && (
                  <Input
                    label="Idle days"
                    type="number"
                    min="1"
                    max="3650"
                    required
                    value={form.days}
                    onChange={e => update({ days: e.target.value })}
                  />
                )}
                {form.trigger === 'task_overdue' && <div className="hidden md:block" />}
                {isDateTrigger && (
                  <>
                    <Select
                      label="Records"
                      value={form.entity}
                      onChange={e => { update({ entity: e.target.value, fieldName: '' }); loadDateFields(e.target.value); }}
                      options={DATE_RULE_ENTITIES}
                    />
                    {Array.isArray(entityDateFields) && entityDateFields.length === 0 ? (
                      <div className="text-xs text-gray-500 self-end pb-2">
                        No date custom fields on {form.entity} yet — add one under Settings → Custom fields first.
                      </div>
                    ) : (
                      <Select
                        label="Date field"
                        required
                        value={form.fieldName}
                        onChange={e => update({ fieldName: e.target.value })}
                        options={[
                          { value: '', label: entityDateFields === 'loading' ? 'Loading…' : 'Pick a date field…' },
                          ...(Array.isArray(entityDateFields) ? entityDateFields : []),
                        ]}
                      />
                    )}
                    <Input
                      label="Days offset (negative = before the date)"
                      type="number"
                      min="-3650"
                      max="3650"
                      required
                      value={form.offsetDays}
                      onChange={e => update({ offsetDays: e.target.value })}
                    />
                  </>
                )}

                <Select
                  label="Then (action)"
                  value={form.action}
                  onChange={e => update({ action: e.target.value })}
                  options={actionOptions}
                />

                {/* Action inputs — only task-creating actions need extra fields */}
                {(form.action === 'create_task' || form.action === 'create_task_and_notify') && (
                  <>
                    <Input
                      label={isDateTrigger ? 'Task title — {name}, {date} and {field} are filled in' : 'Task title'}
                      type="text"
                      required
                      value={form.taskTitle}
                      onChange={e => update({ taskTitle: e.target.value })}
                      placeholder={isDateTrigger ? 'e.g. Permit for {name} expires {date}' : 'e.g. Follow up with customer'}
                    />
                    <Select
                      label="Task priority"
                      value={form.priority}
                      onChange={e => update({ priority: e.target.value })}
                      options={[{ value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' }]}
                    />
                  </>
                )}
              </div>

              {formError && <p className="text-xs text-danger-600 mt-3" role="alert">{formError}</p>}

              <div className="mt-4">
                <Button type="submit" icon="plus" disabled={saving} loading={saving} loadingLabel="Saving…">
                  Create rule
                </Button>
              </div>
            </form>
          </Card>

          {/* Rules list */}
          <Card title="Your rules" padding="none">
            {loading ? (
              <div className="p-5"><Skeleton lines={4} /></div>
            ) : rules.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-500">No automation rules yet. Set one up above &mdash; like &ldquo;when a deal goes idle 14 days, make me a follow-up task&rdquo; &mdash; and let the CRM handle the busywork.</div>
            ) : (
              <ul>
                {rules.map(rule => (
                  <li key={rule.id} className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-100 last:border-0">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-gray-900 text-sm">{rule.name}</span>
                        {!rule.enabled && <StatusBadge tone="neutral" label="disabled" />}
                      </div>
                      <p className="text-xs text-gray-600 mt-1">
                        <span className="font-medium">When</span> {triggerLabel(rule.trigger)} ({describeConditions(rule)})
                        {' · '}
                        <span className="font-medium">then</span> {describeAction(rule)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Button variant="ghost" size="sm" onClick={() => runNow(rule)}>Run now</Button>
                      <Button variant="ghost" size="sm" onClick={() => toggle(rule)}>
                        {rule.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => remove(rule)} className="text-danger-600 hover:bg-danger-50">Delete</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </Container>
    </div>
  );
}
