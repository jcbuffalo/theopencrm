// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// EmailTemplates — admin-style management page at /admin/email-templates.
//
// Org-shared library. Any org member with admin can list/create/edit/delete.
// Two merge fields are documented inline so the user doesn't have to leave
// the page to remember the syntax.

import React, { useEffect, useState } from 'react';
import api from '../api';
import Nav from '../components/Nav';
import DataTable from '../components/DataTable';
import { useAuth } from '../AuthContext';
import { Alert, Button, Card, Container, Input, Modal, PageHeader, Textarea } from '../components/ui';

export default function EmailTemplates() {
  const { user, isAdmin, orgRole, notificationEmail } = useAuth();
  // Templates are managed by org owners/admins (and platform super-admins) —
  // the same rule the backend applies.
  const canManage = isAdmin || orgRole === 'owner' || orgRole === 'admin';
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | <id>
  const [form, setForm] = useState({ name: '', subject: '', body: '' });
  const [saving, setSaving] = useState(false);
  // Preview modal: { id, name, subject, body_html, body_text } | null
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(null); // template id currently loading
  // Per-row send-test status keyed by template id — { sending? error? success? }
  const [testStatus, setTestStatus] = useState({});

  // "Send to myself" target. Prefer the user's notification_email (the
  // address they opted into for notifications) and fall back to login email.
  // The backend also resolves this server-side; we surface it here so users
  // know where the test will land before they click.
  const selfEmail = notificationEmail || user?.email || '';

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/emails/templates');
      setList(r.data || []);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openNew = () => {
    setEditing('new');
    setForm({ name: '', subject: '', body: '' });
  };

  const openEdit = (t) => {
    setEditing(t.id);
    setForm({ name: t.name, subject: t.subject, body: t.body });
  };

  const cancel = () => {
    if (saving) return;
    setEditing(null);
    setForm({ name: '', subject: '', body: '' });
  };

  const save = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    if (!form.name || !form.subject || !form.body) {
      setError('Name, subject, and body are required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (editing === 'new') {
        await api.post('/emails/templates', form);
      } else {
        await api.put(`/emails/templates/${editing}`, form);
      }
      setSaving(false);
      setEditing(null);
      setForm({ name: '', subject: '', body: '' });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save');
      setSaving(false);
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this template?')) return;
    try {
      await api.delete(`/emails/templates/${id}`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete');
    }
  };

  // Render the template against the current user as a "to myself" preview.
  // Does NOT send — just renders + opens a modal. Backend resolves merge
  // fields and returns { subject, body_html, body_text } from POST
  // /emails/templates/:id/preview.
  const openPreview = async (t) => {
    setError('');
    setPreviewing(t.id);
    try {
      const r = await api.post(`/emails/templates/${t.id}/preview`, {});
      setPreview({ id: t.id, name: t.name, ...r.data });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to render preview');
    } finally {
      setPreviewing(null);
    }
  };

  // Fire a real send to the current user's notification/login email so the
  // author can see the actual inbox rendering (footer, pixel, etc.). Uses
  // POST /emails/send — same path as a normal send, just targeting self.
  const sendTestToSelf = async (t) => {
    if (!selfEmail) {
      setTestStatus(s => ({ ...s, [t.id]: { error: 'No email on your user account to send a test to.' } }));
      return;
    }
    setTestStatus(s => ({ ...s, [t.id]: { sending: true } }));
    try {
      const r = await api.post('/emails/send', {
        to_email: selfEmail,
        subject: t.subject,
        body: t.body,
        template_id: t.id,
      });
      setTestStatus(s => ({
        ...s,
        [t.id]: { success: true, transport: r.data?.transport, to: selfEmail },
      }));
    } catch (err) {
      setTestStatus(s => ({
        ...s,
        [t.id]: { error: err.response?.data?.error || 'Failed to send test' },
      }));
    }
  };

  const columns = [
    { key: 'name', label: 'Name' },
    {
      key: 'subject',
      label: 'Subject',
      render: (t) => {
        const ts = testStatus[t.id] || {};
        return (
          <div className="min-w-0">
            <div className="truncate max-w-xs">{t.subject}</div>
            {ts.success && (
              <div className="text-[11px] text-success-700 mt-1">
                Test sent to {ts.to}{ts.transport === 'console' ? ' (transport not configured — console-only)' : ''}
              </div>
            )}
            {ts.error && <div className="text-[11px] text-danger-600 mt-1">{ts.error}</div>}
          </div>
        );
      },
    },
  ];

  const rowActions = [
    {
      label: 'Preview',
      onClick: openPreview,
      disabled: (t) => previewing === t.id,
      className: 'text-sm font-medium text-gray-700 hover:underline',
    },
    {
      label: 'Send test to myself',
      onClick: sendTestToSelf,
      disabled: (t) => !!(testStatus[t.id] || {}).sending || !selfEmail,
      className: 'text-sm font-medium text-gray-700 hover:underline',
    },
  ];

  const formId = 'email-template-form';

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="email-templates" />
      <Container>
        <PageHeader
          title="Email templates"
          subtitle={<>Org-shared message templates. Merge fields: <code>{'{{contact.name}}'}</code>, <code>{'{{deal.title}}'}</code>.</>}
          primaryAction={{ label: 'New template', onClick: openNew }}
        />

        <div className="space-y-6">
          {!canManage && (
            <Alert tone="warning">
              Note: templates are org-shared. Members can still pick them in the composer, but creating and editing them is for workspace owners and admins.
            </Alert>
          )}

          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          <DataTable
            columns={columns}
            data={list}
            loading={loading}
            rowActions={rowActions}
            onEdit={openEdit}
            onDelete={remove}
            emptyState={{
              icon: 'mail',
              title: 'No templates yet',
              message: 'Create a reusable message your team can pick from the composer.',
              action: <Button onClick={openNew} icon="plus">New template</Button>,
            }}
          />
        </div>

        <Modal
          open={!!editing}
          onClose={cancel}
          title={editing === 'new' ? 'New template' : 'Edit template'}
          size="lg"
          footer={
            <>
              <Button variant="secondary" onClick={cancel} disabled={saving}>Cancel</Button>
              <Button type="submit" form={formId} loading={saving} loadingLabel="Saving…">Save</Button>
            </>
          }
        >
          <form id={formId} onSubmit={save} className="space-y-4">
            <Input
              label="Name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={120}
              placeholder="e.g. Follow-up after demo"
            />
            <Input
              label="Subject"
              required
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
              placeholder={'e.g. Following up on {{deal.title}}'}
            />
            <Textarea
              label="Body"
              required
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              rows={12}
              className="font-mono"
              placeholder={'Hi {{contact.name}},\n\nThanks for taking the time…'}
              hint={<>Available merge fields: <code>{'{{contact.name}}'}</code>, <code>{'{{deal.title}}'}</code>.</>}
            />
          </form>
        </Modal>

        <Modal
          open={!!preview}
          onClose={() => setPreview(null)}
          title={preview ? `Preview: ${preview.name}` : ''}
          description={<>Rendered output only — no email was sent. {'{{contact.name}}'} / {'{{deal.title}}'} resolve to live values only when previewing from a contact/deal surface.</>}
          size="lg"
          footer={<Button variant="secondary" onClick={() => setPreview(null)}>Close</Button>}
        >
          {preview && (
            <div className="space-y-3">
              <div>
                <p className="block text-xs font-medium text-gray-700 mb-1">Subject</p>
                <div className="px-3 py-2 border border-gray-200 rounded bg-gray-50 text-sm">{preview.subject || <em className="text-gray-400">(empty)</em>}</div>
              </div>
              <div>
                <p className="block text-xs font-medium text-gray-700 mb-1">Rendered HTML</p>
                {/* Backend escapes user-supplied content before wrapping in <strong>/<em>/<code>/<br>;
                    see plainToHtml in routes/emailRoutes.js. Safe to dangerouslySetInnerHTML here. */}
                <div
                  className="px-3 py-2 border border-gray-200 rounded bg-white text-sm"
                  dangerouslySetInnerHTML={{ __html: preview.body_html || '' }}
                />
              </div>
              <details className="text-xs text-gray-600">
                <summary className="cursor-pointer">Plain text version</summary>
                <pre className="mt-2 px-3 py-2 border border-gray-200 rounded bg-gray-50 whitespace-pre-wrap font-mono text-[12px]">{preview.body_text}</pre>
              </details>
            </div>
          )}
        </Modal>
      </Container>
    </div>
  );
}
