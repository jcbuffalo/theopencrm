// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';
import { Link } from 'react-router-dom';
import BrandLogo from '../components/BrandLogo';
import { TOTAL_STAGE_COUNT } from '../zangStages';

// Zang-specific pitch deck. Maps everything against the SOW's Phases I–VI and
// gives Zang a clear "buy / extend / build" path.

const phases = [
  {
    name: 'Phase I — Design', delivered: '~70%',
    done: ['Database schema (15+ tables) covering customers, vendors, deals, quotes, submittals, change orders, issues, contracts',
           'Interface design (Kanban, drawer detail, reports, admin)',
           'Multi-tenant org structure with admin-approved access'],
    todo: ['Final wireframe sign-off with your team',
           'Stakeholder walkthrough sessions'],
  },
  {
    name: 'Phase II — Foundation', delivered: '~85%',
    done: ['Auth (email + Google OAuth), 2FA scaffold, audit log, RBAC',
           'Common UI: nav, search, modals, drawer detail, tables',
           'Document storage (GCS-backed), email send (Gmail/SendGrid)',
           'Triggered automation engine running on a 60-min cycle'],
    todo: ['Custom UI polish per Zang brand colors / fonts',
           'Microsoft SSO if requested'],
  },
  {
    name: 'Phase III — Pre-Sale', delivered: '~75%',
    done: ['RFQ intake + vendor RFQ distribution',
           'Multi-vendor quote comparison with select-winner',
           'Branded customer quote PDF with revision history',
           'Vendor RFQ email send via Gmail / SendGrid',
           'Auto-flag stale vendor quotes (>30 days)',
           'HOT-deal flag with stale-deal alert (>7 days no activity)'],
    todo: ['Eaton / APC vendor-specific design-build templates',
           'Pricing strategy automation per vendor catalog',
           'Vendor catalog import for auto-populated line items'],
  },
  {
    name: 'Phase IV — Post-Sale', delivered: '~80%',
    done: ['Order fields on deal: PO #, ship-to, POC, target ship date',
           'Submittal cycle with version chain + approval',
           'Change orders with +/- amount + approval',
           'Release/Hold toggle with hold reason',
           'Delivery checklist (editable, per-deal)',
           'BOL / packing list / closeout document storage by type',
           'Branded purchase order PDF generation'],
    todo: ['Per-vendor PO format templates (one branded template ships; others by mapping)',
           'EDI / vendor-portal integrations',
           'Carrier API integrations (UPS, FedEx, freight)'],
  },
  {
    name: 'Phase V — Post-Shipment', delivered: '~65%',
    done: ['QuickBooks Online OAuth + invoice creation (auto on INVOICED stage)',
           'Service contracts entity with renewal-notice automation',
           'Customer survey queue + send-on-shipment trigger',
           'End-user company / contact tracking',
           'Buy-back workflow status tracking'],
    todo: ['Real QuickBooks credentials + accounting category mapping (operator-side)',
           'Custom survey templates per service line',
           'Customer appreciation queue UI (criteria + manual override)'],
  },
  {
    name: 'Phase VI — Adoption', delivered: '~50%',
    done: ['CSV import wizard with HubSpot / Salesforce / Pipedrive auto-detect',
           'Per-org white-label profile (Zang vs generic)',
           'Demo seeder for training data'],
    todo: ['Migration from Zang spreadsheets — column-mapping pass with your team',
           'Training sessions and runbooks',
           'Refinement phase — iterate based on team feedback'],
  },
];

const optionMatrix = [
  ['Deploy The Open CRM as-is for Zang',
   'Fastest. White-label profile already exists. Branding, stages, vendor/quote workflow, reports — all live today.',
   '~2 weeks for migration + training',
   'License + setup'],
  ['Buy + targeted extension',
   'Take what\'s built, add the 4-6 Zang-specific features that aren\'t in the platform yet (Eaton design-build, custom PO templates, surveys, etc.).',
   '~6-10 weeks for the extension layer',
   'License + custom dev'],
  ['Custom build per the original SOW',
   'Use the existing codebase as a foundation; rewrite/extend exclusively for Zang under the signed SOW.',
   '~8-12 months per the contract roadmap',
   'Fixed-bid per the signed SOW + ongoing support'],
];

