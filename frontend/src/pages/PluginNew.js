// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Conversational plugin builder.
// User types in plain English → backend asks Claude → backend validates the
// generated spec against the SDK allowlist + trigger-event allowlist → backend
// inserts a draft plugin row → we navigate straight to /plugins/:id for the
// user to review + activate.
//
// Error surfaces (all rendered in the danger Alert below the textarea):
//   • AI not configured            → operator hint (set ANTHROPIC_API_KEY)
//   • AI quota exceeded (429)      → upgrade-tier hint
//   • Validation rejection (422)   → list every field the validator rejected
//   • Name collision (409)         → render a "use this custom name instead" input
//   • AI parse failed (502)        → "try rephrasing" prompt
//
// The "preview before deploy" 2-step UX from the scaffold has been retired:
// the backend now persists as `draft` directly and the detail page is where
// the operator does final review + activation. Drafts don't fire — they sit
// idle until the operator flips status to active on /plugins/:id.

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import Nav from '../components/Nav';
import { useAuth } from '../AuthContext';
import { Alert, Button, Card, Container, Input, PageHeader, Textarea } from '../components/ui';

const EXAMPLE_PROMPTS = [
  'When a deal moves to INVOICED, create a follow-up task to call the customer in 7 days.',
  'Daily at 9am, summarize stalled deals (no activity in 30+ days) and email the sales lead.',
  'When a new quote is sent, draft a follow-up email I can review before sending.',
  'Mark a deal hot when the amount is over $50,000 AND the stage is FOLLOW_UP.',
];

