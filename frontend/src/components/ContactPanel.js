// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Contact drawer — the contact record surface, mirroring DealPanel. Hero
// (name / title / company / status / owner / last touch / CTAs) on top, two
// tabs below: Overview (details, deals, notes) · Activity (timeline of
// activities + meetings, open tasks, emails sent from the CRM).
//
// Reached from the Contacts list (row click), `/contacts/:id` (deep link;
// App.js routes it to Contacts, which reads the param) and `?contactId=N`.
// Every read is an existing endpoint: GET /contacts/:id, /contacts/:id/deals,
// /contacts/:id/activities, /meetings?contact_id=, /tasks?contact_id=,
// /emails/sends?contact_id=, /sequences (for the enroll picker).
//
// Actions: log activity · add task · email (true prefill-capable composer) ·
// enroll in a sequence (campaigns_enabled) · "Ask the copilot"
// (/chat?seed=contact&contact_id=N) · edit (hands back to Contacts' form) ·
// mark touched · delete.
//
// Public API: <ContactPanel contactId companies onClose onChanged onEdit />.

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api, { downloadBlob } from '../api';
import { useAuth } from '../AuthContext';
import EmailComposerModal from './EmailComposerModal';
import EnrichModal from './EnrichModal';
import { Alert, Button, Drawer, Icon, Menu, Modal, Select, Skeleton, StatusBadge, Tabs } from './ui';
import { AddTaskModal, LogActivityModal } from './deal/actionModals';
import { FactList, fmtDate, fmtMoney, LinkButton, PhoneLink, Section, useAsyncAction } from './deal/shared';
import { flagOn, useOrgMembers } from './deal/useDealData';
import { stageTone } from './deal/DealHero';
import { getStageConfig } from '../stages';

const CONTACT_STATUSES = ['prospect', 'lead', 'customer', 'inactive'];
const STATUS_TONE = { customer: 'success', lead: 'info', prospect: 'neutral', inactive: 'neutral' };
const DAY_MS = 86400000;

function fullName(c) {
  return `${c?.first_name || ''} ${c?.last_name || ''}`.trim() || c?.email || 'Contact';
}

function daysSince(ts) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / DAY_MS);
}

// -- Merged timeline: activities on this contact + meetings where they're
// the linked contact. Same visual language as the deal timeline.
const KIND_ICON = { meeting: 'users', call: 'phone', email: 'mail', sms: 'chat', note: 'edit', demo: 'star' };

function ContactTimeline({ contactId, refreshKey }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      api.get(`/contacts/${contactId}/activities`).catch(() => ({ data: [] })),
      api.get(`/meetings?contact_id=${contactId}`).catch(() => ({ data: [] })),
    ]).then(([acts, meets]) => {
      if (!alive) return;
      const activityRows = (Array.isArray(acts.data) ? acts.data : []).slice(0, 50).map((a) => ({
        kind: 'activity', id: `a-${a.id}`, ts: a.activity_date || a.created_at, title: a.title, type: a.type,
        meta: [a.duration_minutes ? `${a.duration_minutes}m` : null, a.outcome, a.deal_id ? `deal #${a.deal_id}` : null].filter(Boolean).join(' · '),
        body: a.description,
      }));
      const meetingRows = (Array.isArray(meets.data) ? meets.data : []).slice(0, 50).map((m) => ({
        kind: 'meeting', id: `m-${m.id}`, ts: m.starts_at || m.created_at, title: m.title || 'Meeting', type: 'meeting',
        meta: [m.location, m.deal_title].filter(Boolean).join(' · '), body: m.notes || m.description,
      }));
      setItems([...activityRows, ...meetingRows].sort((a, b) => new Date(b.ts) - new Date(a.ts)));
    }).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [contactId, refreshKey]);

  if (loading) return <Skeleton lines={3} />;
  if (items.length === 0) return <p className="text-xs text-gray-500">Nothing logged with this person yet. Log a call or note above.</p>;

  return (
    <ol className="relative space-y-3 text-xs">
      <div className="absolute bottom-0 left-2.5 top-0 w-px bg-gray-200" aria-hidden="true" />
      {items.map((item) => (
        <li key={item.id} className="relative pl-8">
          <span className={`absolute left-0 top-0 flex h-5 w-5 items-center justify-center rounded-full ring-2 ring-white ${item.kind === 'meeting' ? 'bg-purple-100 text-purple-700' : 'bg-info-100 text-brand-blue'}`}>
            <Icon name={KIND_ICON[item.type] || 'clock'} size={12} />
          </span>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-semibold text-gray-900">{item.title}</span>
            <span className="text-[10px] uppercase text-gray-500">{item.type}</span>
            <span className="text-gray-400">{item.ts ? new Date(item.ts).toLocaleString() : ''}</span>
          </div>
          {item.meta && <p className="mt-0.5 text-gray-600">{item.meta}</p>}
          {item.body && <p className="mt-0.5 whitespace-pre-wrap text-gray-700">{item.body}</p>}
        </li>
      ))}
    </ol>
  );
}

