// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import Nav from '../components/Nav';
import { Alert, Button, Card, Container, EmptyState, PageHeader, Spinner, StatusBadge, Tabs } from '../components/ui';

// Find-duplicates + merge view. One page, two tabs (Contacts / Companies).
// Each tab loads GET /{contacts|companies}/duplicates → { groups: [...] } and
// renders each group as a card of member rows. Picking a "winner" per group
// then clicking Merge folds every OTHER member into it, one loser at a time,
// via POST /{resource}/:winnerId/merge { loserId }. A confirm dialog spells
// out exactly what the irreversible merge will do before any write happens.

const TABS = [
  { key: 'contacts', label: 'Contacts' },
  { key: 'companies', label: 'Companies' },
];

const REASON_LABEL = {
  email: 'Same email',
  name: 'Same name',
  domain: 'Same website domain',
};

function contactLabel(m) {
  const name = `${m.first_name || ''} ${m.last_name || ''}`.trim() || '(no name)';
  return { title: name, sub: m.email || m.status || '' };
}
function companyLabel(m) {
  return { title: m.name || '(no name)', sub: m.website || m.type || m.industry || '' };
}

export default function Duplicates() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = TABS.some(t => t.key === searchParams.get('type')) ? searchParams.get('type') : 'contacts';

  const [tab, setTab] = useState(initialTab);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Per-group chosen winner id: { [groupIndex]: winnerId }
  const [winners, setWinners] = useState({});
  const [merging, setMerging] = useState(false);

  const isContacts = tab === 'contacts';
  const labelFor = isContacts ? contactLabel : companyLabel;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const res = await api.get(`/${tab}/duplicates`);
      const g = res.data?.groups || [];
      setGroups(g);
      // Default each group's winner to its first (oldest) member.
      const w = {};
      g.forEach((grp, i) => { w[i] = grp.members[0]?.id ?? null; });
      setWinners(w);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load duplicates');
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  const switchTab = (key) => {
    setTab(key);
    setSearchParams({ type: key });
  };

  const setWinner = (groupIndex, id) => {
    setWinners(prev => ({ ...prev, [groupIndex]: id }));
  };

  const mergeGroup = async (grp, groupIndex) => {
    const winnerId = winners[groupIndex];
    if (!winnerId) return;
    const losers = grp.members.filter(m => m.id !== winnerId);
    if (losers.length === 0) return;

    const winnerRow = grp.members.find(m => m.id === winnerId);
    const winnerName = labelFor(winnerRow).title;
    const loserNames = losers.map(l => labelFor(l).title).join(', ');
    const noun = isContacts ? 'contact' : 'company';

    const ok = window.confirm(
      `Merge ${losers.length} duplicate ${noun}${losers.length > 1 ? 's' : ''} into "${winnerName}"?\n\n` +
      `These will be folded in and PERMANENTLY deleted:\n  ${loserNames}\n\n` +
      `Every deal, activity, task, quote, and other record that references ` +
      `${losers.length > 1 ? 'them' : 'it'} will be reassigned to "${winnerName}". ` +
      `Blank fields on "${winnerName}" will be backfilled from the duplicates. ` +
      `This cannot be undone.`
    );
    if (!ok) return;

    setMerging(true);
    setError('');
    setNotice('');
    try {
      // Merge losers one at a time into the winner.
      for (const loser of losers) {
        // eslint-disable-next-line no-await-in-loop
        await api.post(`/${tab}/${winnerId}/merge`, { loserId: loser.id });
      }
      setNotice(`Merged ${losers.length} ${noun}${losers.length > 1 ? 's' : ''} into "${winnerName}".`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Merge failed');
    } finally {
      setMerging(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active={tab} />

      <Container>
        <PageHeader
          title="Find duplicates"
          subtitle="Records that look like duplicates, grouped by a shared signal. Pick the record to keep, then merge the rest into it — every linked deal, activity, and task moves to the record you keep."
          secondaryActions={[{
            label: `Back to ${isContacts ? 'Contacts' : 'Companies'}`,
            icon: 'arrow-left',
            inline: true,
            onClick: () => navigate(`/${tab}`),
          }]}
        />

        <div className="space-y-6">
          <Tabs
            items={TABS.map(t => ({ id: t.key, label: t.label }))}
            value={tab}
            onChange={switchTab}
            aria-label="Record type"
          />

          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}
          {notice && <Alert tone="success" onDismiss={() => setNotice('')}>{notice}</Alert>}

          {loading ? (
            <Spinner size="lg" label="Scanning for duplicates…" />
          ) : groups.length === 0 ? (
            <Card>
              <EmptyState
                icon="sparkles"
                title="Your data’s clean"
                message={`Nothing in your ${isContacts ? 'contacts' : 'companies'} looks like a duplicate right now. Check back after your next import.`}
              />
            </Card>
          ) : (
            groups.map((grp, i) => (
              <Card
                key={`${grp.reason}-${grp.key}-${i}`}
                padding="none"
                title={REASON_LABEL[grp.reason] || grp.reason}
                subtitle={grp.key}
                actions={<StatusBadge tone="neutral" label={`${grp.members.length} records`} />}
              >
                <ul className="divide-y divide-gray-100">
                  {grp.members.map(m => {
                    const { title, sub } = labelFor(m);
                    const isWinner = winners[i] === m.id;
                    return (
                      <li key={m.id} className="px-5 py-3 flex items-center gap-3">
                        <input
                          type="radio"
                          name={`winner-${i}`}
                          checked={isWinner}
                          onChange={() => setWinner(i, m.id)}
                          aria-label={`Keep ${title}`}
                          className="h-4 w-4 text-brand-blue focus:ring-brand-blue"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-gray-900 truncate flex items-center gap-2">
                            <span className="truncate">{title}</span>
                            {isWinner && <StatusBadge tone="success" label="Keep" />}
                          </div>
                          <div className="text-xs text-gray-500 truncate">{sub}</div>
                        </div>
                        <span className="text-xs text-gray-400">#{m.id}</span>
                      </li>
                    );
                  })}
                </ul>

                <div className="px-5 py-3 border-t border-gray-100 bg-gray-50 rounded-b flex justify-end">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={merging || !winners[i]}
                    loading={merging}
                    onClick={() => mergeGroup(grp, i)}
                  >
                    Merge {grp.members.length - 1} into selected
                  </Button>
                </div>
              </Card>
            ))
          )}
        </div>
      </Container>
    </div>
  );
}
