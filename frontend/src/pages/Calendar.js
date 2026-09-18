// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Nav from '../components/Nav';
import api from '../api';
import { Alert, Button, Card, Container, EmptyState, Input, Modal, PageHeader, Select, Skeleton, Textarea } from '../components/ui';

// Calendar — the in-app scheduling surface at /calendar.
//
// One call to GET /api/calendar/agenda?from=&to= returns a merged, time-sorted
// list of MEETINGS (the internal schedulable object, /api/meetings), MY due
// TASKS, and read-only MEETING LOGS captured by the Teams/Zoom webhooks. Two
// views over the same data: a 7-column week grid and a grouped-by-day agenda
// list — deliberately a plain CSS grid, no calendar library.
//
// Clicking a meeting opens the edit modal; clicking a task deep-links to the
// Tasks page; meeting logs are informational (they came from a webhook — the
// system observed them, you don't edit them here).

const DAY_MS = 86400000;

const TYPE_STYLES = {
  meeting:     'bg-info-50 border-info-200 text-info-900 hover:bg-info-100',
  task:        'bg-warning-50 border-warning-200 text-warning-900 hover:bg-warning-100',
  meeting_log: 'bg-gray-50 border-gray-200 text-gray-600',
};
const TYPE_LABELS = { meeting: 'Meeting', task: 'Task due', meeting_log: 'Logged call' };

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
// Monday-start week, matching how most work-week planning reads.
function startOfWeek(d) {
  const x = startOfDay(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function addDays(d, n) {
  return new Date(d.getTime() + n * DAY_MS);
}
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function fmtTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function fmtDayHeading(d) {
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}
// <input type="datetime-local"> wants local "YYYY-MM-DDTHH:mm".
function toLocalInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function MeetingForm({ meeting, defaultStart, companies, contacts, deals, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    title: meeting?.title || '',
    starts_at: toLocalInput(meeting?.starts_at || defaultStart),
    ends_at: toLocalInput(meeting?.ends_at),
    company_id: meeting?.company_id || '',
    deal_id: meeting?.deal_id || '',
    contact_id: meeting?.contact_id || '',
    location: meeting?.location || '',
    notes: meeting?.notes || '',
  }));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!form.title || !form.starts_at) return;
    setSaving(true);
    setError('');
    try {
      const payload = {
        title: form.title,
        starts_at: new Date(form.starts_at).toISOString(),
        ends_at: form.ends_at ? new Date(form.ends_at).toISOString() : null,
        company_id: form.company_id ? Number(form.company_id) : null,
        deal_id: form.deal_id ? Number(form.deal_id) : null,
        contact_id: form.contact_id ? Number(form.contact_id) : null,
        location: form.location || null,
        notes: form.notes || null,
      };
      if (meeting?.id) {
        await api.put(`/meetings/${meeting.id}`, payload);
      } else {
        await api.post('/meetings', payload);
      }
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save meeting');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!meeting?.id) return;
    if (!window.confirm('Delete this meeting?')) return;
    setDeleting(true);
    setError('');
    try {
      await api.delete(`/meetings/${meeting.id}`);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete meeting');
      setDeleting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={meeting?.id ? 'Edit meeting' : 'New meeting'}
      footer={
        <>
          {meeting?.id && (
            <Button variant="ghost" className="mr-auto !text-danger-600" icon="trash" onClick={remove} loading={deleting} loadingLabel="Deleting…">
              Delete
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="meeting-form" loading={saving} loadingLabel="Saving…">
            {meeting?.id ? 'Save changes' : 'Create meeting'}
          </Button>
        </>
      }
    >
      <form id="meeting-form" onSubmit={submit} className="space-y-4">
        {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}
        <Input label="Title" placeholder="Meeting title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required autoFocus />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Starts" type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} required />
          <Input label="Ends" hint="Optional" type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select label="Linked company" value={form.company_id} onChange={(e) => setForm({ ...form, company_id: e.target.value })}>
            <option value="">None</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select label="Linked deal" value={form.deal_id} onChange={(e) => setForm({ ...form, deal_id: e.target.value })}>
            <option value="">None</option>
            {deals.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select label="Linked contact" value={form.contact_id} onChange={(e) => setForm({ ...form, contact_id: e.target.value })}>
            <option value="">None</option>
            {contacts.map(c => <option key={c.id} value={c.id}>{c.first_name} {c.last_name}</option>)}
          </Select>
          <Input label="Location" placeholder="Zoom, office, phone…" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} maxLength={255} />
        </div>
        <Textarea label="Notes" placeholder="Notes (optional)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={3} />
      </form>
    </Modal>
  );
}

// One agenda/grid entry, styled by lane.
function ItemChip({ item, onClick, compact }) {
  const style = TYPE_STYLES[item.type] || TYPE_STYLES.meeting_log;
  const clickable = item.type !== 'meeting_log';
  const context = item.company_name || item.deal_title || item.contact_name || (item.type === 'meeting_log' ? item.source : null);
  const body = (
    <>
      <span className="block truncate font-medium">{item.title}</span>
      <span className="block text-[11px] opacity-75 truncate">
        {item.type === 'task' ? TYPE_LABELS.task : fmtTime(item.starts_at)}
        {context ? ` · ${context}` : ''}
      </span>
    </>
  );
  if (!clickable) {
    return (
      <div className={`w-full text-left border rounded-md px-2 ${compact ? 'py-1' : 'py-1.5'} text-xs ${style}`}
        title={`${TYPE_LABELS.meeting_log}${item.source ? ` (${item.source})` : ''} — read-only`}>
        {body}
      </div>
    );
  }
  return (
    <button type="button" onClick={onClick}
      className={`w-full text-left border rounded-md px-2 ${compact ? 'py-1' : 'py-1.5'} text-xs transition ${style}`}>
      {body}
    </button>
  );
}

export default function Calendar() {
  const navigate = useNavigate();
  const [view, setView] = useState('week'); // 'week' | 'agenda'
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [items, setItems] = useState(null); // null = loading
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // null | { meeting?, defaultStart? }
  const [links, setLinks] = useState({ companies: [], contacts: [], deals: [] });

  // Visible range: the week grid shows exactly its 7 days; the agenda list
  // reads two weeks ahead from today (a planning horizon, not a paging UI).
  const range = useMemo(() => {
    if (view === 'week') return { from: weekStart, to: addDays(weekStart, 7) };
    const today = startOfDay(new Date());
    return { from: today, to: addDays(today, 14) };
  }, [view, weekStart]);

  const load = useCallback(() => {
    api.get(`/calendar/agenda?from=${encodeURIComponent(range.from.toISOString())}&to=${encodeURIComponent(range.to.toISOString())}`)
      .then((r) => { setItems(r.data.items || []); setError(''); })
      // Resolve items to [] on failure too — otherwise items stays null and the
      // page shows the error banner AND "Loading your calendar…" forever.
      .catch((err) => { setItems([]); setError(err.response?.data?.error || 'Failed to load your calendar'); });
  }, [range]);

  useEffect(() => { setItems(null); load(); }, [load]);

  // Link options for the meeting form — one fetch, tolerated failure (the
  // form still works without selects populated).
  useEffect(() => {
    Promise.all([api.get('/companies'), api.get('/contacts'), api.get('/deals')])
      .then(([co, ct, d]) => setLinks({
        companies: co.data || [],
        contacts: ct.data || [],
        deals: d.data || [],
      }))
      .catch(() => {});
  }, []);

  const openItem = (item) => {
    if (item.type === 'task') { navigate('/tasks'); return; }
    if (item.type === 'meeting') {
      api.get(`/meetings/${item.id}`)
        .then((r) => setModal({ meeting: r.data }))
        .catch(() => setModal({ meeting: item }));
    }
  };

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );
  const itemsForDay = (day) => (items || []).filter((i) => sameDay(new Date(i.starts_at), day));

  // Agenda view: group visible items by day, in order.
  const agendaGroups = useMemo(() => {
    const groups = [];
    (items || []).forEach((i) => {
      const d = startOfDay(new Date(i.starts_at));
      const last = groups[groups.length - 1];
      if (last && sameDay(last.day, d)) last.items.push(i);
      else groups.push({ day: d, items: [i] });
    });
    return groups;
  }, [items]);

  const today = startOfDay(new Date());
  const weekLabel = `${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${addDays(weekStart, 6).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Nav active="calendar" />
      <Container size="wide" className="flex-1">
        <PageHeader
          title="Calendar"
          subtitle="Meetings, due tasks, and logged calls in one place."
          actionSize="sm"
          actions={
            <>
              {view === 'week' && (
                <div className="flex items-center gap-1 mr-1">
                  <Button variant="secondary" size="sm" icon="chevron-left" aria-label="Previous week" onClick={() => setWeekStart(addDays(weekStart, -7))} />
                  <Button variant="secondary" size="sm" onClick={() => setWeekStart(startOfWeek(new Date()))}>Today</Button>
                  <Button variant="secondary" size="sm" icon="chevron-right" aria-label="Next week" onClick={() => setWeekStart(addDays(weekStart, 7))} />
                  <span className="text-sm text-gray-600 ml-2 whitespace-nowrap">{weekLabel}</span>
                </div>
              )}
              <div className="flex items-center gap-1" role="group" aria-label="Calendar view">
                <Button variant={view === 'week' ? 'primary' : 'secondary'} size="sm" aria-pressed={view === 'week'} onClick={() => setView('week')}>Week</Button>
                <Button variant={view === 'agenda' ? 'primary' : 'secondary'} size="sm" aria-pressed={view === 'agenda'} onClick={() => setView('agenda')}>Agenda</Button>
              </div>
            </>
          }
          primaryAction={{ label: 'New meeting', icon: 'plus', onClick: () => setModal({ defaultStart: new Date() }) }}
        />

        <div className="space-y-6">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          {items === null ? (
            <Card role="status" aria-label="Loading your calendar"><Skeleton lines={6} /></Card>
          ) : view === 'week' ? (
            <Card padding="none" className="overflow-x-auto">
              <div className="grid grid-cols-7 min-w-[840px]">
                {days.map((day) => {
                  const isToday = sameDay(day, today);
                  const dayItems = itemsForDay(day);
                  return (
                    <div key={day.toISOString()} className="border-r border-gray-100 last:border-r-0 flex flex-col min-h-[280px]">
                      <div className={`px-2 py-2 text-center border-b ${isToday ? 'bg-info-50 border-info-100' : 'border-gray-100'}`}>
                        <div className="text-[11px] uppercase tracking-wider text-gray-400">
                          {day.toLocaleDateString(undefined, { weekday: 'short' })}
                        </div>
                        <div className={`text-sm font-semibold ${isToday ? 'text-brand-blue' : 'text-gray-900'}`}>
                          {day.getDate()}
                        </div>
                      </div>
                      <div className="p-1.5 space-y-1.5 flex-1">
                        {dayItems.map((i) => (
                          <ItemChip key={`${i.type}-${i.id}`} item={i} compact onClick={() => openItem(i)} />
                        ))}
                        <button type="button"
                          onClick={() => setModal({ defaultStart: new Date(day.getTime() + 9 * 3600000) })}
                          className="w-full text-center text-[11px] text-gray-300 hover:text-brand-blue py-1 rounded transition"
                          aria-label={`Add meeting on ${fmtDayHeading(day)}`}>
                          +
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          ) : agendaGroups.length === 0 ? (
            <Card padding="none">
              <EmptyState
                icon="calendar"
                title="Nothing on the calendar"
                message="The next two weeks are wide open. Schedule a meeting to get your week planned — due tasks will show up here too."
                action={<Button variant="primary" icon="plus" onClick={() => setModal({ defaultStart: new Date() })}>Schedule a meeting</Button>}
              />
            </Card>
          ) : (
            <div className="space-y-4">
              {agendaGroups.map((g) => (
                <Card key={g.day.toISOString()} padding="none">
                  <div className={`px-4 py-2.5 border-b border-gray-100 text-sm font-semibold ${sameDay(g.day, today) ? 'text-brand-blue' : 'text-gray-900'}`}>
                    {sameDay(g.day, today) ? `Today — ${fmtDayHeading(g.day)}` : fmtDayHeading(g.day)}
                  </div>
                  <div className="p-3 space-y-1.5">
                    {g.items.map((i) => (
                      <ItemChip key={`${i.type}-${i.id}`} item={i} onClick={() => openItem(i)} />
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          )}

          {view === 'week' && items !== null && items.length === 0 && (
            <p className="text-center text-sm text-gray-400">
              A quiet week — click any day's <span className="text-gray-500 font-medium">+</span> to schedule something.
            </p>
          )}
        </div>
      </Container>

      {modal && (
        <MeetingForm
          meeting={modal.meeting}
          defaultStart={modal.defaultStart}
          companies={links.companies}
          contacts={links.contacts}
          deals={links.deals}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
        />
      )}
    </div>
  );
}
