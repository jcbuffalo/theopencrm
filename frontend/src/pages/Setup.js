// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// /setup — the workspace builder on its own page. The Chat front door embeds
// the same component for a brand-new org; this route exists so marketing
// pages, the pipeline editor, and a teammate's "ask your admin" note can all
// deep-link to one place. Reachable any time — describing your process again
// later is a legitimate way to reshape the workspace, not a one-shot wizard.

import React, { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Nav from '../components/Nav';
import WorkspaceBuilder from '../components/WorkspaceBuilder';
import { Container } from '../components/ui';

// ?template=<static id>   → preselect a starting description (AI plan)
// ?template=wt:<id>       → saved workspace template (deterministic plan)
export function parseTemplateParam(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = /^wt:(\d+)$/.exec(raw.trim());
  if (m) return { kind: 'saved', id: Number(m[1]) };
  if (/^[a-z][a-z0-9_]{1,59}$/.test(raw.trim())) return { kind: 'static', id: raw.trim() };
  return null;
}

export default function Setup() {
  const [params] = useSearchParams();
  const initialTemplate = useMemo(() => parseTemplateParam(params.get('template')), [params]);
  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="settings" />
      <Container>
        <div className="max-w-3xl mx-auto py-2 sm:py-4">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Build your CRM around how you sell</h1>
          <p className="text-sm text-gray-500 mt-1 mb-4">
            Describe your process once. The pipeline, fields, follow-up rules, and list views come out the other side — each one shown to you before it exists.
            Prefer to do it by hand? The <Link to="/settings/pipeline" className="text-brand-blue hover:underline">pipeline editor</Link> and <Link to="/admin/customizations" className="text-brand-blue hover:underline">custom fields</Link> are always there; saved setups live under <Link to="/templates" className="text-brand-blue hover:underline">templates</Link>.
          </p>
          <WorkspaceBuilder key={initialTemplate ? `${initialTemplate.kind}:${initialTemplate.id}` : 'blank'} initialTemplate={initialTemplate} />
        </div>
      </Container>
    </div>
  );
}
