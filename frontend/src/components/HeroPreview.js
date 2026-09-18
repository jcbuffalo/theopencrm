// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';
import BrandLogo from './BrandLogo';

// Inline hero preview — a faithful mini-rendering of the real product UI for
// the marketing landing page. Uses the same brand tokens as the real app so
// it stays in sync visually if we ever rebrand.
//
// Three blocks: a pipeline-funnel metric strip (top), a 3-column Kanban with
// real-looking deal cards (middle), and a vendor-leaderboard slice (bottom).
// All static — no API calls, no demo data needed. Designed to render the
// same on every browser without animation jitter.

const STAGES = [
  { label: 'Vendor Quoting',  count: 7, value: '$340K', color: 'bg-blue-100 border-blue-200', headerColor: 'bg-blue-100' },
  { label: 'Customer Quoting',count: 4, value: '$215K', color: 'bg-cyan-100 border-cyan-200', headerColor: 'bg-cyan-100' },
  { label: 'Follow Up',       count: 6, value: '$180K', color: 'bg-yellow-100 border-yellow-200', headerColor: 'bg-yellow-100' },
];

const DEAL_CARDS = {
  'Vendor Quoting': [
    { title: 'Westvale Power — UPS retrofit',  customer: 'Westvale Power & Light', amount: '$92K', hot: true },
    { title: 'Empire Data — Hall 2 expansion', customer: 'Empire Data Centers',    amount: '$148K' },
    { title: 'Northern Steel — switchgear',    customer: 'Northern Steel Mills',   amount: '$72K' },
  ],
  'Customer Quoting': [
    { title: 'Coastal Health — gen replace',  customer: 'Coastal Health System', amount: '$110K' },
    { title: 'Highland Co-op — main bus',      customer: 'Highland Co-op',         amount: '$58K' },
  ],
  'Follow Up': [
    { title: 'Riverside Logistics — PDU',      customer: 'Riverside Logistics',    amount: '$34K', hot: true },
    { title: 'Cornerstone — battery refresh',  customer: 'Cornerstone Industrial', amount: '$67K' },
  ],
};

export default function HeroPreview() {
  return (
    <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden">
      {/* Mini "browser" chrome */}
      <div className="bg-gray-100 border-b border-gray-200 px-4 py-2 flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
        <span className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
        <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
        <div className="flex-1 ml-3 mr-3 bg-white rounded-md border border-gray-200 px-2 py-0.5 text-xs text-gray-500">
          app.theopencrm.com/deals
        </div>
      </div>

      {/* Top nav strip */}
      <div className="px-4 py-2 border-b border-gray-100 flex items-center gap-3">
        <BrandLogo size={20} showWordmark={false} />
        <span className="text-xs font-bold tracking-tight">THE OPEN <span className="text-brand-blue">CRM</span></span>
        <span className="text-[9px] uppercase tracking-wider text-brand-mint-dark font-semibold border-l border-gray-300 pl-2 ml-1">
          Manufacturer's-Rep
        </span>
        <div className="flex-1" />
        <span className="text-[10px] text-gray-400 hidden sm:inline">Reports</span>
        <span className="text-[10px] text-gray-400 hidden sm:inline">Deals</span>
        <span className="text-[10px] text-gray-400 hidden sm:inline">Quotes</span>
      </div>

      {/* Metric strip */}
      <div className="grid grid-cols-4 gap-px bg-gray-200 border-b border-gray-200">
        {[
          // text-green-700 / text-brand-blue-darker — clear WCAG 1.4.3 AA
          // against the white tile background (4.5:1 floor for normal text).
          // text-green-600 measured ~3.2:1.
          ['Hit Rate', '67%', 'text-green-700'],
          ['Pipeline', '$735K', 'text-brand-blue-darker'],
          ['Won YTD', '$1.2M', 'text-green-700'],
          ['Hot 🔥', '4', 'text-red-700'],
        ].map(([label, value, color], i) => (
          <div key={i} className="bg-white px-3 py-2">
            <div className="text-[9px] uppercase text-gray-500 font-medium">{label}</div>
            <div className={`text-base font-bold ${color}`}>{value}</div>
          </div>
        ))}
      </div>

      {/* Mini Kanban */}
      <div className="px-3 py-3 bg-gray-50">
        <div className="grid grid-cols-3 gap-2">
          {STAGES.map(stage => (
            <div key={stage.label} className={`rounded-lg ${stage.color} border`}>
              <div className={`px-2 py-1.5 ${stage.headerColor} rounded-t-lg flex items-center justify-between`}>
                <span className="text-[10px] font-semibold text-gray-700">
                  {stage.label}
                  <span className="ml-1 text-gray-400 font-normal">{stage.count}</span>
                </span>
                <span className="text-[10px] text-gray-500 font-medium">{stage.value}</span>
              </div>
              <div className="p-1.5 space-y-1.5">
                {DEAL_CARDS[stage.label].map((deal, i) => (
                  <div key={i} className="bg-white rounded p-1.5 shadow-sm border border-gray-200">
                    <div className="flex items-start justify-between gap-1">
                      <p className="text-[10px] font-semibold text-gray-900 leading-tight truncate">{deal.title}</p>
                      {deal.hot && <span className="text-[8px] px-1 bg-red-100 text-red-700 rounded font-bold flex-shrink-0">HOT</span>}
                    </div>
                    <p className="text-[9px] text-gray-500 truncate">{deal.customer}</p>
                    <p className="text-[10px] font-bold text-green-700 mt-0.5">{deal.amount}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Vendor leaderboard slice */}
      <div className="border-t border-gray-200 bg-white px-4 py-3">
        <div className="text-[9px] uppercase font-semibold text-gray-500 mb-2">Top vendors (YTD)</div>
        <div className="space-y-1">
          {[
            ['Eaton Power Quality',       '14 RFQs', '8 won', '$420K'],
            ['APC by Schneider',          '11 RFQs', '6 won', '$310K'],
            ['Vertiv',                    '8 RFQs',  '3 won', '$185K'],
          ].map(([name, rfqs, won, value], i) => (
            <div key={i} className="flex items-center text-[10px] gap-2">
              <span className="flex-1 font-medium text-gray-900 truncate">{name}</span>
              <span className="text-gray-500 hidden sm:inline">{rfqs}</span>
              <span className="text-gray-700 hidden sm:inline">{won}</span>
              <span className="font-semibold text-brand-blue tabular-nums">{value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
