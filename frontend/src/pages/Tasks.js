// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import Nav from '../components/Nav';
import api from '../api';
import SavedViewsTabs from '../components/SavedViewsTabs';
import BulkActionBar from '../components/BulkActionBar';
import CustomFieldsSection from '../components/CustomFieldsSection';
import {
  Alert, Button, Card, Container, EmptyState, Icon, Input, Modal, PageHeader,
  Select, Skeleton, StatusBadge, Tabs, Textarea,
} from '../components/ui';

const STATUSES = ['open', 'in_progress', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];

// Recurrence allowlist mirrors backend/schemas/tasks.RECURRENCE_RULES.
// '' = one-off (sent as null). Completing a recurring task auto-creates the
// next occurrence server-side.
const RECURRENCE_OPTIONS = [
  ['', 'None'],
  ['daily', 'Daily'],
  ['weekly', 'Weekly'],
  ['biweekly', 'Biweekly'],
  ['monthly', 'Monthly'],
];
const RECURRENCE_LABEL = { daily: 'Daily', weekly: 'Weekly', biweekly: 'Biweekly', monthly: 'Monthly' };

const STATUS_TONE = { open: 'info', in_progress: 'warning', done: 'success' };
const PRIORITY_TONE = { low: 'neutral', medium: 'warning', high: 'error' };