export default function PitchZang() {
  return (
    <div className="min-h-screen bg-white">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-6 py-4 flex justify-between items-center">
          <BrandLogo size={28} />
          <Link to="/" className="text-sm text-brand-blue hover:underline">Back to app</Link>
        </div>
      </header>

      <main id="main-content" className="max-w-5xl mx-auto px-6 py-12">
        <div className="text-center mb-12">
          <p className="text-sm font-semibold text-brand-mint-dark uppercase tracking-wide">Custom proposal — HC Zang Agency</p>
          <h1 className="text-4xl font-bold text-gray-900 mt-2 mb-3">ZANG Flow on The Open CRM</h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            A working manufacturer's-rep workflow already in production, customized to your {TOTAL_STAGE_COUNT}-stage order lifecycle.
            Three paths to deployment — buy, extend, or fully custom.
          </p>
        </div>

        <section className="mb-12">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">What's already built — mapped to your SOW</h2>
          <div className="space-y-4">
            {phases.map(ph => (
              <div key={ph.name} className="bg-white border border-gray-200 rounded-lg p-5">
                <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                  <h3 className="font-semibold text-gray-900">{ph.name}</h3>
                  <span className="text-xs px-2 py-0.5 bg-brand-mint text-brand-blue-darker rounded-full font-semibold">{ph.delivered} delivered</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-xs font-semibold text-green-700 uppercase mb-1">✓ Done</p>
                    <ul className="space-y-1">
                      {ph.done.map((d, i) => <li key={i} className="text-gray-700">• {d}</li>)}
                    </ul>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-yellow-700 uppercase mb-1">○ Remaining</p>
                    <ul className="space-y-1">
                      {ph.todo.map((d, i) => <li key={i} className="text-gray-700">• {d}</li>)}
                    </ul>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Three options for moving forward</h2>
          <div className="space-y-3">
            {optionMatrix.map(([title, desc, time, cost], i) => (
              <div key={i} className="border border-gray-200 rounded-lg p-5 hover:border-brand-blue transition">
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <h3 className="font-semibold text-gray-900">{i + 1}. {title}</h3>
                  <span className="text-xs text-gray-500">{time} · {cost}</span>
                </div>
                <p className="text-sm text-gray-700 mt-2">{desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-12 bg-gray-50 rounded-lg p-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Why this beats a from-scratch build</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="font-semibold text-gray-900 mb-1">Risk</p>
              <p className="text-gray-700">A from-scratch build means month 6+ of design and foundation work before anyone uses anything. With this, your team is on the platform week 1 and feedback drives the customizations.</p>
            </div>
            <div>
              <p className="font-semibold text-gray-900 mb-1">Cost trajectory</p>
              <p className="text-gray-700">SOW phases I and II account for ~25% of the contract. Most of that is already done. Customizations on a working base run faster and cheaper than green-field development.</p>
            </div>
            <div>
              <p className="font-semibold text-gray-900 mb-1">Multi-tenant safety</p>
              <p className="text-gray-700">Every other client we onboard runs alongside Zang on the same platform but isolated by org — meaning bug fixes, security patches, and platform improvements roll out to Zang too.</p>
            </div>
            <div>
              <p className="font-semibold text-gray-900 mb-1">Optionality</p>
              <p className="text-gray-700">If the platform doesn't fit, the source code is yours under the per-deployment ownership transfer terms in §15 of the SOW. You keep the option to fork.</p>
            </div>
          </div>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">What's live to demo today</h2>
          <ul className="space-y-1 text-sm text-gray-700">
            <li>• Zang-specific {TOTAL_STAGE_COUNT}-stage Kanban with phase tabs (Pre-Sale / Post-Sale / Post-Shipment)</li>
            <li>• Multi-vendor RFQ comparison with email send + select-winner</li>
            <li>• Branded customer quote PDF (revision-aware)</li>
            <li>• Branded purchase order PDF</li>
            <li>• Submittals + change orders with version history</li>
            <li>• Release/hold + delivery checklist + BOL/closeout document storage</li>
            <li>• Service contracts with renewal automation</li>
            <li>• Customer survey queue (auto-fired on INVOICED)</li>
            <li>• QuickBooks Online OAuth (just needs your Intuit credentials)</li>
            <li>• Reports page covering every Exhibit A metric — windowed by 7 days / YTD / all-time</li>
            <li>• Team / vendor / salesman leaderboards</li>
            <li>• Audit log + 2FA + email verification</li>
            <li>• AI-assist (summarize deal / draft follow-up email) — operator-supplied API key</li>
            <li>• HubSpot / Salesforce / Pipedrive CSV import with auto-detection</li>
          </ul>
        </section>

        <section className="text-center">
          <p className="text-gray-700 mb-4">Ready to walk through it live?</p>
          <a href="mailto:johnbcoles@gmail.com?subject=ZANG%20Flow%20demo" className="inline-block px-6 py-3 bg-brand-blue hover:bg-brand-blue-dark text-white rounded-lg font-semibold">
            Schedule a 30-minute walkthrough
          </a>
        </section>

        <footer className="mt-16 text-xs text-gray-500 text-center">
          Prepared for HC Zang Agency Inc. · Software provided AS IS — see <Link to="/terms" className="underline">Terms</Link> and <Link to="/privacy" className="underline">Privacy</Link>.
        </footer>
      </main>
    </div>
  );
}
