// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Admin → AI Model page. Org owners and admins pick which Claude model and
// reasoning effort the in-app AI surfaces (chat copilot, Drive intel, Gmail
// intel) call. Changes propagate within ~30 seconds (the per-org cache TTL
// in services/aiModel.js).
//
// Backed by GET/PATCH /api/admin/ai-model in routes/adminAiModelRoutes.js.

import React, { useEffect, useState } from 'react';
import api from '../api';
import Nav from '../components/Nav';
import { useAuth } from '../AuthContext';
import { Alert, Button, Card, Container, PageHeader, Select, Skeleton } from '../components/ui';

export default function AdminAiModel() {
  const { user, isAdmin } = useAuth();
  const isOrgAdmin = isAdmin || user?.org_role === 'owner' || user?.org_role === 'admin';

  const [settings, setSettings] = useState(null);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.get('/admin/ai-model');
      setSettings(r.data);
      setModel(r.data.model);
      setEffort(r.data.effort);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load AI model settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOrgAdmin) load();
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOrgAdmin]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const r = await api.patch('/admin/ai-model', { model, effort });
      setSettings(r.data);
      setModel(r.data.model);
      setEffort(r.data.effort);
      setSavedAt(new Date());
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const resetToDefault = async () => {
    setSaving(true);
    setError('');
    try {
      // Send `null` for both columns — the resolver falls back to env / default
      // on the next read.
      const r = await api.patch('/admin/ai-model', { model: null, effort: null });
      setSettings(r.data);
      setModel(r.data.model);
      setEffort(r.data.effort);
      setSavedAt(new Date());
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Reset failed');
    } finally {
      setSaving(false);
    }
  };

  if (!isOrgAdmin) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Nav active="admin" />
        <Container size="narrow">
          <Alert tone="warning" icon="lock">
            Org owner or admin access required to manage AI model settings.
          </Alert>
        </Container>
      </div>
    );
  }

  const dirty = settings && (model !== settings.model || effort !== settings.effort);

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="admin" />
      <Container size="narrow">
        <PageHeader
          title="AI model"
          subtitle="Choose which Claude model and reasoning effort the AI features use for this organization. Applies to the chat copilot, Drive intel summaries, Gmail intel summaries, and the point AI features (deal summary, draft email). Changes take effect within ~30 seconds."
        />

        {loading ? (
          <Card><Skeleton lines={4} /></Card>
        ) : error && !settings ? (
          <Alert tone="danger">{error}</Alert>
        ) : settings ? (
          <div className="space-y-6">
            {settings.env_override && (
              <Alert tone="info">
                An <code className="font-mono">ANTHROPIC_MODEL</code> env var is set on the backend,
                but the per-org column wins when present. The env var only kicks in when this
                organization's column is null (i.e. you click <em>Reset to default</em>).
              </Alert>
            )}

            <Card
              title="Model"
              subtitle="Opus is most capable but slowest and most expensive. Haiku is fastest and cheapest. Sonnet is the recommended balance and is the platform default."
            >
              <Select aria-label="Model" value={model} onChange={e => setModel(e.target.value)}>
                {settings.valid_models.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.label} ({m.id}){m.id === settings.default_model ? ' — default' : ''}
                  </option>
                ))}
              </Select>
            </Card>

            <Card
              title="Reasoning effort"
              subtitle="Higher effort lets the model think longer before answering. Low is fastest and cheapest (no extended thinking). Medium adds a 2,048-token thinking budget. High adds 8,192. Effort applies to every Claude call from this org."
            >
              <Select aria-label="Reasoning effort" value={effort} onChange={e => setEffort(e.target.value)}>
                {settings.valid_efforts.map(ev => (
                  <option key={ev} value={ev}>
                    {ev}{ev === settings.default_effort ? ' — default' : ''}
                  </option>
                ))}
              </Select>
            </Card>

            <Card title="Current effective settings">
              <dl className="text-sm grid grid-cols-2 gap-y-1">
                <dt className="text-gray-500">Model</dt>
                <dd className="font-mono text-gray-900">{settings.model}</dd>
                <dt className="text-gray-500">Effort</dt>
                <dd className="font-mono text-gray-900">{settings.effort}</dd>
              </dl>
            </Card>

            {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

            <div className="flex items-center justify-between gap-3 sticky bottom-0 bg-gray-50 pt-3 pb-2 -mx-4 px-4 border-t border-gray-200">
              <div className="text-xs text-gray-500 flex items-center gap-3">
                {savedAt ? `Last saved ${savedAt.toLocaleTimeString()}` : 'Changes apply org-wide on save.'}
                <button
                  type="button"
                  onClick={resetToDefault}
                  disabled={saving}
                  className="text-brand-blue hover:underline disabled:opacity-50"
                >
                  Reset to default
                </button>
              </div>
              <Button onClick={save} disabled={saving || !dirty} loading={saving} loadingLabel="Saving…">
                Save changes
              </Button>
            </div>
          </div>
        ) : null}
      </Container>
    </div>
  );
}