export default function PluginNew() {
  const navigate = useNavigate();
  const { aiEnabled } = useAuth();
  const [description, setDescription] = useState('');
  const [nameOverride, setNameOverride] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Structured fields the route can return alongside the error. When set, the
  // banner renders them in a more useful shape (a list of validator errors,
  // or a "use this name instead" input).
  const [validationErrors, setValidationErrors] = useState(null);
  const [nameConflict, setNameConflict] = useState(null);
  // AuthContext probes /api/ai/status on sign-in. When AI is unconfigured we
  // disable Generate up front so the user doesn't trip into a backend 503.
  const aiUnavailable = aiEnabled === false;

  const resetErrors = () => {
    setError('');
    setValidationErrors(null);
    setNameConflict(null);
  };

  const generate = async () => {
    setBusy(true);
    resetErrors();
    try {
      const body = { description };
      if (nameOverride.trim()) body.name = nameOverride.trim();
      const r = await api.post('/plugins/from-prompt', body);
      // 201 → navigate straight to the detail page so the operator can review
      // and activate.
      const pluginId = r.data?.plugin?.id;
      if (pluginId) {
        navigate(`/plugins/${pluginId}`);
      } else {
        // Shouldn't happen, but fall back to the list if the response shape
        // is unexpected.
        navigate('/plugins');
      }
    } catch (err) {
      const status = err.response?.status;
      const data = err.response?.data || {};
      if (data.code === 'AI_NOT_CONFIGURED') {
        setError('AI is not configured on this server. Contact your admin to set up the ANTHROPIC_API_KEY env var.');
      } else if (status === 429) {
        setError('Your org has hit its AI request quota for this month. Upgrade your plan or wait until next month.');
      } else if (status === 403 && data.code === 'FEATURE_DISABLED') {
        setError('Plugins are not enabled for your organization. Ask your admin to flip plugins_enabled at /admin/feature-flags.');
      } else if (status === 422 && data.code === 'SPEC_REJECTED') {
        setError('The generated plugin spec failed validation. See the details below.');
        setValidationErrors(Array.isArray(data.errors) ? data.errors : []);
      } else if (status === 409 && data.code === 'NAME_CONFLICT') {
        setError(data.error || 'A plugin with that name already exists.');
        setNameConflict({ generatedName: data.generatedName || '' });
        // Pre-fill the override input with a hint based on the conflicting name.
        if (data.generatedName) setNameOverride(`${data.generatedName}-v2`);
      } else if (status === 502 && data.code === 'AI_PARSE_FAILED') {
        setError('Claude returned unparseable output. Try rephrasing your description in a different way.');
      } else {
        setError(data.error || err.message || 'Generation failed');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="plugins" />
      <Container size="narrow">
        <PageHeader
          breadcrumb={[{ label: 'Plugins', to: '/plugins' }, { label: 'Build a plugin' }]}
          title="Build a plugin"
          subtitle="Describe what you want to automate. Claude turns your description into a working plugin spec that is saved as a draft. You review and activate it on the plugin detail page — drafts never fire on their own."
          secondaryActions={[
            { label: 'Browse library', icon: 'search', inline: true, onClick: () => navigate('/plugins/library') },
          ]}
        />

        <div className="space-y-6">
          {aiUnavailable && (
            <Alert tone="warning" icon="lock" title="AI features aren't activated on this deployment yet.">
              Plugin generation needs Claude. Contact your operator to set{' '}
              <code className="bg-warning-100 px-1 py-0.5 rounded font-mono">ANTHROPIC_API_KEY</code> on the backend.
              You can still install plugins from the library at <code>/plugins/library</code>.
            </Alert>
          )}

          <Card>
            <div className="space-y-4">
              <Textarea
                label="What should this plugin do?"
                value={description}
                onChange={e => setDescription(e.target.value)}
                rows={4}
                maxLength={2000}
                placeholder="e.g. When a deal hits the ORDACK stage, email purchasing@example.com with the deal details and create a task to follow up in 3 days."
                hint={`${description.length} / 2000`}
              />

              {(nameConflict || nameOverride) && (
                <Input
                  label={<>Plugin name {nameConflict && <span className="text-danger-600 text-xs font-normal">(required — original name was taken)</span>}</>}
                  value={nameOverride}
                  onChange={e => setNameOverride(e.target.value)}
                  maxLength={120}
                  placeholder="kebab-case-name"
                  className="font-mono"
                  hint="Optional. Override the AI-chosen name. Must be unique within your org."
                />
              )}

              <div className="flex gap-2 items-center flex-wrap">
                <Button
                  icon="sparkles"
                  onClick={generate}
                  disabled={busy || aiUnavailable || description.trim().length < 10}
                  loading={busy}
                  loadingLabel="Generating…"
                >
                  {aiUnavailable ? 'AI not configured' : 'Generate plugin'}
                </Button>
                <Button variant="secondary" onClick={() => navigate('/plugins')}>Cancel</Button>
                {!nameConflict && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setNameOverride(nameOverride ? '' : ' ')}
                  >
                    {nameOverride ? 'Hide name override' : 'Set a custom name'}
                  </Button>
                )}
              </div>
            </div>
          </Card>

          {error && (
            <Alert tone="danger" onDismiss={resetErrors}>
              <div className="whitespace-pre-wrap">{error}</div>
              {validationErrors && validationErrors.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-xs space-y-0.5">
                  {validationErrors.map((ve, i) => (
                    <li key={i}>
                      <span className="font-mono">{ve.field}</span>: {ve.message}
                    </li>
                  ))}
                </ul>
              )}
              {nameConflict && (
                <div className="mt-2 text-xs">
                  Edit the name input above and click Generate plugin again. We will reuse your
                  description and just retry the insert with the new name.
                </div>
              )}
            </Alert>
          )}

          <Card title="Examples to spark ideas">
            <ul className="space-y-2">
              {EXAMPLE_PROMPTS.map((p, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => setDescription(p)}
                    className="text-left text-sm text-brand-blue hover:underline"
                  >
                    {p}
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <p className="text-xs text-gray-500">
            Want to install from a curated template instead? Visit{' '}
            <button
              onClick={() => navigate('/plugins/library')}
              className="text-brand-blue hover:underline"
              type="button"
            >
              the plugin library
            </button>
            .
          </p>
        </div>
      </Container>
    </div>
  );
}
