// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import api from '../api';
import Nav from '../components/Nav';
import { Alert, Button, Card, Container, PageHeader, Skeleton, StatusBadge } from '../components/ui';

// Quick "are we good to demo?" page. Hits /api/pitch-readiness and shows
// green/yellow/red status for every system check + integration. Auto-refresh
// every 30s so you can leave it open during a pitch.

const STATUS_STYLE = {
  green:  { dot: 'bg-success-500', tone: 'success', label: 'OK',       row: '' },
  yellow: { dot: 'bg-warning-500', tone: 'warning', label: 'Optional', row: '' },
  red:    { dot: 'bg-danger-500',  tone: 'error',   label: 'Broken',   row: 'bg-danger-50' },
};

const OVERALL = {
  red:    { tone: 'danger',  title: 'Not safe to pitch' },
  yellow: { tone: 'warning', title: 'Pitch-ready (optional integrations missing)' },
  green:  { tone: 'success', title: 'All systems green' },
};

export default function PitchReadiness() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loadedAt, setLoadedAt] = useState(null);

  const load = async () => {
    try {
      const r = await api.get('/pitch-readiness');
      setData(r.data);
      setLoadedAt(new Date());
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load');
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  const summary = data?.summary || { green: 0, yellow: 0, red: 0 };
  const overallStatus = summary.red > 0 ? 'red' : summary.yellow > 0 ? 'yellow' : 'green';
  const overall = OVERALL[overallStatus];

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="admin" />
      <Container>
        <PageHeader
          title="Pitch readiness"
          subtitle="Live system health. Refreshes every 30 seconds. Hit this 5 minutes before any demo."
          primaryAction={{ label: 'Refresh', icon: 'refresh', variant: 'secondary', onClick: load }}
        />

        <div className="space-y-6">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          {!data && !error && (
            <Card><Skeleton lines={6} /></Card>
          )}

          {data && (
            <>
              <Alert
                tone={overall.tone}
                title={overall.title}
                action={loadedAt && <span className="text-xs text-gray-500">Last checked {loadedAt.toLocaleTimeString()}</span>}
              >
                {summary.green} green · {summary.yellow} yellow · {summary.red} red
              </Alert>

              <Card padding="none">
                <ul className="divide-y divide-gray-100">
                  {(data.checks || []).map((c, i) => {
                    const s = STATUS_STYLE[c.status] || STATUS_STYLE.yellow;
                    return (
                      <li key={i} className={`px-5 py-3 flex items-center justify-between gap-3 ${s.row}`}>
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <span className={`inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${s.dot}`} aria-hidden="true" />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-gray-900 text-sm">{c.name}</p>
                            <p className="text-xs text-gray-600">{c.detail}</p>
                          </div>
                        </div>
                        <StatusBadge tone={s.tone} label={s.label} />
                      </li>
                    );
                  })}
                </ul>
              </Card>

              <div className="text-xs text-gray-500 space-y-1">
                <p><strong>Green</strong> = required system + integration working.</p>
                <p><strong>Yellow</strong> = optional integration (Email, AI, QuickBooks, GCS, webhooks) — features will fail gracefully when triggered, not crash. Set the env var to upgrade to green.</p>
                <p><strong>Red</strong> = something a pitch will visibly hit. Fix before demoing.</p>
              </div>
            </>
          )}
        </div>
      </Container>
    </div>
  );
}
