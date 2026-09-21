// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// PUBLIC PAGE — /act/:token. The landing for the one-click buttons in the
// notification / digest emails (spec 204). The email link is a plain GET to
// this page; the page then POSTs /api/email-actions/:token/apply, so a mail
// client's link scanner never performs the action. No session needed: the
// single-use token IS the credential (services/emailActions.js).
//
// States: applying → done | already | expired | invalid | error. On done we
// show what happened and offer the two things people do next: open the
// record in the app, or open My Day.

import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import Button from '../components/ui/Button';

const LABELS = {
  'task.complete': 'Marking the task done',
  'task.snooze': 'Snoozing the task',
  'deal.next_step.complete': 'Clearing the next step',
  'deal.next_step.snooze': 'Moving the next step',
  'company.touch': 'Logging a touch',
  'notification.read': 'Dismissing',
};

function openPath(entityType, entityId) {
  if (entityType === 'task') return `/tasks?taskId=${entityId}`;
  if (entityType === 'deal') return `/deals?dealId=${entityId}`;
  if (entityType === 'company') return `/accounts/${entityId}`;
  if (entityType === 'notification') return '/notifications';
  return '/today';
}

export default function EmailAction() {
  const params = useParams();
  const token = useMemo(() => String(params.token || '').trim(), [params.token]);
  const valid = /^[0-9a-f]{64}$/.test(token);

  const [state, setState] = useState(valid ? 'applying' : 'invalid');
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!valid) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.post(`/email-actions/${token}/apply`);
        if (cancelled) return;
        setResult(r.data || {});
        setMessage(r.data?.message || 'Done.');
        setState('done');
      } catch (err) {
        if (cancelled) return;
        const status = err.response?.status;
        const body = err.response?.data || {};
        setResult(body);
        setMessage(body.message || '');
        if (status === 410) setState(body.used ? 'already' : 'expired');
        else if (status === 404 || status === 400 || status === 403) setState('invalid');
        else setState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [token, valid]);

  const title = {
    applying: 'One moment',
    done: 'Done',
    already: 'Already done',
    expired: 'This link has expired',
    invalid: 'This link will not work',
    error: 'Something went wrong',
  }[state];

  const open = result && result.entity_type ? openPath(result.entity_type, result.entity_id) : '/today';

  return (
    <main id="main-content" className="min-h-screen bg-gradient-to-br from-primary-50 to-primary-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="text-4xl font-bold text-brand-blue mb-4">The Open CRM</div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">{title}</h1>
        </div>

        <div className="bg-white rounded-xl shadow-lg p-8">
          {state === 'applying' && (
            <p className="text-sm text-gray-600 text-center" role="status">{LABELS[result?.action] || 'Applying your click'}…</p>
          )}

          {state === 'done' && (
            <div>
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6" role="status">
                <p className="text-sm text-green-800">{message}</p>
              </div>
              <div className="flex flex-col gap-3">
                <Link to={open} className="block">
                  <Button variant="primary" size="lg" fullWidth>Open in the app</Button>
                </Link>
                <Link to="/today" className="block">
                  <Button variant="secondary" size="lg" fullWidth>Go to My Day</Button>
                </Link>
              </div>
              <p className="text-xs text-gray-500 mt-4 text-center">Changed your mind? Open the record and undo it there.</p>
            </div>
          )}

          {state === 'already' && (
            <div>
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6" role="status">
                <p className="text-sm text-blue-800">This button was already used, so nothing changed. Each link in an email works once.</p>
              </div>
              <Link to="/today" className="block"><Button variant="primary" size="lg" fullWidth>Go to My Day</Button></Link>
            </div>
          )}

          {(state === 'expired' || state === 'invalid' || state === 'error') && (
            <div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6" role="status">
                <p className="text-sm text-amber-800">
                  {state === 'error'
                    ? (message || 'Something went wrong on our side. Try the link again in a minute, or do it in the app.')
                    : state === 'expired'
                      ? 'Email links work for 7 days. This one is past that, so nothing changed. Do it from My Day instead.'
                      : (message || 'This link is missing or not valid. Nothing changed.')}
                </p>
              </div>
              <Link to="/today" className="block"><Button variant="primary" size="lg" fullWidth>Go to My Day</Button></Link>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
