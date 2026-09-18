// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';
import { Link } from 'react-router-dom';
import BrandLogo from '../components/BrandLogo';

// Generic / SMB pitch deck. Less workflow-specific than the Zang version;
// emphasises platform features and white-label adaptability.

export default function PitchGeneric() {
  return (
    <div className="min-h-screen bg-white">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-6 py-4 flex justify-between items-center">
          <BrandLogo size={28} />
          <Link to="/" className="text-sm text-brand-blue hover:underline">Back to app</Link>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12">
        <div className="text-center mb-12">
          <p className="text-sm font-semibold text-brand-mint-dark uppercase tracking-wide">The Open CRM</p>
          <h1 className="text-4xl font-bold text-gray-900 mt-2 mb-3">A configurable CRM that gets out of your way.</h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Built for teams that want pipeline, contacts, and reporting without wrestling Salesforce or paying enterprise prices for HubSpot's pro tier.
          </p>
        </div>

        <section className="mb-12">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">What you get on day one</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              ['Drag-and-drop Kanban pipeline', 'Six configurable stages out of the box. Drag deals between columns; the system tracks transitions and time-in-stage automatically.'],
              ['Companies & contacts', 'Standard CRM records with custom fields, search, filters, CSV import.'],
              ['Activities & tasks', 'Log calls, emails, meetings, notes. Tasks with due dates, priorities, and overdue alerts.'],
              ['Reports', 'Hit rate, pipeline value, per-salesman leaderboard, vendor performance — windowed by 7 days, YTD, or all time.'],
              ['Team workspaces', 'Multi-tenant by org. Owners invite teammates; admin-approved access flow built in.'],
              ['Document storage', 'Each record has attachable files. Cloud-storage backed with signed-URL downloads.'],
              ['HubSpot / Salesforce import', 'Upload your existing export — column auto-detection means no manual mapping.'],
              ['Audit log + 2FA', 'Security-sensitive events logged with actor, IP, request ID. TOTP 2FA opt-in per user.'],
            ].map(([title, body]) => (
              <div key={title} className="bg-white border border-gray-200 rounded-lg p-4">
                <p className="font-semibold text-gray-900 mb-1">{title}</p>
                <p className="text-sm text-gray-700">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">What's optional but plug-in-ready</h2>
          <p className="text-sm text-gray-600 mb-3">Each of these is wired up in the codebase. Provide the credentials, flip the switch.</p>
          <div className="space-y-2 text-sm">
            {[
              ['QuickBooks Online', 'OAuth + auto-invoice on stage transition. Bring your Intuit Developer keys.'],
              ['Email send (Gmail / SendGrid)', 'Power vendor RFQ blasts and customer surveys. Set GMAIL_USER+APP_PASSWORD or SENDGRID_API_KEY.'],
              ['AI assist (Claude)', 'Summarize deals, draft follow-up emails. Bring your Anthropic API key.'],
              ['Microsoft Teams / Zoom / Otter / Fireflies', 'Webhook receivers ready. Configure your secrets and point your meeting tools at the URLs.'],
              ['Triggered automation', 'Stale-RFQ alerts, hot-deal stale-watch, expiring quotes, customer surveys, contract renewals — all running on a 60-min cycle.'],
            ].map(([title, body]) => (
              <div key={title} className="border border-gray-200 rounded-lg p-3">
                <p className="font-semibold text-gray-900">{title}</p>
                <p className="text-xs text-gray-700 mt-0.5">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-12 bg-gray-50 rounded-lg p-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">White-label per workflow</h2>
          <p className="text-sm text-gray-700 mb-3">
            Generic CRM by default. For specialized verticals (e.g. manufacturer's reps), an admin can flip your org's profile and unlock industry-specific stages, panels, and entities — vendor RFQs, submittals, change orders, service contracts.
          </p>
          <p className="text-sm text-gray-700">
            One platform, multiple workflow shapes. Today: <strong>generic</strong> and <strong>manufacturer's-rep</strong>. Adding more profiles is a config change, not a fork.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Honest about the surface</h2>
          <p className="text-sm text-gray-600 mb-3">No vapor in the deck. Things on the roadmap that aren't shipped yet:</p>
          <ul className="text-sm text-gray-700 space-y-1">
            <li>• Mobile app (web is mobile-responsive; native app is on the roadmap)</li>
            <li>• Marketplace plugins (Stripe, Mailchimp, Slack — direct integrations only for now)</li>
            <li>• Native HubSpot / Salesforce sync (CSV path is live; bidirectional sync is roadmap)</li>
            <li>• Workflow builder (custom automations are code-defined today; visual builder is roadmap)</li>
          </ul>
        </section>

        <section className="text-center">
          <p className="text-gray-700 mb-4">Try it. Bring an export of your current pipeline; we'll have you running in under an hour.</p>
          <Link to="/request-access" className="inline-block px-6 py-3 bg-brand-blue hover:bg-brand-blue-dark text-white rounded-lg font-semibold">
            Request access
          </Link>
        </section>

        <footer className="mt-16 text-xs text-gray-500 text-center">
          Software provided AS IS — see <Link to="/terms" className="underline">Terms</Link> and <Link to="/privacy" className="underline">Privacy</Link>.
        </footer>
      </main>
    </div>
  );
}
