// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// PUBLIC PAGE — the open-source launch announcement. Linked from the Landing
// banner; per-route SEO meta lives in server.js PUBLIC_META['/launch'].

import React from 'react';
import { Link } from 'react-router-dom';

const REPO = 'https://github.com/jcbuffalo/theopencrm';

export default function LaunchPost() {
  return (
    <div className="min-h-screen bg-white">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <Link to="/" className="text-xl font-bold text-brand-blue">The Open CRM</Link>
          <div className="flex gap-4 text-sm items-center">
            <a href={REPO} target="_blank" rel="noreferrer" className="text-gray-600 hover:text-gray-900">GitHub</a>
            <Link to="/request-access" className="px-4 py-2 bg-brand-blue hover:bg-brand-blue-dark text-white rounded-lg text-sm font-semibold">Get started free</Link>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-14">
        <p className="text-sm font-semibold text-brand-blue uppercase tracking-wider mb-3">September 18, 2026</p>
        <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-6 leading-tight">
          The Open CRM is now actually open.
        </h1>

        <div className="prose prose-lg prose-gray max-w-none [&>p]:text-gray-700 [&>p]:leading-relaxed">
          <p>
            As of today, the full source code of The Open CRM is public on{' '}
            <a href={REPO} target="_blank" rel="noreferrer" className="text-brand-blue underline">GitHub</a>,
            licensed AGPL-3.0. The backend, the frontend, the test suites, the plugin
            SDK, the threat model — all of it. You can read it, audit it, self-host it
            for zero dollars, and modify it for your team.
          </p>

          <p>
            I'll be honest about the timing: the name was a promise before it was a
            fact. I built this product in the open-source spirit — AGPL headers in
            every file from day one — but the repository stayed private while I got
            the fundamentals right. Someone pointed a search engine at my homepage
            recently and it couldn't verify a word of my pitch. That stung, and it was
            fair. So here's the code.
          </p>

          <h2 className="text-2xl font-bold text-gray-900 mt-10 mb-3">What it is</h2>
          <p>
            A complete CRM for small businesses that a solo founder dogfoods daily:
            companies, contacts, and leads with public capture forms; deals on
            editable multi-pipeline boards with line-item P&amp;L; quotes and a product
            catalog; tasks, meetings, and stage-triggered playbook checklists; email
            sequences; dashboards, custom reports, forecasting, and commission plans;
            account health, renewals, NPS, support cases, and a customer portal;
            HubSpot and Salesforce import presets for switchers.
          </p>
          <p>
            The front door is a chat copilot with 53 tools. It reads anything and
            proposes any write — and every write is confirm-first: you see exactly
            what will change and click Apply, or you don't. The same discipline
            extends to the extension library: fifty-seven one-click extensions (stale-deal
            nudges, SLA timers, data-hygiene digests, AI pipeline briefs) that run on
            real event and schedule triggers, in a sandboxed VM with hard budgets, and
            only act autonomously if an admin explicitly opts a specific extension in.
          </p>

          <h2 className="text-2xl font-bold text-gray-900 mt-10 mb-3">The business model, in the open too</h2>
          <p>
            Open-source companies get cagey here, so let me not be. Self-hosting is
            free, forever — that's the license, not a promo. If you bring your own
            Anthropic API key, the AI features cost you nothing beyond what Anthropic
            charges you; there is no markup and no middleman. Money reaches me two
            ways: <strong>hosted</strong> (I run everything —
            free to start, $15/seat Starter, $39/seat Pro) and <strong>metered
            AI</strong> — hosted workspaces, or self-hosted instances that prefer a
            gateway key over managing an Anthropic account, pay for AI usage as they
            go, with a monthly spending cap that defaults to $200 and halts
            automatically. Usage revenue funds development. That's the whole model.
          </p>

          <h2 className="text-2xl font-bold text-gray-900 mt-10 mb-3">What "open" means here, precisely</h2>
          <p>
            The public repository is a curated mirror of my working repo, synced by
            squash commits — internal customer documents don't ship, everything needed
            to run, audit, and extend the product does. It's AGPL-3.0: run it,
            change it, host it for others — if you host a modified version, share your
            modifications with your users. Contributions are welcome with a DCO
            sign-off; the security policy and threat model are in the repo, and
            cross-tenant isolation findings will always be treated as critical.
          </p>

          <h2 className="text-2xl font-bold text-gray-900 mt-10 mb-3">Where it goes</h2>
          <p>
            I run my own businesses on this CRM — every feature ships because a real
            workflow demanded it, and the roadmap favors things a small business will
            actually use over demo-ware. If that's the kind of tool you want to exist,
            star the repo, file the issue, or just take the code and run it. That's
            what it's for.
          </p>

          <p className="mt-8">— John Coles</p>
        </div>

        <div className="mt-12 flex flex-col sm:flex-row gap-3">
          <a href={REPO} target="_blank" rel="noreferrer" className="px-6 py-3 bg-gray-900 hover:bg-gray-800 text-white rounded-lg font-semibold text-center">Read the code on GitHub</a>
          <Link to="/request-access" className="px-6 py-3 bg-brand-blue hover:bg-brand-blue-dark text-white rounded-lg font-semibold text-center">Try the hosted version free</Link>
        </div>

        <p className="mt-10 pt-6 border-t border-gray-200 text-sm text-gray-500">
          <Link to="/" className="underline">Home</Link> · <Link to="/pitch" className="underline">Product tour</Link> · <Link to="/terms" className="underline">Terms</Link> · <Link to="/privacy" className="underline">Privacy</Link>
        </p>
      </main>
    </div>
  );
}
