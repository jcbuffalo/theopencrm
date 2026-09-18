// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import api from '../api';

// Slim app-wide strip shown whenever the current org is displaying seeded
// DEMO data. Two things must be unmistakable: (1) this is sample data, not
// your real business, and (2) you can clear it in one click. The clear wipes
// ONLY [demo]-tagged rows server-side, leaving a genuinely-empty workspace.
export default function DemoBanner() {
  const [hasDemo, setHasDemo] = useState(false);
  const [counts, setCounts] = useState(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let alive = true;
    // 403 (non-admin) / errors -> simply no banner.
    api.get('/admin/demo/status')
      .then((r) => { if (alive) { setHasDemo(!!r.data?.hasDemo); setCounts(r.data?.counts || null); } })
      .catch(() => { if (alive) setHasDemo(false); });
    return () => { alive = false; };
  }, []);

  if (!hasDemo) return null;

  const summary = counts
    ? `${counts.companies || 0} companies, ${counts.contacts || 0} contacts, ${counts.deals || 0} deals`
    : null;

  const clearDemo = async () => {
    if (clearing) return;
    if (!window.confirm('Clear all demo data and start with a clean, empty workspace? Your own records (if any) are kept.')) return;
    setClearing(true);
    try {
      await api.post('/admin/demo/wipe');
      // Reload so every board/list reflects the now-clean workspace.
      window.location.reload();
    } catch {
      setClearing(false);
    }
  };

  return (
    <div className="bg-violet-600 text-white text-xs sm:text-sm">
      <div className="max-w-7xl mx-auto px-4 py-1.5 flex items-center justify-between gap-3">
        <span className="min-w-0 truncate">
          <span className="font-semibold">Sample data is loaded</span>
          <span className="text-violet-100">{summary ? ` (${summary})` : ''}. Explore freely — clear it when you're ready to run your real business.</span>
        </span>
        <button
          type="button"
          onClick={clearDemo}
          disabled={clearing}
          className="flex-shrink-0 bg-white/15 hover:bg-white/25 disabled:opacity-60 rounded-md px-2.5 py-0.5 font-semibold whitespace-nowrap"
        >
          {clearing ? 'Clearing…' : 'Clear demo data'}
        </button>
      </div>
    </div>
  );
}