function TaskForm({ task, contacts, deals, onClose, onSave }) {
  const [form, setForm] = useState(() => ({
    title: task?.title || '',
    description: task?.description || '',
    due_date: task?.due_date ? task.due_date.slice(0, 10) : '',
    status: task?.status || 'open',
    priority: task?.priority || 'medium',
    contact_id: task?.contact_id || '',
    deal_id: task?.deal_id || '',
    custom_fields: task?.custom_fields || {},
    recurrence_rule: task?.recurrence_rule || '',
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!form.title) return;
    setSaving(true);
    setError('');
    try {
      const payload = {
        ...form,
        contact_id: form.contact_id || null,
        deal_id: form.deal_id || null,
        due_date: form.due_date || null,
        recurrence_rule: form.recurrence_rule || null,
      };
      if (task?.id) {
        await api.put(`/tasks/${task.id}`, payload);
      } else {
        await api.post('/tasks', payload);
      }
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save task');
    } finally {
      setSaving(false);
    }
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Modal
      open
      onClose={onClose}
      title={task ? 'Edit task' : 'New task'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="task-form" loading={saving} loadingLabel="Saving…">
            {task ? 'Save changes' : 'Create task'}
          </Button>
        </>
      }
    >
      <form id="task-form" onSubmit={submit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Input label="Title" placeholder="What needs doing?" value={form.title} onChange={set('title')} required autoFocus />
        <Textarea label="Description" placeholder="Optional" value={form.description} onChange={set('description')} rows={3} />
        <div className="grid grid-cols-2 gap-4">
          <Input type="date" label="Due date" value={form.due_date} onChange={set('due_date')} />
          <Select label="Priority" value={form.priority} onChange={set('priority')}>
            {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Select label="Status" value={form.status} onChange={set('status')}>
            {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </Select>
          <Select
            label="Repeats"
            value={form.recurrence_rule}
            onChange={set('recurrence_rule')}
            hint={form.recurrence_rule ? 'Completing it creates the next occurrence automatically.' : undefined}
          >
            {RECURRENCE_OPTIONS.map(([v, label]) => <option key={v || 'none'} value={v}>{label}</option>)}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Select label="Linked contact" value={form.contact_id} onChange={set('contact_id')}>
            <option value="">None</option>
            {contacts.map(c => <option key={c.id} value={c.id}>{c.first_name} {c.last_name}</option>)}
          </Select>
          <Select label="Linked deal" value={form.deal_id} onChange={set('deal_id')}>
            <option value="">None</option>
            {deals.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
          </Select>
        </div>
        <CustomFieldsSection
          entity="tasks"
          values={form.custom_fields || {}}
          onChange={(next) => setForm(prev => ({ ...prev, custom_fields: next }))}
        />
      </form>
    </Modal>
  );
}

// The Tasks page uses a single "bucket" string as its filter, not an object.
// The CommandPalette serializes it as ?bucket=open. Anything that doesn't
// match a known bucket is treated as 'all' so a malformed URL doesn't crash.
const TASK_BUCKETS = ['open', 'in_progress', 'done', 'overdue', 'all'];
function bucketFromSearchParams(search) {
  if (!search) return null;
  const sp = new URLSearchParams(search);
  const b = sp.get('bucket');
  return b && TASK_BUCKETS.includes(b) ? b : null;
}

export default function Tasks() {
  const location = useLocation();
  const [tasks, setTasks] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // `filter` here is the simple status-bucket string the Tasks page has always
  // used. Wrapped in an object when stored as a saved view so future filter
  // dimensions (priority, owner, etc.) can be added without migrating shape.
  // Seeded from URL ?bucket=… so a CommandPalette redirect arrives applied.
  const [filter, setFilter] = useState(() => {
    if (typeof window !== 'undefined') {
      const b = bucketFromSearchParams(window.location.search);
      if (b) return b;
    }
    return 'open';
  });

  // Re-apply URL bucket when the search string changes mid-session.
  useEffect(() => {
    const b = bucketFromSearchParams(location.search);
    if (b) setFilter(b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [activeViewId, setActiveViewId] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [members, setMembers] = useState([]);

  const load = async () => {
    setLoading(true);
    try {
      const [t, c, d] = await Promise.all([
        api.get('/tasks'),
        api.get('/contacts'),
        api.get('/deals'),
      ]);
      setTasks(t.data);
      setContacts(c.data);
      setDeals(d.data);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  };

  const fetchMembers = async () => {
    try {
      const r = await api.get('/org');
      setMembers(r.data?.members || []);
    } catch {
      setMembers([]);
    }
  };

  useEffect(() => { load(); fetchMembers(); }, []);

  const toggleStatus = async (task) => {
    const next = task.status === 'done' ? 'open' : 'done';
    try {
      await api.put(`/tasks/${task.id}`, { status: next });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update task');
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this task?')) return;
    try {
      await api.delete(`/tasks/${id}`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete task');
    }
  };

  const visible = tasks.filter(t => {
    if (filter === 'all') return true;
    if (filter === 'overdue') return t.status !== 'done' && t.due_date && new Date(t.due_date) < new Date(new Date().toDateString());
    return t.status === filter;
  });

  const counts = {
    open: tasks.filter(t => t.status === 'open').length,
    in_progress: tasks.filter(t => t.status === 'in_progress').length,
    done: tasks.filter(t => t.status === 'done').length,
    overdue: tasks.filter(t => t.status !== 'done' && t.due_date && new Date(t.due_date) < new Date(new Date().toDateString())).length,
  };

  // Bulk-select state — only counts ids currently visible after the bucket
  // filter, so changing the filter naturally drops off-screen selections.
  const visibleIds = useMemo(() => new Set(visible.map(t => t.id)), [visible]);
  const visibleSelected = useMemo(() => {
    const s = new Set();
    selectedIds.forEach(id => { if (visibleIds.has(id)) s.add(id); });
    return s;
  }, [selectedIds, visibleIds]);
  const toggleRow = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAllVisible = () => {
    setSelectedIds(prev => {
      const allSelected = visible.length > 0 && visible.every(t => prev.has(t.id));
      return allSelected ? new Set() : new Set(visible.map(t => t.id));
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

  const applyView = (filterSpec, _sort, view) => {
    // Saved views store {bucket: 'open'|'in_progress'|...}. Defensive default
    // so a malformed view payload doesn't crash the page.
    setFilter(filterSpec?.bucket || 'all');
    setActiveViewId(view?.id || null);
    clearSelection();
  };
  const setBucket = (b) => {
    setFilter(b);
    setActiveViewId(null);
    clearSelection();
  };

  const allVisibleSelected = visible.length > 0 && visible.every(t => visibleSelected.has(t.id));

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="tasks" />
      <Container size="wide">
        <PageHeader
          title="Tasks"
          subtitle={`${counts.open} open · ${counts.in_progress} in progress · ${counts.done} done · ${counts.overdue} overdue`}
          primaryAction={{ label: 'New task', onClick: () => setCreating(true) }}
        />

        <SavedViewsTabs
          resource="tasks"
          currentFilter={{ bucket: filter }}
          currentSort={{}}
          activeViewId={activeViewId}
          onApplyView={applyView}
        />

        <div className="space-y-6">
          <div className="flex items-end justify-between gap-3">
            <Tabs
              className="flex-1"
              aria-label="Task buckets"
              value={filter}
              onChange={setBucket}
              items={[
                { id: 'open', label: 'Open', count: counts.open },
                { id: 'in_progress', label: 'In progress', count: counts.in_progress },
                { id: 'done', label: 'Done', count: counts.done },
                { id: 'overdue', label: 'Overdue', count: counts.overdue },
                { id: 'all', label: 'All' },
              ]}
            />
            {visible.length > 0 && (
              <Button variant="ghost" size="sm" className="mb-1.5" onClick={toggleAllVisible}>
                {allVisibleSelected ? 'Clear selection' : `Select all ${visible.length}`}
              </Button>
            )}
          </div>

          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          {loading ? (
            <Card><Skeleton lines={6} /></Card>
          ) : visible.length === 0 ? (
            <Card padding="none">
              <EmptyState
                icon="check-circle"
                title={
                  tasks.length === 0
                    ? 'A clean slate'
                    : filter === 'all'
                      ? 'No tasks match your filters'
                      : `No tasks in "${filter.replace('_', ' ')}"`
                }
                message={
                  tasks.length === 0
                    ? "Tasks keep your follow-ups from slipping through the cracks. Add your first one — future-you will thank you."
                    : filter === 'overdue'
                      ? "You're caught up — nothing overdue right now."
                      : 'Switch buckets above or create a new task.'
                }
                action={
                  <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                    New task
                  </Button>
                }
              />
            </Card>
          ) : (
            <div className="space-y-2">
              {visible.map(task => {
                const overdue = task.status !== 'done' && task.due_date && new Date(task.due_date) < new Date(new Date().toDateString());
                const selected = visibleSelected.has(task.id);
                return (
                  <div key={task.id} className={`bg-white rounded border p-3 flex items-start gap-3 shadow-card transition ${task.status === 'done' ? 'opacity-60' : ''} ${overdue ? 'border-danger-300' : 'border-gray-200'} ${selected ? 'ring-2 ring-brand-blue' : ''}`}>
                    {/* Bulk-select checkbox — visually distinct from the
                        done-toggle below (square, blue outline) so the two
                        affordances don't look like the same control. */}
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleRow(task.id)}
                      aria-label="Select task for bulk action"
                      className="mt-1.5 h-4 w-4 rounded border-2 border-brand-blue text-brand-blue focus:ring-brand-blue cursor-pointer flex-shrink-0"
                    />
                    <input
                      type="checkbox"
                      checked={task.status === 'done'}
                      onChange={() => toggleStatus(task)}
                      title="Mark done"
                      className="mt-1.5 h-4 w-4 rounded-full border-gray-300 text-brand-blue focus:ring-brand-blue cursor-pointer"
                    />
                    <button onClick={() => setEditing(task)} className="flex-1 text-left min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className={`text-sm font-semibold ${task.status === 'done' ? 'line-through text-gray-500' : 'text-gray-900'}`}>{task.title}</h3>
                        <StatusBadge tone={STATUS_TONE[task.status] || 'neutral'} label={task.status.replace('_', ' ')} className="capitalize" />
                        <StatusBadge tone={PRIORITY_TONE[task.priority] || 'neutral'} label={task.priority} className="capitalize" />
                        {overdue && <StatusBadge tone="error" label="Overdue" />}
                        {task.recurrence_rule && (
                          <StatusBadge
                            tone="accent"
                            title="Recurring task — completing it creates the next occurrence"
                            label={<><Icon name="refresh" size={11} />{RECURRENCE_LABEL[task.recurrence_rule] || task.recurrence_rule}</>}
                          />
                        )}
                      </div>
                      {task.description && <p className="text-sm text-gray-600 mt-1">{task.description}</p>}
                      <div className="flex gap-3 text-xs text-gray-500 mt-1">
                        {task.due_date && <span>Due {new Date(task.due_date).toLocaleDateString()}</span>}
                        {task.contact_id && contacts.find(c => c.id === task.contact_id) && (
                          <span>· {contacts.find(c => c.id === task.contact_id).first_name} {contacts.find(c => c.id === task.contact_id).last_name}</span>
                        )}
                        {task.deal_id && deals.find(d => d.id === task.deal_id) && (
                          <span>· {deals.find(d => d.id === task.deal_id).title}</span>
                        )}
                      </div>
                    </button>
                    <button
                      onClick={() => remove(task.id)}
                      aria-label="Delete task"
                      title="Delete task"
                      className="flex-shrink-0 rounded-md p-1.5 text-gray-400 hover:text-danger-600 hover:bg-danger-50"
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Container>

      {(creating || editing) && (
        <TaskForm
          task={editing}
          contacts={contacts}
          deals={deals}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSave={() => { setCreating(false); setEditing(null); load(); }}
        />
      )}

      <BulkActionBar
        resource="tasks"
        selectedIds={visibleSelected}
        totalCount={visible.length}
        ownerOptions={members}
        ownerField="assigned_to"
        statusOptions={STATUSES.map(s => ({ value: s, label: s.replace('_', ' ') }))}
        statusLabel="Change status"
        onClear={clearSelection}
        onComplete={() => { clearSelection(); load(); }}
      />
    </div>
  );
}