const TASK_TONE = { open: 'info', in_progress: 'warning', done: 'success' };
const PRIORITY_TONE = { low: 'neutral', medium: 'warning', high: 'error' };

function ContactTasks({ contactId, refreshKey }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const { run, error } = useAsyncAction();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get(`/tasks?contact_id=${contactId}`)
      .then((r) => { if (alive) setTasks(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (alive) setTasks([]); })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [contactId, refreshKey, tick]);

  const markDone = async (id) => {
    if (await run(() => api.put(`/tasks/${id}`, { status: 'done' }))) setTick((t) => t + 1);
  };

  if (loading) return <Skeleton lines={2} />;
  const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'completed' && t.status !== 'cancelled');
  return (
    <div>
      {error && <Alert tone="danger" className="mb-2 text-xs">{error}</Alert>}
      {open.length === 0 ? (
        <p className="text-xs text-gray-500">No open tasks for this person.</p>
      ) : (
        <ul className="space-y-1.5 text-xs">
          {open.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 rounded border border-gray-200 px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-gray-900">{t.title}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-gray-500">
                  {t.due_date && <span>Due {fmtDate(t.due_date)}</span>}
                  {t.priority && <StatusBadge tone={PRIORITY_TONE[t.priority] || 'neutral'} label={t.priority} />}
                  <StatusBadge tone={TASK_TONE[t.status] || 'neutral'} label={String(t.status || 'open').replace('_', ' ')} />
                </div>
              </div>
              <LinkButton tone="success" onClick={() => markDone(t.id)}>Mark done</LinkButton>
            </li>
          ))}
        </ul>
      )}
      <a href="/tasks" className="mt-2 inline-block text-xs font-medium text-brand-blue hover:underline">Open Tasks</a>
    </div>
  );
}

function ContactEmails({ contactId, refreshKey }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get(`/emails/sends?contact_id=${contactId}`)
      .then((r) => { if (alive) setItems(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (alive) setItems([]); })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [contactId, refreshKey]);
  if (loading) return <Skeleton lines={2} />;
  if (items.length === 0) return <p className="text-xs text-gray-500">No emails sent to this person from the CRM yet.</p>;
  return (
    <ul className="space-y-2 text-xs">
      {items.map((e) => (
        <li key={e.id} className="rounded border border-gray-200 px-2 py-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="min-w-0 truncate font-semibold text-gray-900">{e.subject || '(no subject)'}</span>
            {e.opened_at
              ? <StatusBadge tone="success" label={`Opened ${new Date(e.opened_at).toLocaleDateString()}`} />
              : <StatusBadge tone="neutral" label="Sent" />}
          </div>
          <div className="mt-0.5 text-[11px] text-gray-500">{new Date(e.sent_at).toLocaleString()}{e.sequence_id ? ' · sequence' : ''}</div>
        </li>
      ))}
    </ul>
  );
}

