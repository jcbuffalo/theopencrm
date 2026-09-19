// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import Nav from '../components/Nav';
import api from '../api';
import { Alert, Button, Card, Container, EmptyState, Icon, Input, Modal, PageHeader, Select, Skeleton, StatusBadge, Textarea } from '../components/ui';

const TYPES = ['call', 'email', 'meeting', 'note', 'demo', 'other'];

const TYPE_TONE = {
  call:    'accent',
  email:   'info',
  meeting: 'success',
  note:    'neutral',
  demo:    'warning',
  other:   'neutral',
};

function ActivityForm({ activity, initialType, contacts, deals, onClose, onSave }) {
  const [form, setForm] = useState(() => ({
    type: activity?.type || initialType || 'note',
    title: activity?.title || '',
    description: activity?.description || '',
    activity_date: activity?.activity_date
      ? new Date(activity.activity_date).toISOString().slice(0, 16)
      : new Date().toISOString().slice(0, 16),
    duration_minutes: activity?.duration_minutes || '',
    outcome: activity?.outcome || '',
    contact_id: activity?.contact_id || '',
    deal_id: activity?.deal_id || '',
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!form.title || !form.activity_date || !form.type) return;
    setSaving(true);
    setError('');
    try {
      const payload = {
        ...form,
        contact_id: form.contact_id || null,
        deal_id: form.deal_id || null,
        duration_minutes: form.duration_minutes ? Number(form.duration_minutes) : null,
        outcome: form.outcome || null,
      };
      if (activity?.id) {
        await api.put(`/activities/${activity.id}`, payload);
      } else {
        await api.post('/activities', payload);
      }
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save activity');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={activity ? 'Edit activity' : 'Log activity'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="activity-form" loading={saving} loadingLabel="Saving…">
            {activity ? 'Save changes' : 'Log activity'}
          </Button>
        </>
      }
    >
      <form id="activity-form" onSubmit={submit} className="space-y-4">
        {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select label="Type" required value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} options={TYPES} className="capitalize" />
          <Input label="When" required type="datetime-local" value={form.activity_date} onChange={(e) => setForm({ ...form, activity_date: e.target.value })} />
        </div>

        <Input label="Title" required autoFocus placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />

        <Textarea label="Description / notes" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="Duration (minutes)" type="number" value={form.duration_minutes} onChange={(e) => setForm({ ...form, duration_minutes: e.target.value })} placeholder="30" />
          <Input label="Outcome" type="text" value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })} placeholder="Followed up, Voicemail, etc." />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select label="Linked contact" value={form.contact_id} onChange={(e) => setForm({ ...form, contact_id: e.target.value })}>
            <option value="">None</option>
            {contacts.map(c => <option key={c.id} value={c.id}>{c.first_name} {c.last_name}</option>)}
          </Select>
          <Select label="Linked deal" value={form.deal_id} onChange={(e) => setForm({ ...form, deal_id: e.target.value })}>
            <option value="">None</option>
            {deals.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
          </Select>
        </div>
      </form>
    </Modal>
  );
}

export default function Activities() {
  const location = useLocation();
  const [activities, setActivities] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  // Quick-add (CommandPalette "Log a call" / nav "+" button) → ?new=call
  // opens Log activity preset to type=call; plain ?new=1 just opens it.
  const [presetType, setPresetType] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const flag = params.get('new');
    if (flag === 'call') { setPresetType('call'); setCreating(true); }
    else if (flag === '1') { setPresetType(null); setCreating(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  const load = async () => {
    setLoading(true);
    try {
      const [a, c, d] = await Promise.all([
        api.get('/activities?limit=100'),
        api.get('/contacts'),
        api.get('/deals'),
      ]);
      setActivities(a.data);
      setContacts(c.data);
      setDeals(d.data);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load activities');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const remove = async (id) => {
    if (!window.confirm('Delete this activity?')) return;
    await api.delete(`/activities/${id}`);
    load();
  };

  const visible = filter === 'all' ? activities : activities.filter(a => a.type === filter);

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="activities" />
      <Container size="wide">
        <PageHeader
          title="Activities"
          subtitle={`${activities.length} logged · most recent first`}
          primaryAction={{ label: 'Log activity', icon: 'plus', onClick: () => setCreating(true) }}
        />

        <div className="space-y-6">
          <Card padding="sm">
            <div className="flex gap-2 flex-wrap" role="group" aria-label="Filter by type">
              <Button variant={filter === 'all' ? 'primary' : 'secondary'} size="sm" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
                All ({activities.length})
              </Button>
              {TYPES.map(t => {
                const count = activities.filter(a => a.type === t).length;
                if (count === 0) return null;
                return (
                  <Button key={t} variant={filter === t ? 'primary' : 'secondary'} size="sm" aria-pressed={filter === t} className="capitalize" onClick={() => setFilter(t)}>
                    {t} ({count})
                  </Button>
                );
              })}
            </div>
          </Card>

          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          {loading ? (
            <Card role="status" aria-label="Loading activities"><Skeleton lines={6} /></Card>
          ) : visible.length === 0 ? (
            <Card padding="none">
              <EmptyState
                icon="phone"
                title={activities.length === 0 ? 'Your deal history starts here' : `No ${filter} activities`}
                message={
                  activities.length === 0
                    ? 'Activities are your calls, meetings, emails, and notes — the receipts on every deal. Log the first one to build the story.'
                    : `Try switching back to "All" or log a new ${filter}.`
                }
                action={
                  <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                    Log activity
                  </Button>
                }
              />
            </Card>
          ) : (
            <div className="space-y-2">
              {visible.map(activity => (
                <div key={activity.id} className="bg-white rounded border border-gray-200 shadow-card p-3 flex items-start gap-3 hover:border-gray-300 transition">
                  <StatusBadge tone={TYPE_TONE[activity.type] || 'neutral'} label={<span className="uppercase">{activity.type}</span>} className="mt-1" />
                  <button onClick={() => setEditing(activity)} className="flex-1 text-left min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <h3 className="font-semibold text-gray-900">{activity.title}</h3>
                      <span className="text-xs text-gray-500">{new Date(activity.activity_date).toLocaleString()}</span>
                      {activity.duration_minutes && <span className="text-xs text-gray-500">· {activity.duration_minutes}m</span>}
                    </div>
                    {activity.description && <p className="text-sm text-gray-700 mt-1">{activity.description}</p>}
                    <div className="flex gap-3 text-xs text-gray-500 mt-1">
                      {activity.outcome && <span>Outcome: <strong>{activity.outcome}</strong></span>}
                      {activity.contact_id && contacts.find(c => c.id === activity.contact_id) && (
                        <span>· {contacts.find(c => c.id === activity.contact_id).first_name} {contacts.find(c => c.id === activity.contact_id).last_name}</span>
                      )}
                      {activity.deal_id && deals.find(d => d.id === activity.deal_id) && (
                        <span>· {deals.find(d => d.id === activity.deal_id).title}</span>
                      )}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(activity.id)}
                    aria-label="Delete activity"
                    className="flex-shrink-0 rounded-md p-1.5 text-gray-400 hover:bg-danger-50 hover:text-danger-600"
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Container>

      {(creating || editing) && (
        <ActivityForm
          activity={editing}
          initialType={presetType}
          contacts={contacts}
          deals={deals}
          onClose={() => { setCreating(false); setEditing(null); setPresetType(null); }}
          onSave={() => { setCreating(false); setEditing(null); setPresetType(null); load(); }}
        />
      )}
    </div>
  );
}
