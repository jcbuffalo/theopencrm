// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// PUBLIC PAGE — one component for every comparison landing page
// (/hubspot-alternative, /salesforce-alternative, ...). Data-driven from
// marketing/comparisons.js; the route passes `slug`. SEO meta per route is in
// server.js PUBLIC_META. Spec 203, Phase 3.
//
// Structure (same on every page, so a visitor arriving from any search lands
// on the same promise the product keeps at /setup):
//   1. pain-specific headline
//   2. three pains
//   3. honest side-by-side table (incl. where they win)
//   4. "Tell it how you sell" static demo
//   5. cost calculator
//   6. CTA pair + import note
//   7. other comparisons / verticals (internal links)

import React from 'react';
import { Link, Navigate } from 'react-router-dom';
import { getComparison, COMPARISONS, SHARED_DEMO } from '../marketing/comparisons';
import { VERTICALS } from '../marketing/verticals';
import { PRICES_VERIFIED } from '../marketing/competitorPrices';
import CrmCostCalculator from '../components/CrmCostCalculator';
import { MarketingNav, MarketingFooter, CtaPair, TellItDemo, Section } from '../components/MarketingShell';

export default function Compare({ slug }) {
  const c = getComparison(slug);
  if (!c) return <Navigate to="/" replace />;

  return (
    <div className="min-h-screen bg-white">
      <MarketingNav />

      {/* Hero */}
      <Section className="py-12 sm:py-20">
        <p className="text-sm font-semibold text-brand-blue uppercase tracking-wider mb-3">{c.eyebrow}</p>
        <h1 className="text-3xl sm:text-5xl font-bold text-gray-900 leading-tight mb-5 max-w-4xl">{c.headline}</h1>
        <p className="text-lg sm:text-xl text-gray-700 leading-relaxed max-w-3xl mb-8">{c.sub}</p>
        <CtaPair />
      </Section>

      {/* Pains */}
      <Section className="bg-gray-50 border-y border-gray-200 py-12 sm:py-16">
        <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-8">What people leaving {c.competitor.name} tell us</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {c.pains.map((p) => (
            <div key={p.title} className="bg-white rounded-xl border border-gray-200 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">{p.title}</h3>
              <p className="text-gray-700 text-sm leading-relaxed">{p.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Table */}
      <Section className="py-12 sm:py-16">
        <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-2">Side by side</h2>
        <p className="text-gray-600 mb-6">Including the rows where {c.competitor.name} wins. You would find out anyway.</p>
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-[640px] w-full text-sm border-collapse">
            <thead>
              <tr className="text-left">
                <th scope="col" className="py-3 px-4 font-semibold text-gray-600 border-b border-gray-200 w-1/4"><span className="sr-only">Feature</span></th>
                <th className="py-3 px-4 font-semibold text-gray-900 border-b border-gray-200">{c.competitor.name}</th>
                <th className="py-3 px-4 font-semibold text-brand-blue border-b border-gray-200">The Open CRM</th>
              </tr>
            </thead>
            <tbody>
              {c.table.map((row) => (
                <tr key={row.feature} className="align-top odd:bg-gray-50/60">
                  <th scope="row" className="py-3 px-4 font-medium text-gray-900 text-left border-b border-gray-100">{row.feature}</th>
                  <td className="py-3 px-4 text-gray-700 border-b border-gray-100">{row.them}</td>
                  <td className="py-3 px-4 text-gray-800 border-b border-gray-100">{row.us}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-500 mt-3">
          Competitor prices are published list prices per seat per month on annual billing, verified {PRICES_VERIFIED}. Feature notes reflect public plan pages on the same date.
        </p>
        <div className="mt-6 bg-amber-50 border border-amber-200 rounded-xl p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-amber-800 mb-1">Where this is not for you</div>
          <p className="text-sm text-amber-900 leading-relaxed">{c.honest}</p>
        </div>
      </Section>

      {/* Demo */}
      <Section className="bg-gradient-to-br from-gray-50 to-blue-50 border-y border-gray-200 py-12 sm:py-16">
        <p className="text-sm font-semibold text-brand-blue uppercase tracking-wider mb-2">How setup works here</p>
        <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-3">Tell it how you sell.</h2>
        <p className="text-gray-700 max-w-3xl mb-8 leading-relaxed">
          The first screen after signup is one text box. Describe your process the way you would to a new hire. The builder proposes a pipeline, the fields you mentioned, a follow-up rule and a saved view, each with a checkbox. Nothing is created until you approve it. You can also start from one of twelve templates and edit the wording.
        </p>
        <TellItDemo demo={SHARED_DEMO} />
      </Section>

      {/* Calculator */}
      <Section className="py-12 sm:py-16" id="calculator">
        <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-2">What it costs you now, with your numbers</h2>
        <p className="text-gray-600 mb-6 max-w-3xl">Seats times list price is the small part. Put in what you pay for implementation and for someone's time to keep the tool running, and compare.</p>
        <CrmCostCalculator defaultCompetitor={c.competitor.key} />
      </Section>

      {/* CTA + import */}
      <Section className="bg-gray-900 text-white py-14 sm:py-20">
        <h2 className="text-2xl sm:text-4xl font-bold mb-4">Describe your business. Get a CRM that fits it.</h2>
        <p className="text-gray-300 max-w-2xl mb-8 leading-relaxed">
          Free to start with no card. Hosted from $15 a seat when your team grows, or run the open-source code yourself for nothing.
        </p>
        <div className="[&_p]:text-gray-400">
          <CtaPair />
        </div>
        {c.importFrom ? (
          <p className="text-sm text-gray-400 mt-8 max-w-2xl">
            Bringing data over: the Import Wizard has a {c.importFrom} preset. Export your records as CSV, upload them, and the standard columns map themselves; stage names translate onto your new pipeline with a warning where they do not match, never an error. Notes, activities and attachments do not come across yet.
          </p>
        ) : (
          <p className="text-sm text-gray-400 mt-8 max-w-2xl">
            Bringing data over: the Import Wizard takes any CSV and maps columns to fields, and it has presets for HubSpot and Salesforce exports. Notes, activities and attachments do not come across yet.
          </p>
        )}
      </Section>

      {/* Cross-links */}
      <Section className="py-12">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-3">Other comparisons</h2>
            <ul className="space-y-2 text-sm">
              {COMPARISONS.filter((o) => o.slug !== c.slug).map((o) => (
                <li key={o.slug}><Link to={o.path} className="text-brand-blue hover:underline">{o.title}</Link></li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-3">Built for how you sell</h2>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
              {VERTICALS.map((v) => (
                <li key={v.id}><Link to={`/crm-for/${v.slug}`} className="text-brand-blue hover:underline">{v.name}</Link></li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <MarketingFooter />
    </div>
  );
}