// -- Deals where this contact is the primary contact.
function ContactDeals({ contactId, profile, onOpenDeal }) {
  const [deals, setDeals] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get(`/contacts/${contactId}/deals`)
      .then((r) => { if (alive) setDeals(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (alive) setDeals([]); });
    return () => { alive = false; };
  }, [contactId]);
  if (deals === null) return <Skeleton lines={2} />;
  if (deals.length === 0) return <p className="text-xs text-gray-500">No deals with this person as the primary contact.</p>;
  return (
    <ul className="space-y-1.5 text-xs">
      {deals.map((d) => {
        const cfg = getStageConfig(profile, { dealType: d.deal_type || 'default' });
        return (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => onOpenDeal(d)}
              className="flex w-full items-center justify-between gap-2 rounded border border-gray-200 px-2 py-2 text-left hover:border-brand-blue hover:bg-info-50 min-h-[44px]"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-gray-900">{d.title}</span>
                <span className="block text-gray-500">{[fmtMoney(d.amount), d.expected_close_date ? `close ${fmtDate(d.expected_close_date)}` : null, d.next_step ? `next: ${d.next_step}` : null].filter(Boolean).join(' · ')}</span>
              </span>
              <StatusBadge tone={stageTone(d.stage)} label={cfg.stageLabel(d.stage)} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// -- Enroll in a sequence: pick → confirm → enroll. Uses the existing
// POST /sequences/:id/enroll; skipped = already enrolled or no email.
function EnrollSequenceModal({ open, contact, onClose, onEnrolled }) {
  const [sequences, setSequences] = useState(null);
  const [emailConfigured, setEmailConfigured] = useState(true);
  const [sequenceId, setSequenceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setSequenceId(''); setError(''); setResult(null); setSequences(null);
    api.get('/sequences')
      .then((r) => {
        const rows = Array.isArray(r.data?.sequences) ? r.data.sequences : [];
        setSequences(rows);
        setEmailConfigured(r.data?.email_configured !== false);
        const firstActive = rows.find((s) => s.is_active && s.step_count > 0);
        if (firstActive) setSequenceId(String(firstActive.id));
      })
      .catch((err) => { setSequences([]); setError(err.response?.data?.error || 'Couldn\'t load sequences.'); });
  }, [open]);

  const chosen = (sequences || []).find((s) => String(s.id) === String(sequenceId));

  const enroll = async () => {
    if (!chosen) return;
    setBusy(true); setError('');
    try {
      const r = await api.post(`/sequences/${chosen.id}/enroll`, { contact_ids: [contact.id] });
      setResult(r.data || {});
      if ((r.data?.enrolled || 0) > 0) onEnrolled?.(chosen);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to enroll.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Enroll in a sequence"
      description={`${fullName(contact)} will get each step on its schedule, from your workspace's sender identity, with an unsubscribe link.`}
      footer={result ? (
        <Button onClick={onClose}>Close</Button>
      ) : (
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={enroll} disabled={!chosen || !contact?.email} loading={busy} loadingLabel="Enrolling…">
            {chosen ? `Enroll in "${chosen.name}"` : 'Enroll'}
          </Button>
        </>
      )}
    >
      {result ? (
        <Alert tone={result.enrolled > 0 ? 'success' : 'warning'}>
          {result.enrolled > 0
            ? `Enrolled. Step 1 of "${chosen?.name}" goes out on the next send tick.`
            : `Not enrolled — ${result.skipped ? 'already in this sequence (or no email on file).' : 'nothing happened.'}`}
        </Alert>
      ) : (
        <div className="space-y-3">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}
          {!contact?.email && <Alert tone="warning">This contact has no email address, so a sequence can't reach them. Add one first.</Alert>}
          {!emailConfigured && <Alert tone="warning">Email isn't activated on this deployment yet — enrollments are recorded but nothing will send until it is.</Alert>}
          {sequences === null ? <Skeleton lines={2} /> : sequences.length === 0 ? (
            <p className="text-sm text-gray-600">No sequences yet. <a href="/sequences" className="text-brand-blue hover:underline">Build one</a> first.</p>
          ) : (
            <Select label="Sequence" value={sequenceId} onChange={(e) => setSequenceId(e.target.value)}>
              <option value="">— Choose a sequence —</option>
              {sequences.map((s) => (
                <option key={s.id} value={s.id} disabled={!s.is_active || !s.step_count}>
                  {s.name}{!s.is_active ? ' (paused)' : !s.step_count ? ' (no steps)' : ` · ${s.step_count} step${s.step_count === 1 ? '' : 's'}`}
                </option>
              ))}
            </Select>
          )}
          {chosen && (
            <p className="text-xs text-gray-500">
              {chosen.active_enrollments || 0} active enrollment{chosen.active_enrollments === 1 ? '' : 's'} · steps: {chosen.step_count}.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function ContactPanel({ contactId, companies, onClose, onChanged, onEdit }) {
  const { user, orgFeatures } = useAuth();
  const navigate = useNavigate();
  const flag = useCallback((name) => flagOn(orgFeatures, name), [orgFeatures]);
  const profile = user?.org_profile || 'generic';
  const members = useOrgMembers();

  const [contact, setContact] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState('overview');
  const [emailOpen, setEmailOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrichOpen, setEnrichOpen] = useState(false);
  const [commsRefreshKey, setCommsRefreshKey] = useState(0);
  const [tasksRefreshKey, setTasksRefreshKey] = useState(0);
  const [emailsRefreshKey, setEmailsRefreshKey] = useState(0);
  const [notice, setNotice] = useState('');
  const { run: runAction, error: actionError } = useAsyncAction();

  useEffect(() => {
    let alive = true;
    setLoadError('');
    setContact(null);
    api.get(`/contacts/${contactId}`)
      .then((r) => { if (alive) setContact(r.data); })
      .catch((err) => { if (alive) setLoadError(err.response?.status === 404 ? 'Contact not found.' : (err.response?.data?.error || 'Couldn\'t load this contact.')); });
    return () => { alive = false; };
  }, [contactId]);

  const patchContact = async (patch) => {
    const r = await api.put(`/contacts/${contactId}`, patch);
    setContact(r.data);
    onChanged?.();
    return r.data;
  };

  const markTouched = () => runAction(async () => {
    const r = await api.post(`/contacts/${contactId}/touch`);
    setContact((c) => ({ ...c, ...r.data }));
    onChanged?.();
    setNotice('Marked touched — the reconnect clock starts over.');
  });

  const remove = async () => {
    if (!window.confirm(`Delete ${fullName(contact)}? This cannot be undone.`)) return;
    await api.delete(`/contacts/${contactId}`);
    onChanged?.();
    onClose();
  };

  const askCopilot = () => navigate(`/chat?seed=contact&contact_id=${contactId}`);

  if (!contact) {
    return (
      <Drawer open onClose={onClose} size="lg" title={loadError ? 'Contact' : 'Loading contact'}>
        {loadError ? (
          <Alert tone="danger" title="Couldn't load this contact" action={<Button size="sm" variant="secondary" onClick={onClose}>Close</Button>}>
            {loadError}
          </Alert>
        ) : (
          <div className="space-y-6"><Skeleton lines={3} /><Skeleton lines={4} barClassName="h-3" /></div>
        )}
      </Drawer>
    );
  }

  const company = contact.company_id ? (companies || []).find((c) => c.id === contact.company_id) : null;
  const owner = contact.owner_user_id
    ? (members.find((m) => Number(m.id) === Number(contact.owner_user_id))?.name || members.find((m) => Number(m.id) === Number(contact.owner_user_id))?.email || `User #${contact.owner_user_id}`)
    : '—';
  const touchDays = daysSince(contact.last_touch_at);
  const overdue = contact.cadence_days != null && touchDays != null && touchDays > contact.cadence_days;
  const aiEnabled = flag('ai_features_enabled');
  const campaigns = flag('campaigns_enabled');
  const cs = flag('customer_success_enabled');

  const overflowItems = [
    ...(onEdit ? [{ label: 'Edit details', icon: 'edit', onClick: () => onEdit(contact) }] : []),
    ...(contact.email ? [{ label: 'Send email', icon: 'mail', onClick: () => setEmailOpen(true) }] : []),
    ...(campaigns ? [{ label: 'Enroll in sequence', icon: 'mail', onClick: () => setEnrollOpen(true) }] : []),
    ...(cs ? [{ label: 'Mark touched', icon: 'check', onClick: markTouched }] : []),
    ...(flag('enrichment_enabled') ? [{ label: 'Enrich', icon: 'sparkles', onClick: () => setEnrichOpen(true) }] : []),
    {
      label: 'One-pager PDF', icon: 'download',
      onClick: () => downloadBlob(`/contacts/${contactId}/one-pager.pdf`, `${fullName(contact).replace(/[^a-zA-Z0-9._-]/g, '_')}-one-pager.pdf`)
        .catch(() => setNotice('')),
    },
    { type: 'divider' },
    { label: 'Delete contact', icon: 'trash', danger: true, onClick: remove },
  ];

  const tabs = [
    { id: 'overview', label: 'Overview', panelId: 'contact-tab-overview' },
    { id: 'activity', label: 'Activity', panelId: 'contact-tab-activity' },
  ];

  const openDeal = (d) => navigate(`/deals?dealId=${d.id}`);

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        size="lg"
        title={fullName(contact)}
        description={(
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {contact.job_title && <span className="inline-flex items-center gap-1"><Icon name="briefcase" size={14} className="text-gray-400" />{contact.job_title}</span>}
            {company ? (
              <button type="button" onClick={() => navigate(`/companies?search=${encodeURIComponent(company.name)}`)} className="inline-flex items-center gap-1 hover:text-brand-blue hover:underline">
                <Icon name="building" size={14} className="text-gray-400" />{company.name}
              </button>
            ) : contact.company_id ? <span className="text-gray-400">Company #{contact.company_id}</span> : <span className="text-gray-400">No company linked</span>}
          </span>
        )}
        bodyClassName="pt-4"
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={STATUS_TONE[contact.status] || 'neutral'} label={contact.status || 'prospect'} size="md" className="capitalize" />
            <Select
              size="sm"
              aria-label="Change status"
              value={contact.status || 'prospect'}
              onChange={(e) => runAction(() => patchContact({ status: e.target.value }))}
              wrapperClassName="w-36"
            >
              {CONTACT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
            {overdue && <StatusBadge tone="error" size="md" label="Gone quiet" />}
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            <div className="min-w-0">
              <dt className="text-xs uppercase tracking-wider text-gray-500">Email</dt>
              <dd className="truncate text-sm text-gray-900">
                {contact.email ? <a href={`mailto:${contact.email}`} className="hover:text-brand-blue hover:underline">{contact.email}</a> : '—'}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs uppercase tracking-wider text-gray-500">Phone</dt>
              <dd className="truncate text-sm text-gray-900">{contact.phone ? <PhoneLink number={contact.phone} /> : '—'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs uppercase tracking-wider text-gray-500">Owner</dt>
              <dd className="truncate text-sm text-gray-900">{owner}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs uppercase tracking-wider text-gray-500">Last touched</dt>
              <dd className={`truncate text-sm ${overdue ? 'font-semibold text-danger-600' : 'text-gray-900'}`}>
                {touchDays == null ? 'Never' : touchDays === 0 ? 'Today' : `${touchDays}d ago`}
                {contact.cadence_days != null && <span className="ml-1 text-xs font-normal text-gray-400">· every {contact.cadence_days}d</span>}
              </dd>
            </div>
          </dl>

          {(notice || actionError) && (
            <Alert tone={actionError ? 'danger' : 'success'} onDismiss={() => setNotice('')} className="text-xs">{actionError || notice}</Alert>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon="plus" onClick={() => setLogOpen(true)}>Log activity</Button>
            {contact.email && <Button size="sm" variant="secondary" icon="mail" onClick={() => setEmailOpen(true)}>Email</Button>}
            <Button size="sm" variant="secondary" icon="check" onClick={() => setTaskOpen(true)}>Add task</Button>
            {campaigns && <Button size="sm" variant="secondary" icon="mail" onClick={() => setEnrollOpen(true)}>Enroll in sequence</Button>}
            {aiEnabled && (
              <Button size="sm" variant="secondary" icon="chat" onClick={askCopilot} title="Open the copilot with this contact loaded">Ask the copilot</Button>
            )}
            <Menu size="sm" label="More actions" items={overflowItems} />
          </div>
        </div>

        <Tabs items={tabs} value={tab} onChange={setTab} size="sm" aria-label="Contact sections" className="sticky top-0 z-10 -mx-6 mt-4 bg-white px-6" />

        <div id={`contact-tab-${tab}`} role="tabpanel" className="pt-1">
          {tab === 'overview' && (
            <div>
              <Section title="Details" defaultOpen summary="Contact record fields">
                <FactList items={[
                  ['Email', contact.email],
                  ['Phone', contact.phone ? <PhoneLink number={contact.phone} /> : null],
                  ['Job title', contact.job_title],
                  ['Company', company?.name || (contact.company_id ? `#${contact.company_id}` : null)],
                  ['Status', contact.status, 'capitalize'],
                  ['Owner', owner],
                  ['Cadence', contact.cadence_days != null ? `Every ${contact.cadence_days} days` : 'None'],
                  Array.isArray(contact.tags) && contact.tags.length ? ['Tags', contact.tags.join(', ')] : null,
                  ['Created', fmtDate(contact.created_at)],
                ]} />
                {onEdit && <LinkButton className="mt-2" onClick={() => onEdit(contact)}>Edit details</LinkButton>}
              </Section>
              <Section title="Deals" defaultOpen summary="Deals where this person is the primary contact">
                <ContactDeals contactId={contactId} profile={profile} onOpenDeal={openDeal} />
              </Section>
              <Section title="Notes" summary={contact.notes ? contact.notes.slice(0, 80) : 'No notes yet'}>
                {contact.notes ? <p className="whitespace-pre-wrap text-sm text-gray-800">{contact.notes}</p> : <p className="text-xs text-gray-500">No notes yet.</p>}
              </Section>
              {contact.custom_fields && Object.keys(contact.custom_fields).length > 0 && (
                <Section title="Custom fields" summary={`${Object.keys(contact.custom_fields).length} field${Object.keys(contact.custom_fields).length === 1 ? '' : 's'}`}>
                  <FactList items={Object.entries(contact.custom_fields).map(([k, v]) => [k.replace(/^enrichment_/, '').replace(/_/g, ' '), typeof v === 'object' ? JSON.stringify(v) : String(v)])} />
                </Section>
              )}
            </div>
          )}
          {tab === 'activity' && (
            <div>
              <Section title="Timeline" defaultOpen summary="Calls, emails, notes and meetings with this person">
                <ContactTimeline contactId={contactId} refreshKey={commsRefreshKey} />
              </Section>
              <Section title="Open tasks" defaultOpen summary="Tasks linked to this person">
                <ContactTasks contactId={contactId} refreshKey={tasksRefreshKey} />
              </Section>
              <Section title="Sent emails" summary="Emails sent from the CRM, with open tracking">
                <ContactEmails contactId={contactId} refreshKey={emailsRefreshKey} />
              </Section>
            </div>
          )}
        </div>
      </Drawer>

      <LogActivityModal
        open={logOpen}
        deal={null}
        contact={contact}
        onClose={() => setLogOpen(false)}
        onLogged={() => { setCommsRefreshKey((k) => k + 1); onChanged?.(); }}
      />
      <AddTaskModal
        open={taskOpen}
        deal={null}
        contact={contact}
        onClose={() => setTaskOpen(false)}
        onCreated={() => setTasksRefreshKey((k) => k + 1)}
      />
      <EmailComposerModal
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        onSent={() => { setEmailOpen(false); setEmailsRefreshKey((k) => k + 1); }}
        contact={contact}
      />
      <EnrollSequenceModal
        open={enrollOpen}
        contact={contact}
        onClose={() => setEnrollOpen(false)}
        onEnrolled={() => setEmailsRefreshKey((k) => k + 1)}
      />
      <EnrichModal
        open={enrichOpen}
        entity="contacts"
        record={contact}
        recordLabel={fullName(contact)}
        onClose={() => setEnrichOpen(false)}
        onApplied={async () => {
          try { const r = await api.get(`/contacts/${contactId}`); setContact(r.data); } catch { /* keep current */ }
          onChanged?.();
        }}
      />
    </>
  );
}
