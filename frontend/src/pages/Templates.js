// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// /templates — saved workspace templates (spec 203, Phase 2).
//
// A template is how a workspace is SET UP (pipeline, fields, follow-up rules,
// shared views), never its data. Three things happen here:
//   • browse the gallery (platform + public + your own) and "Use" one — that
//     hands off to /setup?template=wt:<id>, where the builder shows the plan
//     and applies it confirm-first, with no AI call;
//   • save the current workspace as a template (owner/admin), optionally
//     public so another business can start from it;
//   • manage your own (rename, share/unshare, delete).
// Super-admins get one extra button: regenerate the platform gallery from the
// 12 starting descriptions (that one DOES call the model, once per template).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import Nav from '../components/Nav';
import { useAuth } from '../AuthContext';
import { Alert, Button, Container, Icon, Input, Modal, PageHeader, Skeleton, StatusBadge, Textarea } from '../components/ui';

function TemplateCard({ t, mine, onUse, onToggleShare, onDelete, busy }) {
  return (
    <li className="bg-white border border-gray-200 rounded-xl shadow-sm p-4 flex flex-col gap-3" data-testid={`template-card-${t.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-900 truncate">{t.name}</h3>
          {t.tagline && <p className="text-xs text-gray-500 mt-0.5">{t.tagline}</p>}
        </div>
        {t.is_platform ? <StatusBadge tone="accent" label="Starter" size="sm" />
          : mine ? <StatusBadge tone={t.is_public ? 'success' : 'neutral'} label={t.is_public ? 'Shared' : 'Private'} size="sm" />
            : <StatusBadge tone="neutral" label="Community" size="sm" />}
      </div>
      {t.stages?.length > 0 && (
        <p className="text-xs text-gray-700 leading-relaxed break-words">
          <span className="text-gray-400">Stages · </span>{t.stages.join(' → ')}
        </p>
      )}
      <p className="text-[11px] text-gray-400">
        {t.field_labels?.length || 0} field{t.field_labels?.length === 1 ? '' : 's'} · {t.automation_count} automation{t.automation_count === 1 ? '' : 's'} · {t.view_count} view{t.view_count === 1 ? '' : 's'}
        {t.use_count > 0 && <> · used {t.use_count}×</>}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-2">
        <Button size="sm" icon="sparkles" onClick={() => onUse(t)} disabled={busy}>Use this template</Button>
        {mine && (
          <>
            <Button size="sm" variant="ghost" onClick={() => onToggleShare(t)} disabled={busy}>{t.is_public ? 'Make private' : 'Share publicly'}</Button>
            <Button size="sm" variant="ghost" onClick={() => onDelete(t)} disabled={busy} aria-label={`Delete ${t.name}`}>Delete</Button>
          </>
        )}
      </div>
    </li>
  );
}

export default function Templates() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { user, orgRole } = useAuth();
  const canManage = ['owner', 'admin'].includes(orgRole || user?.org_role);
  const isSuper = user?.is_super_admin || user?.role === 'super_admin';

  const [state, setState] = useState({ loading: true, templates: [], error: null });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [saveOpen, setSaveOpen] = useState(params.get('save') === '1');
  const [form, setForm] = useState({ name: '', tagline: '', description: '', is_public: false });
  const [saveError, setSaveError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/workspace-templates', { params: { scope: 'all' } });
      setState({ loading: false, templates: r.data?.templates || [], error: null });
    } catch (err) {
      setState({ loading: false, templates: [], error: err.response?.data?.error || 'Could not load templates.' });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const mineId = user?.org_id;
  const groups = useMemo(() => {
    const all = state.templates;
    return {
      mine: all.filter((t) => t.org_id === mineId),
      platform: all.filter((t) => t.is_platform),
      community: all.filter((t) => !t.is_platform && t.org_id !== mineId),
    };
  }, [state.templates, mineId]);

  const use = (t) => navigate(`/setup?template=wt:${t.id}`);

  const toggleShare = async (t) => {
    setBusy(true);
    try {
      await api.put(`/workspace-templates/${t.id}`, { is_public: !t.is_public });
      setNotice({ tone: 'success', text: t.is_public ? `"${t.name}" is private again.` : `"${t.name}" is now shared — any workspace can start from it.` });
      await load();
    } catch (err) {
      setNotice({ tone: 'danger', text: err.response?.data?.error || 'Could not update the template.' });
    } finally { setBusy(false); }
  };

  const doDelete = async () => {
    const t = confirmDelete;
    setConfirmDelete(null);
    setBusy(true);
    try {
      await api.delete(`/workspace-templates/${t.id}`);
      setNotice({ tone: 'success', text: `Deleted "${t.name}".` });
      await load();
    } catch (err) {
      setNotice({ tone: 'danger', text: err.response?.data?.error || 'Could not delete the template.' });
    } finally { setBusy(false); }
  };

  const save = async () => {
    setSaveError('');
    if (!form.name.trim()) { setSaveError('Give it a name.'); return; }
    setBusy(true);
    try {
      const r = await api.post('/workspace-templates', { ...form, source: 'snapshot' });
      setSaveOpen(false);
      setForm({ name: '', tagline: '', description: '', is_public: false });
      if (params.get('save')) { params.delete('save'); setParams(params, { replace: true }); }
      setNotice({ tone: 'success', text: `Saved "${r.data?.template?.name}" — your pipeline, fields, follow-up rules and shared views, as they are right now.` });
      await load();
    } catch (err) {
      const body = err.response?.data || {};
      setSaveError((Array.isArray(body.validation_errors) && body.validation_errors.join('; ')) || body.error || 'Could not save the template.');
    } finally { setBusy(false); }
  };

  const generatePlatform = async () => {
    setBusy(true);
    setNotice({ tone: 'info', text: 'Drafting the starter gallery — one planning call per template, about a minute…' });
    try {
      const r = await api.post('/workspace-templates/generate-platform', {});
      const g = r.data?.generated?.length || 0;
      const f = r.data?.failed?.length || 0;
      setNotice({ tone: f ? 'warning' : 'success', text: `Generated ${g} starter template${g === 1 ? '' : 's'}${f ? `; ${f} failed (${r.data.failed.map((x) => x.id).join(', ')})` : ''}.` });
      await load();
    } catch (err) {
      setNotice({ tone: 'danger', text: err.response?.data?.error || 'Generation failed.' });
    } finally { setBusy(false); }
  };

  const secondaryActions = [];
  if (canManage) secondaryActions.push({ label: 'Build from a description', icon: 'sparkles', onClick: () => navigate('/setup'), inline: true });
  if (isSuper) secondaryActions.push({ label: groups.platform.length ? 'Regenerate starter gallery' : 'Generate starter gallery', icon: 'refresh', onClick: generatePlatform, disabled: busy, inline: true });

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="settings" />
      <Container>
        <PageHeader
          title="Workspace templates"
          subtitle="How a workspace is set up — pipeline, fields, follow-up rules, shared views — saved so you can reuse it or start from someone else's. Never anyone's data."
          primaryAction={canManage ? { label: 'Save current workspace', icon: 'plus', onClick: () => setSaveOpen(true), disabled: busy } : undefined}
          secondaryActions={secondaryActions}
        />

        {notice && <Alert tone={notice.tone} className="mb-4" onDismiss={() => setNotice(null)}>{notice.text}</Alert>}
        {state.error && <Alert tone="danger" className="mb-4">{state.error}</Alert>}

        {state.loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"><Skeleton className="h-36" /><Skeleton className="h-36" /><Skeleton className="h-36" /></div>
        ) : (
          <div className="space-y-8">
            <section>
              <h2 className="text-sm font-semibold text-gray-900 mb-2">Yours</h2>
              {groups.mine.length === 0 ? (
                <div className="bg-white border border-dashed border-gray-300 rounded-xl p-5 text-sm text-gray-600">
                  Nothing saved yet. {canManage
                    ? <>Once your pipeline and fields feel right, <button type="button" className="text-brand-blue hover:underline" onClick={() => setSaveOpen(true)}>save them as a template</button> — for a second pipeline, a sister company, or to share.</>
                    : 'An owner or admin can save how this workspace is set up.'}
                </div>
              ) : (
                <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {groups.mine.map((t) => <TemplateCard key={t.id} t={t} mine onUse={use} onToggleShare={toggleShare} onDelete={setConfirmDelete} busy={busy} />)}
                </ul>
              )}
            </section>

            <section>
              <h2 className="text-sm font-semibold text-gray-900 mb-2">Starters</h2>
              {groups.platform.length === 0 ? (
                <div className="bg-white border border-dashed border-gray-300 rounded-xl p-5 text-sm text-gray-600">
                  The starter gallery hasn't been generated on this deployment yet. You can still <Link to="/setup" className="text-brand-blue hover:underline">describe your business</Link> and get the same result.
                  {isSuper && ' As a super-admin you can generate it from the button above.'}
                </div>
              ) : (
                <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {groups.platform.map((t) => <TemplateCard key={t.id} t={t} onUse={use} busy={busy} />)}
                </ul>
              )}
            </section>

            {groups.community.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold text-gray-900 mb-2">Shared by other workspaces</h2>
                <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {groups.community.map((t) => <TemplateCard key={t.id} t={t} onUse={use} busy={busy} />)}
                </ul>
              </section>
            )}
          </div>
        )}

        <Modal
          open={saveOpen}
          onClose={() => setSaveOpen(false)}
          title="Save the current workspace as a template"
          description="Captures your pipeline stages, custom fields, enabled follow-up rules, and shared deal views as they are right now. No records."
          footer={(
            <>
              <Button variant="secondary" onClick={() => setSaveOpen(false)} disabled={busy}>Cancel</Button>
              <Button onClick={save} loading={busy} icon="check" data-testid="save-template">Save template</Button>
            </>
          )}
        >
          <div className="space-y-3">
            {saveError && <Alert tone="danger">{saveError}</Alert>}
            <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Our RFQ process" maxLength={120} required data-testid="template-name" />
            <Input label="One-line tagline (optional)" value={form.tagline} onChange={(e) => setForm({ ...form, tagline: e.target.value })} placeholder="e.g. RFQ to PO for a two-person rep firm" maxLength={200} />
            <Textarea label="Who is this for? (optional)" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="A sentence or two about the kind of business this fits." maxLength={4000} />
            <label className="flex items-start gap-2 text-sm text-gray-700">
              <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue" checked={form.is_public} onChange={(e) => setForm({ ...form, is_public: e.target.checked })} data-testid="template-public" />
              <span>Share publicly — any Open CRM workspace can start from this. <span className="text-gray-500">Only the structure is shared, never your records.</span></span>
            </label>
          </div>
        </Modal>

        <Modal
          open={!!confirmDelete}
          onClose={() => setConfirmDelete(null)}
          title={confirmDelete ? `Delete "${confirmDelete.name}"?` : ''}
          description="Workspaces that already used it are unaffected. This only removes the template."
          size="sm"
          footer={(
            <>
              <Button variant="secondary" onClick={() => setConfirmDelete(null)}>Keep it</Button>
              <Button variant="danger" onClick={doDelete} icon="trash">Delete</Button>
            </>
          )}
        />
        <p className="mt-8 text-xs text-gray-400 inline-flex items-center gap-1.5"><Icon name="info" size={12} /> Using a template never writes anything by itself — you review the plan on the next screen and build it with one click.</p>
      </Container>
    </div>
  );
}
