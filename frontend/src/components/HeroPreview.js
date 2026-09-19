// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';
import BrandLogo from './BrandLogo';

// Inline hero preview for the landing page — a faithful, static mini-rendering
// of the product's first-run moment (spec 203): the owner describes how they
// sell, the builder proposes a pipeline, fields, a follow-up rule and a view,
// and every line is a checkbox. Replaces the earlier manufacturer's-rep Kanban
// mock (Wave 3 of the 2026-09-18 review): the old preview showed one vertical's
// board; this shows the mechanism that produces any vertical's board.
//
// Same brand tokens as the app so a rebrand carries through. No API calls, no
// animation — renders identically everywhere.

const DESCRIPTION =
  'We sell to other businesses. Leads come from the website and referrals. A rep qualifies on a first call, sends a proposal, and most deals go a round on price before we win or lose. If a deal sits two weeks with no activity, nudge the rep.';

const STAGES = [
  { label: 'New Lead', tone: 'bg-slate-100 text-slate-700 border-slate-200' },
  { label: 'Qualified', tone: 'bg-blue-100 text-blue-800 border-blue-200' },
  { label: 'Proposal Sent', tone: 'bg-cyan-100 text-cyan-800 border-cyan-200' },
  { label: 'Negotiation', tone: 'bg-amber-100 text-amber-800 border-amber-200' },
  { label: 'Won', tone: 'bg-green-100 text-green-800 border-green-200' },
  { label: 'Lost', tone: 'bg-red-100 text-red-800 border-red-200' },
];

const PROPOSALS = [
  { group: 'Fields', text: 'Add dropdown "Lead source" (Website, Referral, Outbound, Event) to deals' },
  { group: 'Fields', text: 'Add text field "Decision maker" to deals' },
  { group: 'Automations', text: 'When a deal is idle 14 days, create task "Check in — no activity for two weeks"' },
  { group: 'Saved views', text: 'Save a shared deals view "Proposals out" filtered by stage = Proposal Sent' },
];

function Check() {
  return (
    <span aria-hidden="true" className="mt-0.5 inline-flex w-3.5 h-3.5 rounded border border-brand-blue bg-brand-blue text-white items-center justify-center flex-shrink-0">
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
    </span>
  );
}

export default function HeroPreview() {
  return (
    <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden" data-testid="hero-preview">
      {/* Mini "browser" chrome */}
      <div className="bg-gray-100 border-b border-gray-200 px-4 py-2 flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
        <span className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
        <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
        <div className="flex-1 ml-3 mr-3 bg-white rounded-md border border-gray-200 px-2 py-0.5 text-xs text-gray-500">
          app.theopencrm.com/setup
        </div>
      </div>

      {/* Top nav strip */}
      <div className="px-4 py-2 border-b border-gray-100 flex items-center gap-3">
        <BrandLogo size={20} showWordmark={false} />
        <span className="text-xs font-bold tracking-tight">THE OPEN <span className="text-brand-blue">CRM</span></span>
        <div className="flex-1" />
        <span className="text-[10px] text-gray-400 hidden sm:inline">Chat</span>
        <span className="text-[10px] text-gray-400 hidden sm:inline">Deals</span>
        <span className="text-[10px] text-brand-blue font-semibold hidden sm:inline">Setup</span>
      </div>

      <div className="px-4 py-3 space-y-3 bg-gray-50">
        {/* What the owner typed */}
        <div className="bg-white rounded-lg border border-gray-200 p-3">
          <div className="text-[9px] uppercase tracking-wide text-gray-400 mb-1">How does your business sell?</div>
          <p className="text-[11px] leading-snug text-gray-800">{DESCRIPTION}</p>
        </div>

        {/* What came back */}
        <div className="bg-white rounded-lg border border-brand-blue/40 p-3">
          <div className="flex items-baseline justify-between gap-2 mb-2">
            <span className="text-[11px] font-semibold text-gray-900">Here's what I'd set up.</span>
            <span className="text-[9px] text-gray-400">Untick anything you don't want</span>
          </div>

          <div className="text-[9px] uppercase tracking-wide text-gray-400 mb-1">Pipeline</div>
          <div className="flex flex-wrap items-center gap-1 mb-2.5">
            {STAGES.map((s, i) => (
              <React.Fragment key={s.label}>
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${s.tone}`}>{s.label}</span>
                {i < STAGES.length - 1 && <span aria-hidden="true" className="text-gray-300 text-[10px]">→</span>}
              </React.Fragment>
            ))}
          </div>

          <ul className="space-y-1.5">
            {PROPOSALS.map((p, i) => (
              <li key={i} className="flex items-start gap-2">
                <Check />
                <span className="text-[10px] leading-snug text-gray-800">
                  <span className="text-gray-400">{p.group} · </span>{p.text}
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-3 flex items-center gap-2">
            <span className="inline-flex items-center min-h-[26px] px-3 rounded-full bg-brand-blue text-white text-[10px] font-semibold">Build my CRM (5)</span>
            <span className="text-[9px] text-gray-400">Nothing exists until you click.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
