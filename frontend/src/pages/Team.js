// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import Nav from '../components/Nav';
import api from '../api';
import TierLimitToast from '../components/TierLimitToast';
import { Alert, Button, Card, Container, Input, Modal, PageHeader, Spinner, StatusBadge } from '../components/ui';

// onTierLimit (optional): called with the 402 TIER_LIMIT_EXCEEDED body when
// the invite hits an explicitly-capped plan's seat limit.
function InviteModal({ onClose, onSent, onTierLimit }) {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');

  const send = async e => {
    e.preventDefault();
    if (!email.trim()) { setErr('Email required'); return; }
    setSending(true);
    try {
      const res = await api.post('/org/invite', { email: email.trim() });
      setResult(res.data);
      onSent && onSent();
    } catch (e) {
      // Seat-cap 402 → surface the non-blocking upgrade nudge on the page;
      // the inline message still renders (it carries the upgrade text).
      if (e.response?.status === 402 && e.response?.data?.code === 'TIER_LIMIT_EXCEEDED' && onTierLimit) {
        onTierLimit(e.response.data);
      }
      setErr(e.response?.data?.error || 'Failed to send invite');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Invite team member"
      size="sm"
      footer={result ? (
        <Button onClick={onClose}>Done</Button>
      ) : (
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="invite-form" loading={sending} loadingLabel="Sending…" icon="mail">Send invite</Button>
        </>
      )}
    >
      {result ? (
        <div className="space-y-3">
          <Alert tone="success" title="Invite sent">
            Send this link to <strong>{email}</strong>:
          </Alert>
          <div className="bg-gray-50 border border-gray-200 rounded px-3 py-2 text-xs text-brand-blue break-all select-all font-mono">
            {result.inviteUrl}
          </div>
        </div>
      ) : (
        <form id="invite-form" onSubmit={send} className="space-y-4">
          <Input
            type="email"
            label="Email address"
            value={email}
            onChange={e => { setEmail(e.target.value); setErr(''); }}
            error={err || undefined}
            placeholder="teammate@company.com"
            autoFocus
          />
          <p className="text-xs text-gray-500">
            They'll receive a link to create their account and join your workspace. The invite expires in 7 days.
          </p>
        </form>
      )}
    </Modal>
  );
}

export default function Team() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [showInvite, setShowInvite] = useState(false);
  // Seat-cap 402 body from an invite on an explicitly-capped plan → upgrade nudge.
  const [tierLimit, setTierLimit] = useState(null);
  const [editingName, setEditingName] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [savingName, setSavingName] = useState(false);

  const load = async () => {
    try {
      const res = await api.get('/org');
      setData(res.data);
      setOrgName(res.data.org.name);
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to load team');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const removeInvite = async (id) => {
    if (!window.confirm('Cancel this invite?')) return;
    try {
      await api.delete(`/org/invites/${id}`);
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to cancel invite');
    }
  };

  const removeMember = async (id, name) => {
    if (!window.confirm(`Remove ${name} from the team?`)) return;
    try {
      await api.delete(`/org/members/${id}`);
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to remove member');
    }
  };

  const saveOrgName = async () => {
    if (!orgName.trim()) return;
    setSavingName(true);
    try {
      await api.put('/org', { name: orgName.trim() });
      setEditingName(false);
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to update name');
    } finally {
      setSavingName(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Nav active="team" />

      <Container size="narrow">
        <PageHeader
          title="Team & Workspace"
          subtitle="Manage your team members and workspace settings"
          primaryAction={{ label: 'Invite member', icon: 'user', onClick: () => setShowInvite(true) }}
        />

        {err && <Alert tone="danger" className="mb-6" onDismiss={() => setErr('')}>{err}</Alert>}

        {loading ? (
          <Spinner size="lg" label="Loading team…" />
        ) : data && (
          <div className="space-y-6">
            {/* Workspace Info */}
            <Card title="Workspace">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded bg-brand-blue flex items-center justify-center text-white font-bold text-lg flex-shrink-0">
                  {data.org.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  {editingName ? (
                    <div className="flex items-center gap-2">
                      <Input
                        size="sm"
                        aria-label="Workspace name"
                        value={orgName}
                        onChange={e => setOrgName(e.target.value)}
                        autoFocus
                        onKeyDown={e => e.key === 'Enter' && saveOrgName()}
                        wrapperClassName="flex-1"
                      />
                      <Button size="sm" onClick={saveOrgName} loading={savingName} loadingLabel="…">Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingName(false)}>Cancel</Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-900">{data.org.name}</span>
                      <button onClick={() => setEditingName(true)} className="text-xs text-brand-blue hover:underline">Rename</button>
                    </div>
                  )}
                  <p className="text-xs text-gray-400 mt-0.5">{data.members.length} member{data.members.length !== 1 ? 's' : ''} · {data.org.plan} plan</p>
                </div>
              </div>
            </Card>

            {/* Members */}
            <Card title={`Members (${data.members.length})`} padding="none">
              <div className="divide-y divide-gray-100">
                {data.members.map(member => (
                  <div key={member.id} className="px-5 py-3.5 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-info-100 text-brand-blue flex items-center justify-center font-semibold text-sm flex-shrink-0">
                        {(member.name || member.email).charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{member.name || member.email}</p>
                        <p className="text-xs text-gray-500">{member.email}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge tone={member.org_role === 'owner' ? 'info' : 'neutral'} label={member.org_role} className="capitalize" />
                      {member.org_role !== 'owner' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-danger-600 hover:bg-danger-50"
                          onClick={() => removeMember(member.id, member.name || member.email)}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            {/* Pending Invites */}
            {data.pendingInvites.length > 0 && (
              <Card title={`Pending invites (${data.pendingInvites.length})`} padding="none">
                <div className="divide-y divide-gray-100">
                  {data.pendingInvites.map(invite => (
                    <div key={invite.id} className="px-5 py-3.5 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{invite.email}</p>
                        <p className="text-xs text-gray-400">
                          Expires {new Date(invite.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <StatusBadge tone="warning" label="Pending" />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-danger-600 hover:bg-danger-50"
                          onClick={() => removeInvite(invite.id)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}
      </Container>

      {showInvite && (
        <InviteModal
          onClose={() => setShowInvite(false)}
          onSent={load}
          onTierLimit={setTierLimit}
        />
      )}

      <TierLimitToast
        info={tierLimit}
        onDismiss={() => setTierLimit(null)}
      />
    </div>
  );
}
