// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Sequences — multi-step email drips at /sequences (campaigns_enabled).
//
// One page, three surfaces (mirrors the EmailTemplates management style):
//   - List: every sequence with step/active-enrollment counts + activate/pause.
//   - Builder: ordered steps, each with delay-days ("days after the previous
//     step" — after enrollment for step 1), subject, and body using the same
//     {{contact.name}} merge syntax as email templates.
//   - Enrollments: per-sequence enrollment table with status + next send,
//     a stop action, and an enroll flow (contact multi-select).
//
// Sending is entirely backend-worker-driven; this page only manages config
// and enrollment. When the email service isn't configured the backend flags
// it in GET /api/sequences and we show the same amber "not activated" banner
// style the AI surfaces use — sequences stay editable, sends stay queued.

import React, { useEffect, useMemo, useState } from 'react';
import api from '../api';
import Nav from '../components/Nav';
import DataTable from '../components/DataTable';
import { Alert, Button, Card, Container, Icon, Input, Modal, PageHeader, Skeleton, StatusBadge, Textarea } from '../components/ui';

const EMPTY_STEP = { delay_days: 0, subject: '', body_template: '' };

const STATUS_TONE = {
  active:       'success',
  completed:    'info',
  stopped:      'neutral',
  unsubscribed: 'warning',
};

function fmtDate(v) {
  if (!v) return '—';
  try { return new Date(v).toLocaleString(); } catch { return String(v); }
}

// Backend rates are 0–1 fractions (3dp); render as a percentage.
function fmtPct(v) {
  return `${Math.round((Number(v) || 0) * 1000) / 10}%`;
}

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

export default function Sequences() {
  const [list, setList] = useState([]);
  const [emailConfigured, setEmailConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Builder state: null | { id: 'new' | <id>, name, is_active, steps: [] }
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);

  // Enrollments drawer: { sequence, rows, loading } | null
  const [viewing, setViewing] = useState(null);

  // Stats drawer: { sequence, data, loading } | null
  const [stats, setStats] = useState(null);

  // Enroll modal: { sequence, contacts, selected:Set, search, submitting } | null
  const [enrolling, setEnrolling] = useState(null);
  const [enrollNotice, setEnrollNotice] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/sequences');
      setList(r.data?.sequences || []);
      setEmailConfigured(r.data?.email_configured !== false);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load sequences');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // ---- builder -------------------------------------------------------------

  const openNew = () => setEditing({ id: 'new', name: '', is_active: true, steps: [{ ...EMPTY_STEP }] });

  const openEdit = async (seq) => {
    try {
      const r = await api.get(`/sequences/${seq.id}`);
      setEditing({
        id: seq.id,
        name: r.data.name,
        is_active: r.data.is_active,
        steps: (r.data.steps || []).map((s) => ({
          delay_days: s.delay_days, subject: s.subject, body_template: s.body_template,
        })),
      });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load sequence');
    }
  };

  const setStep = (i, patch) => {
    setEditing((e) => ({
      ...e,
      steps: e.steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    }));
  };

  const moveStep = (i, dir) => {
    setEditing((e) => {
      const steps = [...e.steps];
      const j = i + dir;
      if (j < 0 || j >= steps.length) return e;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...e, steps };
    });
  };

  const removeStep = (i) => {
    setEditing((e) => ({ ...e, steps: e.steps.filter((_, idx) => idx !== i) }));
  };

  const saveSequence = async () => {
    if (!editing.name.trim()) { setError('Sequence name is required.'); return; }
    if (editing.steps.length === 0) { setError('Add at least one step.'); return; }
    for (let i = 0; i < editing.steps.length; i++) {
      const s = editing.steps[i];
      if (!s.subject.trim() || !s.body_template.trim()) {
        setError(`Step ${i + 1} needs a subject and a body.`);
        return;
      }
    }
    setSaving(true);
    setError('');
    const payload = {
      name: editing.name.trim(),
      is_active: editing.is_active,
      steps: editing.steps.map((s) => ({
        delay_days: Number(s.delay_days) || 0,
        subject: s.subject,
        body_template: s.body_template,
      })),
    };
    try {
      if (editing.id === 'new') await api.post('/sequences', payload);
      else await api.put(`/sequences/${editing.id}`, payload);
      setEditing(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save sequence');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (seq) => {
    try {
      await api.put(`/sequences/${seq.id}`, { is_active: !seq.is_active });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update sequence');
    }
  };

  const removeSequence = async (seq) => {
    if (!window.confirm(`Delete "${seq.name}"? Enrollments are removed too — nothing further will send.`)) return;
    try {
      await api.delete(`/sequences/${seq.id}`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete sequence');
    }
  };

  // ---- enrollments ----------------------------------------------------------

  const openEnrollments = async (seq) => {
    setViewing({ sequence: seq, rows: [], loading: true });
    try {
      const r = await api.get(`/sequences/${seq.id}/enrollments`);
      setViewing({ sequence: seq, rows: r.data || [], loading: false });
    } catch (err) {
      setViewing(null);
      setError(err.response?.data?.error || 'Failed to load enrollments');
    }
  };

  // ---- stats ----------------------------------------------------------------

  const openStats = async (seq) => {
    setStats({ sequence: seq, data: null, loading: true });
    try {
      const r = await api.get(`/sequences/${seq.id}/stats`);
      setStats({ sequence: seq, data: r.data, loading: false });
    } catch (err) {
      setStats(null);
      setError(err.response?.data?.error || 'Failed to load sequence stats');
    }
  };

  const stopEnrollment = async (enr) => {
    try {
      await api.post(`/sequences/enrollments/${enr.id}/stop`);
      if (viewing) openEnrollments(viewing.sequence);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to stop enrollment');
    }
  };

  // ---- enroll flow -----------------------------------------------------------

  const openEnroll = async (seq) => {
    setEnrollNotice('');
    setEnrolling({ sequence: seq, contacts: null, selected: new Set(), search: '', submitting: false });
    try {
      const r = await api.get('/contacts');
      setEnrolling((e) => (e ? { ...e, contacts: r.data || [] } : e));
    } catch (err) {
      setEnrolling(null);
      setError(err.response?.data?.error || 'Failed to load contacts');
    }
  };

  const toggleContact = (id) => {
    setEnrolling((e) => {
      const selected = new Set(e.selected);
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      return { ...e, selected };
    });
  };

  const submitEnroll = async () => {
    if (!enrolling || enrolling.selected.size === 0) return;
    setEnrolling((e) => ({ ...e, submitting: true }));
    try {
      const r = await api.post(`/sequences/${enrolling.sequence.id}/enroll`, {
        contact_ids: [...enrolling.selected],
      });
      const { enrolled = 0, skipped = 0 } = r.data || {};
      setEnrollNotice(
        `Enrolled ${enrolled} contact${enrolled === 1 ? '' : 's'}${skipped ? ` — ${skipped} skipped (already enrolled or not found)` : ''}.`
      );
      setEnrolling(null);
      load();
    } catch (err) {
      setEnrolling((e) => (e ? { ...e, submitting: false } : e));
      setError(err.response?.data?.error || 'Failed to enroll contacts');
    }
  };

  const filteredContacts = useMemo(() => {
    if (!enrolling?.contacts) return [];
    const q = (enrolling.search || '').toLowerCase().trim();
    if (!q) return enrolling.contacts;
    return enrolling.contacts.filter((c) =>
      `${c.first_name || ''} ${c.last_name || ''} ${c.email || ''}`.toLowerCase().includes(q)
    );
  }, [enrolling]);

  // ---------------------------------------------------------------------------

  const listColumns = [
    { key: 'name', label: 'Name' },
    {
      key: 'is_active', label: 'Status', width: '150px',
      // The badge doubles as the pause/activate toggle so the row's action
      // column stays to the three drill-ins.
      render: (s) => (
        <button
          type="button"
          onClick={() => toggleActive(s)}
          title={s.is_active ? 'Pause this sequence' : 'Activate this sequence'}
          aria-label={`${s.is_active ? 'Pause' : 'Activate'} ${s.name}`}
          className="inline-flex items-center gap-1 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
        >
          <StatusBadge tone={s.is_active ? 'success' : 'neutral'} label={s.is_active ? 'Active' : 'Paused'} />
          <span className="text-[11px] text-gray-400 hover:text-gray-700 hover:underline">{s.is_active ? 'Pause' : 'Activate'}</span>
        </button>
      ),
    },
    { key: 'step_count', label: 'Steps', align: 'right', width: '90px' },
    { key: 'active_enrollments', label: 'Active enrollments', align: 'right', width: '160px' },
  ];

  const enrollmentColumns = [
    {
      key: 'contact', label: 'Contact',
      render: (e) => (
        <div>
          <div className="font-medium text-gray-900">{`${e.first_name || ''} ${e.last_name || ''}`.trim() || '(deleted contact)'}</div>
          <div className="text-xs text-gray-500 font-normal">{e.email}</div>
        </div>
      ),
    },
    { key: 'status', label: 'Status', render: (e) => <StatusBadge tone={STATUS_TONE[e.status] || 'neutral'} label={e.status} /> },
    { key: 'current_step', label: 'Step', align: 'right', width: '70px' },
    { key: 'next_send_at', label: 'Next send', render: (e) => (e.status === 'active' ? fmtDate(e.next_send_at) : '—') },
    { key: 'last_sent_at', label: 'Last sent', render: (e) => fmtDate(e.last_sent_at) },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="sequences" />
      <Container>
        <PageHeader
          title="Sequences"
          subtitle={<>Multi-step email drips. Each step sends a set number of days after the previous one. Merge field: <code>{'{{contact.name}}'}</code>.</>}
          primaryAction={!editing ? { label: 'New sequence', onClick: openNew } : undefined}
        />

        <div className="space-y-6">
          {!emailConfigured && (
            <Alert tone="warning" title="Email sending isn't activated on this deployment.">
              You can build sequences and enroll contacts now — nothing will send until an operator
              configures an email transport (<code className="bg-warning-100 px-1 py-0.5 rounded font-mono text-xs">GMAIL_USER</code>/<code className="bg-warning-100 px-1 py-0.5 rounded font-mono text-xs">GMAIL_APP_PASSWORD</code> or <code className="bg-warning-100 px-1 py-0.5 rounded font-mono text-xs">SENDGRID_API_KEY</code>).
              Due steps queue up and start flowing once it's live.
            </Alert>
          )}

          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}
          {enrollNotice && <Alert tone="success" onDismiss={() => setEnrollNotice('')}>{enrollNotice}</Alert>}

          {/* ---- Builder ---- */}
          {editing && (
            <Card title={editing.id === 'new' ? 'New sequence' : 'Edit sequence'}>
              <div className="space-y-4">
                <div className="flex flex-wrap gap-4 items-end">
                  <Input
                    label="Name"
                    required
                    wrapperClassName="flex-1 min-w-[240px]"
                    value={editing.name}
                    maxLength={160}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    placeholder="e.g. New-lead nurture"
                    autoFocus
                  />
                  <label className="flex items-center gap-2 text-sm text-gray-700 pb-2.5">
                    <input
                      type="checkbox"
                      checked={editing.is_active}
                      onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })}
                      className="h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue"
                    />
                    Active (paused sequences don't send)
                  </label>
                </div>

                {editing.steps.map((s, i) => (
                  <div key={i} className="border border-gray-200 rounded p-3 bg-gray-50">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm font-semibold text-gray-800">Step {i + 1}</div>
                      <div className="flex items-center gap-0.5">
                        <StepControl icon="chevron-up" label="Move step up" onClick={() => moveStep(i, -1)} disabled={i === 0} />
                        <StepControl icon="chevron-down" label="Move step down" onClick={() => moveStep(i, 1)} disabled={i === editing.steps.length - 1} />
                        <StepControl icon="x" label="Remove step" onClick={() => removeStep(i)} danger />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                      <Input
                        label={`Wait (days ${i === 0 ? 'after enrollment' : 'after previous step'})`}
                        type="number"
                        min={0}
                        max={365}
                        value={s.delay_days}
                        onChange={(e) => setStep(i, { delay_days: e.target.value })}
                      />
                      <Input
                        label="Subject"
                        required
                        wrapperClassName="sm:col-span-3"
                        value={s.subject}
                        onChange={(e) => setStep(i, { subject: e.target.value })}
                        placeholder={'e.g. Quick question, {{contact.name}}'}
                      />
                    </div>
                    <Textarea
                      label="Body"
                      required
                      wrapperClassName="mt-3"
                      value={s.body_template}
                      onChange={(e) => setStep(i, { body_template: e.target.value })}
                      rows={5}
                      className="font-mono"
                      placeholder={'Hi {{contact.name}},\n\nJust following up…'}
                    />
                  </div>
                ))}

                <Button
                  variant="secondary"
                  size="sm"
                  icon="plus"
                  className="border-dashed"
                  onClick={() => setEditing((e) => ({ ...e, steps: [...e.steps, { ...EMPTY_STEP, delay_days: 3 }] }))}
                >
                  Add step
                </Button>

                <p className="text-xs text-gray-500">
                  Every send includes an unsubscribe link automatically, and unsubscribed contacts are never emailed again.
                </p>

                <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
                  <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
                  <Button onClick={saveSequence} loading={saving} loadingLabel="Saving…">Save sequence</Button>
                </div>
              </div>
            </Card>
          )}

          {/* ---- List ---- */}
          {(loading || list.length > 0 || !editing) && (
            <DataTable
              columns={listColumns}
              data={list}
              loading={loading}
              minWidth="720px"
              rowActions={[
                { label: 'Enroll', onClick: openEnroll },
                { label: 'Enrollments', onClick: openEnrollments, className: 'text-sm font-medium text-gray-700 hover:underline' },
                { label: 'Stats', onClick: openStats, className: 'text-sm font-medium text-gray-700 hover:underline' },
              ]}
              onEdit={openEdit}
              onDelete={(id) => { const seq = list.find((s) => s.id === id); if (seq) removeSequence(seq); }}
              emptyState={{
                icon: 'mail',
                title: 'Put your follow-up on autopilot.',
                message: 'Build a sequence of emails — "welcome, then check in 3 days later, then a final nudge" — enroll contacts, and the CRM sends each step on schedule.',
                action: !editing && <Button icon="plus" onClick={openNew}>Create your first sequence</Button>,
              }}
            />
          )}

        </div>
      </Container>

      {/* ---- Enrollments dialog ---- */}
      <Modal
        open={!!viewing}
        onClose={() => setViewing(null)}
        title={viewing ? `Enrollments — ${viewing.sequence.name}` : ''}
        size="xl"
      >
        {viewing && (
          viewing.loading ? (
            <Skeleton lines={5} />
          ) : (
            <DataTable
              columns={enrollmentColumns}
              data={viewing.rows}
              density="compact"
              stickyHeader={false}
              rowActions={[{ label: 'Stop', onClick: stopEnrollment, disabled: (e) => e.status !== 'active', className: 'text-sm font-medium text-danger-600 hover:underline' }]}
              emptyState={{ icon: 'users', title: 'No contacts enrolled yet', message: 'Use the Enroll action to add some.' }}
            />
          )
        )}
      </Modal>

      {/* ---- Stats dialog ---- */}
      <Modal
        open={!!stats}
        onClose={() => setStats(null)}
        title={stats ? `Stats — ${stats.sequence.name}` : ''}
        size="xl"
      >
        {stats && (stats.loading || !stats.data ? (
          <Skeleton lines={5} />
        ) : (
          <>
            {/* Totals */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5">
              {[
                { label: 'Enrolled', value: stats.data.totals.enrolled },
                { label: 'Sent', value: stats.data.totals.sent },
                { label: 'Opened', value: stats.data.totals.opened, sub: `${fmtPct(stats.data.totals.open_rate)} open rate` },
                { label: 'Unsubscribed', value: stats.data.totals.unsubscribed, sub: `${fmtPct(stats.data.totals.unsub_rate)} of enrolled` },
                { label: 'Completed', value: stats.data.totals.completed },
              ].map((t) => (
                <div key={t.label} className="border border-gray-200 rounded p-3 text-center shadow-card">
                  <div className="text-2xl font-semibold tracking-tight text-gray-900">{t.value}</div>
                  <div className="text-xs font-medium text-gray-500">{t.label}</div>
                  {t.sub && <div className="text-[11px] text-gray-400 mt-0.5">{t.sub}</div>}
                </div>
              ))}
            </div>

            {/* Per-step funnel */}
            {stats.data.totals.sent === 0 ? (
              <div className="text-center py-8 border border-dashed border-gray-200 rounded">
                <p className="text-sm font-medium text-gray-700 mb-1">No emails sent yet.</p>
                <p className="text-xs text-gray-500">
                  Step-by-step stats appear here once the first step goes out
                  {stats.data.totals.enrolled > 0
                    ? ` — ${stats.data.totals.active} enrollment${stats.data.totals.active === 1 ? ' is' : 's are'} queued.`
                    : ' — enroll some contacts to get started.'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left border-b border-gray-200">
                    <tr className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                      <th className="py-2 pr-3">Step</th>
                      <th className="py-2 pr-3 w-2/5">Sent → Opened</th>
                      <th className="py-2 pr-3 text-right">Sent</th>
                      <th className="py-2 pr-3 text-right">Opened</th>
                      <th className="py-2 pr-3 text-right">Open rate</th>
                      <th className="py-2 text-right">Unsubs</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {stats.data.steps.map((st) => {
                      const maxSent = Math.max(1, ...stats.data.steps.map((x) => x.sent));
                      return (
                        <tr key={st.step_order}>
                          <td className="py-2 pr-3">
                            <div className="font-medium text-gray-900">Step {st.step_order + 1}</div>
                            <div className="text-xs text-gray-500 truncate max-w-[220px]" title={st.subject}>{st.subject}</div>
                          </td>
                          <td className="py-2 pr-3">
                            {/* sent bar with the opened share overlaid */}
                            <div className="h-3 bg-gray-100 rounded overflow-hidden" title={`${st.sent} sent, ${st.opened} opened`}>
                              <div className="h-full bg-brand-blue/30 rounded relative" style={{ width: `${(st.sent / maxSent) * 100}%` }}>
                                <div className="h-full bg-brand-blue rounded" style={{ width: st.sent ? `${(st.opened / st.sent) * 100}%` : 0 }} />
                              </div>
                            </div>
                          </td>
                          <td className="py-2 pr-3 text-right text-gray-700">{st.sent}</td>
                          <td className="py-2 pr-3 text-right text-gray-700">{st.opened}</td>
                          <td className="py-2 pr-3 text-right text-gray-700">{st.sent ? fmtPct(st.open_rate) : '—'}</td>
                          <td className="py-2 text-right text-gray-700">{st.unsubscribed || 0}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-[11px] text-gray-400 mt-4">
              Opens are measured by tracking pixel (first open only) — clients that block images undercount.
              Unsubs count enrollments that opted out while waiting on that step. Click tracking isn't recorded.
            </p>
          </>
        ))}
      </Modal>

      {/* ---- Enroll modal ---- */}
      <Modal
        open={!!enrolling}
        onClose={() => setEnrolling(null)}
        title={enrolling ? `Enroll contacts — ${enrolling.sequence.name}` : ''}
        description="Contacts already in this sequence are skipped automatically. Step 1 sends after its configured delay."
        footer={enrolling && (
          <>
            <span className="text-xs text-gray-500 mr-auto">{enrolling.selected.size} selected</span>
            <Button variant="secondary" onClick={() => setEnrolling(null)}>Cancel</Button>
            <Button
              onClick={submitEnroll}
              disabled={enrolling.selected.size === 0}
              loading={enrolling.submitting}
              loadingLabel="Enrolling…"
            >
              Enroll selected
            </Button>
          </>
        )}
      >
        {enrolling && (
          <>
            <Input
              leadingIcon="search"
              value={enrolling.search}
              onChange={(e) => setEnrolling((s) => ({ ...s, search: e.target.value }))}
              wrapperClassName="mb-3"
              placeholder="Search contacts…"
              aria-label="Search contacts"
              autoFocus
            />
            <div className="max-h-[50vh] overflow-y-auto border border-gray-200 rounded divide-y divide-gray-100 min-h-[120px]">
              {enrolling.contacts === null ? (
                <div className="p-4"><Skeleton lines={4} /></div>
              ) : filteredContacts.length === 0 ? (
                <p className="text-sm text-gray-500 p-4 text-center">No contacts match.</p>
              ) : (
                filteredContacts.map((c) => (
                  <label key={c.id} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={enrolling.selected.has(c.id)}
                      onChange={() => toggleContact(c.id)}
                      className="h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue"
                    />
                    <span className="text-sm text-gray-900">{`${c.first_name || ''} ${c.last_name || ''}`.trim() || '(no name)'}</span>
                    <span className="text-xs text-gray-500 truncate">{c.email || 'no email'}</span>
                  </label>
                ))
              )}
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
