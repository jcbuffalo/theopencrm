// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import HeroPreview from '../components/HeroPreview';
import { TOTAL_STAGE_COUNT } from '../zangStages';
import { VERTICALS } from '../marketing/verticals';
import { COMPARISONS, SHARED_DEMO } from '../marketing/comparisons';
import { TellItDemo, BuildMyCrmButton } from '../components/MarketingShell';

function ContactForm() {
  const [form, setForm] = useState({ name: '', email: '', company: '', message: '' });
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5001/api';
      await fetch(`${API_URL}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, interest: 'general inquiry' }),
      });
    } catch {
      // best-effort
    } finally {
      setSubmitted(true);
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="bg-white rounded-2xl p-12 text-center shadow-sm border border-gray-200">
        <div className="text-5xl mb-4">✅</div>
        <h3 className="text-2xl font-bold text-gray-900 mb-2">Message received!</h3>
        <p className="text-gray-600">We'll get back to you within 24 hours.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-2xl p-8 shadow-sm border border-gray-200 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
          <input
            type="text" required value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Your name"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
          <input
            type="email" required value={form.email}
            onChange={e => setForm({ ...form, email: e.target.value })}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="you@company.com"
          />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Company</label>
        <input
          type="text" value={form.company}
          onChange={e => setForm({ ...form, company: e.target.value })}
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Company name (optional)"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">What are you trying to solve? *</label>
        <textarea
          required rows={5} value={form.message}
          onChange={e => setForm({ ...form, message: e.target.value })}
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Tell us about your team size, current tools, and what's not working..."
        />
      </div>
      <button
        type="submit" disabled={submitting}
        className="w-full py-4 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-lg transition text-lg"
      >
        {submitting ? 'Sending...' : 'Send Message'}
      </button>
      <p className="text-center text-gray-500 text-sm">No spam. Honest advice. We respond within 24 hours.</p>
    </form>
  );
}

// Ribbon auto-retires after this date so the page never shows a stale
// "just launched" claim. Bump the date (or delete the ribbon block) for the
// next announcement.
const RIBBON_EXPIRES = new Date('2026-10-02T00:00:00Z');

export default function Landing() {
  const showRibbon = new Date() < RIBBON_EXPIRES;
  return (
    <div className="min-h-screen bg-white">
      {/* Launch announcement ribbon — self-expiring, see RIBBON_EXPIRES above */}
      {showRibbon && (
        <div className="bg-gray-900 text-gray-100 text-sm">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2 text-center">
            <span className="font-semibold text-white">Now open source — v1.0.</span>{' '}
            <Link to="/launch" className="underline text-white font-semibold hover:no-underline">Read the launch post →</Link>
          </div>
        </div>
      )}
      {/* Navigation */}
      <nav className="bg-white border-b border-gray-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <h1 className="text-2xl font-bold text-brand-blue">The Open CRM</h1>
          {/* Secondary links hide below md — the row was 5 items wide which
              pushed Sign In past the right edge on phones (mobile audit
              flagged Sign In offscreen at x=356 on a 393px viewport).
              Logo + Sign In are enough above the fold on mobile; secondary
              destinations are reachable via on-page anchors as the user
              scrolls and via the footer. */}
          <div className="flex gap-3 sm:gap-6 items-center">
            <a href="#whats-included" className="hidden md:inline-flex text-gray-600 hover:text-gray-900 text-sm py-2 items-center">What's Included</a>
            <a href="#customizations" className="hidden md:inline-flex text-gray-600 hover:text-gray-900 text-sm py-2 items-center">Add-ons</a>
            <a href="#pricing" className="inline-flex text-gray-600 hover:text-gray-900 text-sm py-2 items-center">Pricing</a>
            <Link to="/checklist" className="hidden md:inline-flex text-brand-blue hover:text-brand-blue-dark text-sm font-medium py-2 items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue rounded">Free Checklist</Link>
            <Link to="/login" className="px-4 py-2 bg-brand-blue hover:bg-brand-blue-dark text-white rounded-lg text-sm font-semibold min-h-[44px] inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:ring-offset-2">
              Sign In
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-24">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12 items-center">
          <div>
            {/* Positioning (spec 203, Part 1; adopted 2026-09-19): sell the
                CRM that configures around the business, not "open-source
                HubSpot alternative". Open source + price are proof points
                below the fold and on the comparison pages, not the headline. */}
            <div className="inline-block px-3 py-1 mb-5 bg-brand-blue/10 text-brand-blue rounded-full text-xs font-semibold uppercase tracking-wider">
              Open source · Free to start · Hosted from $15 a seat
            </div>
            <h2 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-gray-900 mb-5 leading-tight">
              Your CRM. Your rules.
            </h2>
            <p className="text-xl sm:text-2xl text-gray-700 mb-6 leading-snug">
              Describe how your business sells. The Open CRM proposes the pipeline, the fields, and the follow-ups to match — and nothing changes until you approve it.
            </p>
            <p className="hidden sm:block text-base sm:text-lg text-gray-600 mb-10 leading-relaxed">
              Start with a complete CRM. Tell it how you sell in plain English, or start from a template for a business like yours, and it builds the workspace around your process instead of making your process fit the software. Open source (AGPL-3.0): run it yourself for $0, or let us host it. AI is pay-as-you-go, or bring your own Anthropic key and pay no markup.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
              <BuildMyCrmButton className="justify-center" />
              <a href="#how-you-sell" className="px-6 sm:px-8 py-3 sm:py-4 border-2 border-gray-300 text-gray-900 rounded-lg text-base sm:text-lg font-semibold hover:bg-gray-50 text-center transition min-h-[44px] inline-flex items-center justify-center">
                See how it works
              </a>
            </div>
            <p className="text-gray-600 text-sm mt-5">
              Free to start, no approval queue · <a href="#pricing" className="text-brand-blue underline hover:no-underline">Pricing</a> · Already a user? <Link to="/login" className="text-brand-blue underline hover:no-underline">Sign in</Link> · <a href="https://github.com/jcbuffalo/theopencrm" target="_blank" rel="noreferrer" className="text-brand-blue underline hover:no-underline">Source on GitHub</a>
            </p>
          </div>
          <div>
            <HeroPreview />
            <p className="text-xs text-gray-500 text-center mt-3">Shown: a workspace being built from a plain-English description. Every change is proposed first; you tick what you want.</p>
          </div>
        </div>
      </section>

      {/* Chat-First — the differentiation play. Sits ABOVE the rest of the
          features sections because it IS the headline; everything else is
          proof that the underlying CRM is real. */}
      <section className="bg-gradient-to-br from-gray-50 to-blue-50 py-16 sm:py-20 border-y border-gray-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-10 lg:gap-14 items-center">
            <div className="lg:col-span-2">
              <div className="inline-block px-3 py-1 mb-4 bg-brand-blue text-white rounded-full text-xs font-semibold uppercase tracking-wider">
                New · Chat-First mode
              </div>
              <h3 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4 leading-tight">
                The antidote to feature creep.
              </h3>
              <p className="text-base sm:text-lg text-gray-700 mb-4 leading-relaxed">
                Every other CRM hands you a menu of forty things and tells you to pick the right one. We hand you a conversation.
              </p>
              <p className="text-base sm:text-lg text-gray-700 mb-6 leading-relaxed">
                Ask "what should I do today?" — get a curated answer grounded in your actual pipeline. Ask "draft a check-in to John at Acme" — get a draft. Ask "who's gone dark?" — get a focused list with reasoning.
              </p>
              <ul className="space-y-2 text-sm text-gray-700 mb-6">
                <li className="flex gap-2 items-start"><span className="text-brand-blue font-bold mt-0.5">✓</span> Multi-turn — follow up, refine, dig deeper without losing context</li>
                <li className="flex gap-2 items-start"><span className="text-brand-blue font-bold mt-0.5">✓</span> Tool-grounded — every answer references real deals, real tasks, real activity</li>
                <li className="flex gap-2 items-start"><span className="text-brand-blue font-bold mt-0.5">✓</span> Action chips — one tap to open a deal, show overdue tasks, or open a draft</li>
                <li className="flex gap-2 items-start"><span className="text-brand-blue font-bold mt-0.5">✓</span> Mobile-first — same conversation on your phone walking into a meeting</li>
              </ul>
              <p className="text-sm text-gray-500">
                Included free — the copilot is the front door. The Open CRM logo for authenticated users opens it. You're only ever billed for the AI tokens it spends on your behalf.
              </p>
            </div>

            {/* Mock screenshot — built from the same primitives as the real
                Chat.js to keep the marketing surface in sync. */}
            <div className="lg:col-span-3">
              <div className="bg-white rounded-2xl shadow-xl border border-gray-200 overflow-hidden">
                <div className="bg-gray-50 border-b border-gray-200 px-4 py-2.5 flex items-center gap-2">
                  <div className="flex gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                  </div>
                  <span className="text-xs text-gray-500 ml-2">theopencrm.com/chat</span>
                </div>
                <div className="p-5 sm:p-6 space-y-3">
                  <div className="text-sm text-gray-500">Hey Sarah. What's on your plate?</div>

                  <div className="flex justify-end">
                    <div className="max-w-[85%] bg-brand-blue text-white rounded-2xl rounded-tr-sm px-4 py-2 text-sm">
                      What should I do today?
                    </div>
                  </div>

                  <div className="flex justify-start">
                    <div className="max-w-[90%]">
                      <div className="bg-gray-100 text-gray-900 rounded-2xl rounded-tl-sm px-4 py-3 text-sm">
                        Start with <strong>Acme Industrial</strong>. They've been in CUSTOMER_QUOTING for 14 days and you have a $52K quote out — that's your highest-value stalled deal. Two overdue tasks and one dormant customer can wait.
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-brand-blue text-brand-blue text-xs font-medium rounded-full shadow-sm">Open Acme deal →</span>
                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-brand-blue text-brand-blue text-xs font-medium rounded-full shadow-sm">Draft a follow-up ✎</span>
                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-brand-blue text-brand-blue text-xs font-medium rounded-full shadow-sm">Show overdue tasks →</span>
                      </div>
                      <div className="mt-1.5 text-[11px] text-gray-400 px-1">Looked up: summarize attention, list deals.</div>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-gray-100 mt-3">
                    <div className="bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-xs text-gray-400">Ask anything about your pipeline…</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Built for how you sell — the spec-203 wedge. Links every vertical
          page + comparison page and mirrors the "Tell it how you sell" demo
          those pages use. Hero positioning is deliberately untouched here;
          that call is the owner's. */}
      <section id="how-you-sell" className="py-16 sm:py-20 border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl mb-10">
            <div className="inline-block px-3 py-1 mb-4 bg-brand-blue/10 text-brand-blue rounded-full text-xs font-semibold uppercase tracking-wider">
              Built for how you sell
            </div>
            <h3 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4 leading-tight">
              Pick your business. The CRM configures around it.
            </h3>
            <p className="text-base sm:text-lg text-gray-700 leading-relaxed">
              Most CRMs hand you a six-stage funnel and a settings page. Here the first screen after signup is one text box: describe how you sell, the way you would to a new hire. It proposes the stages, the fields, a follow-up rule and a saved view. You tick what you want. Or start from one of these twelve.
            </p>
          </div>

          <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-12">
            {VERTICALS.map((v) => (
              <li key={v.id}>
                <Link
                  to={`/crm-for/${v.slug}`}
                  className="block h-full min-h-[44px] rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm font-medium text-gray-900 hover:border-brand-blue hover:text-brand-blue transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
                >
                  {v.name}
                </Link>
              </li>
            ))}
          </ul>

          <div className="mb-12">
            <TellItDemo demo={SHARED_DEMO} />
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-8">
            <BuildMyCrmButton />
            <p className="text-sm text-gray-600">
              Switching from something?{' '}
              {COMPARISONS.map((c, i) => (
                <React.Fragment key={c.slug}>
                  {i > 0 && <span aria-hidden="true"> · </span>}
                  <Link to={c.path} className="text-brand-blue underline hover:no-underline whitespace-nowrap">{c.eyebrow}</Link>
                </React.Fragment>
              ))}
            </p>
          </div>
        </div>
      </section>

      {/* Vision — the future-facing pitch */}
      <section className="bg-gradient-to-br from-brand-blue to-brand-blue-dark text-white py-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12 max-w-3xl mx-auto">
            <div className="inline-block px-3 py-1 mb-4 bg-white/15 text-white rounded-full text-xs font-semibold uppercase tracking-wider">
              The future of CRM
            </div>
            <h3 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-6 leading-tight">
              Every salesperson is their own admin.
            </h3>
            <p className="text-lg sm:text-xl text-blue-50 leading-relaxed">
              The leading CRM platforms were built before AI was a substrate. They charge enterprise prices for tools that demand admin certifications, six-week implementations, and walled-garden plugin marketplaces. We're building the opposite.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-10">
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-6 border border-white/20">
              <div className="text-3xl mb-3">🛠️</div>
              <h4 className="text-xl font-bold mb-2">Customization without code</h4>
              <p className="text-blue-50 text-sm leading-relaxed">
                Describe an automation in plain English. Claude generates the plugin spec, you confirm, deploy.
                No admin certification. No implementation consultant. No four-week wait.
              </p>
            </div>
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-6 border border-white/20">
              <div className="text-3xl mb-3">🧠</div>
              <h4 className="text-xl font-bold mb-2">AI as the substrate</h4>
              <p className="text-blue-50 text-sm leading-relaxed">
                Not a checkbox feature behind a 2× SKU. Activity summaries, follow-up drafts, a copilot that
                can take actions (confirm-first), and the plugin author itself — all Claude, billed by usage on top (or bring your own key).
              </p>
            </div>
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-6 border border-white/20">
              <div className="text-3xl mb-3">💰</div>
              <h4 className="text-xl font-bold mb-2">Open source, fair hosting</h4>
              <p className="text-blue-50 text-sm leading-relaxed">
                Self-host the whole thing for $0, or get managed hosting from $15 a seat — a fraction of the
                incumbents. AI is pay-as-you-go on top, or bring your own key and pay no markup. No acquisition debt to subsidize.
              </p>
            </div>
          </div>

          <div className="mt-12 bg-white/10 backdrop-blur-sm rounded-xl p-6 sm:p-8 border border-white/20 max-w-4xl mx-auto">
            <div className="text-xs uppercase tracking-wider text-blue-100 font-semibold mb-2">Where this goes</div>
            <p className="text-lg sm:text-xl leading-relaxed text-white">
              Every salesperson, ops lead, and founder runs a workspace tailored to <em>their</em> business — not the
              spreadsheet of fields the vendor's roadmap committee decided to ship. Tenants are isolated. Plugins run
              live in a sandbox — confirm-first, so nothing writes to your data without a human approving it. Your data
              is yours. If you ever want to leave, fork the codebase and take it with you.
            </p>
            <p className="text-sm text-blue-100 mt-4">
              Licensed AGPL-3.0 — self-host it freely, modify it, run it for your team. The hosted service is the convenience option, not the only option.{' '}
              <a href="https://github.com/jcbuffalo/theopencrm" target="_blank" rel="noreferrer" className="underline text-white">Read the code on GitHub</a>.
            </p>
          </div>
        </div>
      </section>

      {/* Why Different — directly contrasting against incumbents without naming them */}
      <section className="bg-gray-50 py-16 sm:py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12 max-w-3xl mx-auto">
            <h3 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">Why The Open CRM?</h3>
            <p className="text-base sm:text-lg text-gray-600 leading-relaxed">
              Six things you get here that the leading platforms still make hard.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-8">
            {[
              {
                title: 'Stand up in a session',
                description: 'Pre-built pipeline, contacts, deals, activities, quotes — working out of the box. No implementation consultants. No six-week kickoff. Sign up and you\'re in — no approval queue — so you can demo today.',
                icon: '⚡',
              },
              {
                title: 'Plain-English customization',
                description: 'Describe a workflow — "email the warehouse when a deal hits ORDACK" — and Claude builds the plugin. No certification. No JSON wizardry. Your salespeople become admins.',
                icon: '🛠️',
              },
              {
                title: 'AI billed by usage, not by SKU',
                description: 'Deal summaries, follow-up drafts, a chat copilot that can act (confirm-first), and pluggable enrichment. Pay-as-you-go on top of hosting — a live meter shows every cent — or bring your own Anthropic key and pay no markup. No "AI Hub" SKU at 2× the price.',
                icon: '🧠',
              },
              {
                title: 'Open source at the core',
                description: 'The whole CRM is open source under the AGPL-3.0. Self-host it for $0 on your own infrastructure, or get fully-managed hosting from $15 a seat. Your data is portable and exportable, always — no lock-in.',
                icon: '🌍',
              },
              {
                title: 'Multi-tenant or your own fork',
                description: 'Run on our hosted service, or take the AGPL-3.0 codebase and run it yourself — the licence guarantees you can. The hosted service is the convenience option; no vendor lock-in, and your data is portable on day one.',
                icon: '🔓',
              },
              {
                title: 'Built for the vertical you actually have',
                description: 'A generic CRM by default. For specialized workflows — manufacturer\'s rep RFQ-to-PO, multi-vendor quoting, post-shipment service contracts — flip the profile and the entire UI reshapes itself.',
                icon: '🎯',
              },
            ].map((item, i) => (
              <div key={i} className="bg-white rounded-lg p-6 sm:p-8 shadow-sm hover:shadow-md transition-shadow border border-gray-100">
                <div className="text-4xl sm:text-5xl mb-4">{item.icon}</div>
                <h4 className="text-lg sm:text-xl font-semibold text-gray-900 mb-3">{item.title}</h4>
                <p className="text-sm sm:text-base text-gray-600 leading-relaxed">{item.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* What's Included */}
      <section id="whats-included" className="py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h3 className="text-4xl font-bold text-gray-900 mb-4 text-center">Everything Out of the Box</h3>
          <p className="text-xl text-gray-600 text-center mb-16 max-w-2xl mx-auto">
            Every account gets the complete CRM — no tier gates on functionality, ever.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
            {/* Left: Core Features */}
            <div>
              <h4 className="text-2xl font-bold text-gray-900 mb-6">Core CRM Included</h4>
              <ul className="space-y-4">
                {[
                  'Chat-First AI Copilot — the front door; confirm-first writes, included free',
                  'Contact & Company Management — Full profiles with custom fields',
                  'Sales Pipeline — Kanban board with drag-to-stage deal movement',
                  'Deal Tracking — Amount, probability, close date, custom stages',
                  'Email Integration — Two-way sync, tracking, and sequences',
                  'Activities Log — Calls, emails, meetings with timestamps',
                  'Task Management — Due dates, priorities, ownership tracking',
                  'Advanced Reporting — Forecasting, custom dashboards, win/loss analysis',
                  'Bulk Import/Export — HubSpot/Salesforce import, CSV export anytime',
                  'Custom Fields & API Webhooks — Extend records, wire up your own tools',
                  'Extension Library — 57 ready-made automations, one click to install',
                  'Search & Filters — Find contacts/deals in seconds',
                  'Real-time Dashboard — Key metrics at a glance',
                  'User Management — Team access controls and permissions',
                  'Google OAuth — Secure login, no password management',
                ].map((feature, i) => (
                  <li key={i} className="flex gap-3 items-start">
                    <span className="text-green-700 font-bold text-lg mt-0.5">✓</span>
                    <span className="text-gray-700">{feature}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Right: Tech Stack */}
            <div>
              <h4 className="text-2xl font-bold text-gray-900 mb-6">Built With Modern Tech</h4>
              <div className="space-y-6">
                <div>
                  <h5 className="font-semibold text-gray-900 mb-3">Frontend</h5>
                  <p className="text-gray-600 mb-2"><strong>React 18</strong> — Component-based, fast rendering</p>
                  <p className="text-gray-600 mb-2"><strong>React Router</strong> — Client-side navigation</p>
                  <p className="text-gray-600"><strong>Tailwind CSS</strong> — Beautiful, responsive UI</p>
                </div>
                <div>
                  <h5 className="font-semibold text-gray-900 mb-3">Backend</h5>
                  <p className="text-gray-600 mb-2"><strong>Express.js</strong> — Lightweight Node.js framework</p>
                  <p className="text-gray-600 mb-2"><strong>PostgreSQL</strong> — Reliable relational database</p>
                  <p className="text-gray-600"><strong>JWT Auth</strong> — Secure token-based authentication</p>
                </div>
                <div>
                  <h5 className="font-semibold text-gray-900 mb-3">Infrastructure</h5>
                  <p className="text-gray-600 mb-2"><strong>Cloud Run</strong> — Serverless, auto-scaling deployment</p>
                  <p className="text-gray-600 mb-2"><strong>Cloud SQL</strong> — Managed PostgreSQL instances</p>
                  <p className="text-gray-600"><strong>Auto Migrations</strong> — Schema updates on startup</p>
                </div>
                <div>
                  <h5 className="font-semibold text-gray-900 mb-3">AI, built in</h5>
                  <p className="text-gray-600"><strong>Claude</strong> — Powers the chat copilot, deal summaries, follow-up drafts, and the extension builder. Pay-as-you-go on top, or bring your own key.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Customizations / Add-ons */}
      <section id="customizations" className="bg-blue-50 py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h3 className="text-4xl font-bold text-gray-900 mb-4 text-center">Beyond the extension library</h3>
          <p className="text-xl text-gray-600 text-center mb-16 max-w-2xl mx-auto">
            Everything above ships free on every account. These are the things that genuinely need a
            conversation first.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {[
              {
                title: 'A new white-label vertical',
                description: 'Your own stage set, terminology, and entities — a config addition, not a fork. We\'ve done it for two verticals already.',
                badge: 'Custom',
              },
              {
                title: 'Data migration & onboarding',
                description: 'Hands-on help moving off Salesforce/HubSpot beyond the self-serve CSV import — mapping, cleanup, and a guided cutover.',
                badge: 'Custom',
              },
              {
                title: 'Integrations outside the sandbox',
                description: 'The extension sandbox has no outbound network access by design. Slack, niche vendor APIs, and other outside-the-allowlist integrations are built as one-off connectors.',
                badge: 'Custom',
              },
              {
                title: 'SSO (OIDC) + SCIM',
                description: 'Built and shipped, off by default — enabled for your org on request.',
                badge: 'Enterprise',
              },
              {
                title: 'Private-cloud / on-prem deployment',
                description: 'Run the hosted experience on your own cloud account or infrastructure.',
                badge: 'Enterprise',
              },
              {
                title: 'Dedicated support + SLA',
                description: 'A committed response time and a named point of contact.',
                badge: 'Enterprise',
              },
            ].map((item, i) => (
              <div key={i} className="bg-white rounded-lg p-6 shadow-sm hover:shadow-md transition-shadow">
                <div className="flex justify-between items-start mb-3">
                  <h4 className="text-lg font-semibold text-gray-900 flex-1">{item.title}</h4>
                  <span className={`text-xs font-semibold px-3 py-1 rounded-full whitespace-nowrap ml-2 ${
                    item.badge === 'Enterprise'
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-purple-100 text-purple-700'
                  }`}>
                    {item.badge}
                  </span>
                </div>
                <p className="text-gray-600">{item.description}</p>
              </div>
            ))}
          </div>

          <div className="mt-12 bg-white rounded-lg p-8 border-2 border-blue-200">
            <h4 className="text-2xl font-bold text-gray-900 mb-3">Not Sure What You Need?</h4>
            <p className="text-gray-600 mb-6">
              Talk to our team. We'll help you design the perfect setup for your workflow, then build the customizations that matter.
            </p>
            <a href="mailto:team@theopencrm.com" className="text-blue-600 font-semibold hover:underline">
              Schedule a consultation →
            </a>
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section id="pricing" className="py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h3 className="text-4xl font-bold text-gray-900 mb-4 text-center">Open source at the core. Fair pricing on top.</h3>
          <p className="text-xl text-gray-600 text-center mb-4 max-w-3xl mx-auto">
            Run the whole CRM yourself for <span className="font-semibold text-brand-blue">$0</span>, try it hosted free, or step up to paid hosted plans from <span className="font-semibold text-brand-blue">$15 a seat</span> — a fraction of what the incumbents charge. AI sits on top: pay-as-you-go, or bring your own Anthropic key and pay no markup.
          </p>
          <p className="text-sm text-gray-500 text-center mb-16 max-w-2xl mx-auto">
            The software is open source (AGPL-3.0) and yours either way. AI usage is billed on top of hosted plans, or bring your own key; a quiet month adds nothing.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-4">
            {[
              {
                name: 'Self-Host',
                price: '$0',
                period: 'open source (AGPL-3.0), forever',
                description: 'Run it on your own infrastructure — github.com/jcbuffalo/theopencrm',
                features: [
                  'The entire CRM — every module, no feature gates',
                  'Unlimited users, contacts, deals, storage',
                  'Your servers, your database, your data',
                  'AI with your own Anthropic key — no markup',
                  'Community support + public roadmap',
                ],
                icon: '🌍',
              },
              {
                name: 'Free (hosted)',
                price: '$0',
                period: 'per workspace / forever',
                description: 'Try the full product hosted — no card required',
                features: [
                  '1 seat, up to 100 contacts, 10 deals, 100 companies',
                  'The full CRM — every module, no feature gates',
                  'Fully managed + autoscaled — nothing to run',
                  'AI pay-as-you-go, or bring your own key (no markup)',
                  'Upgrade any time as you outgrow the caps',
                ],
                icon: '🌱',
              },
              {
                name: 'Starter',
                price: '$15',
                period: 'per seat / month',
                description: 'A working team, no seat caps on data',
                features: [
                  'Up to 10 seats, unlimited contacts/deals/companies',
                  'The full CRM — every module, no feature gates',
                  'Roles + permissions for the whole team',
                  'AI pay-as-you-go, or bring your own key (no markup)',
                  'Radically under HubSpot ($90–100/seat)',
                ],
                highlighted: true,
                icon: '⚡',
              },
              {
                name: 'Pro',
                price: '$39',
                period: 'per seat / month',
                description: 'For teams leaning on extensions',
                features: [
                  'Up to 50 seats, unlimited contacts/deals/companies',
                  'Everything in Starter',
                  'Extension autonomous mode (unattended writes)',
                  'Priority support',
                ],
                icon: '🚀',
              },
              {
                name: 'AI',
                price: 'Usage',
                period: 'pay-as-you-go, or bring your own key',
                description: 'Usage-based, on top of any hosted plan',
                features: [
                  'Chat copilot, deal summaries, follow-up drafts',
                  'Billed by actual usage — no AI seat SKU',
                  'Live usage meter — see every cent',
                  'Bring your own Anthropic key and pay no markup',
                  'A quiet month adds nothing',
                ],
                icon: '🧠',
              },
              {
                name: 'Enterprise',
                price: 'Custom',
                period: 'support + SLA',
                description: 'Where compliance & scale live',
                features: [
                  'Everything in Pro, plus:',
                  'SSO (OIDC) + SCIM, audit, white-label',
                  'Volume AI rates + committed-use discounts',
                  'Dedicated support + SLA',
                  'Private-cloud / on-prem deployment (roadmap)',
                ],
                icon: '🏢',
              },
            ].map((plan, i) => (
              <div
                key={i}
                className={`rounded-xl overflow-hidden transition-transform hover:scale-105 ${
                  plan.highlighted
                    ? 'bg-gradient-to-br from-blue-600 to-blue-700 text-white shadow-xl ring-2 ring-blue-400'
                    : 'bg-white border-2 border-gray-200'
                }`}
              >
                <div className="p-8">
                  <div className="text-5xl mb-4">{plan.icon}</div>
                  <h4 className={`text-2xl font-bold mb-2 ${!plan.highlighted && 'text-gray-900'}`}>
                    {plan.name}
                  </h4>
                  <p className={`text-sm mb-4 ${plan.highlighted ? 'text-blue-100' : 'text-gray-600'}`}>
                    {plan.description}
                  </p>
                  <p className={`text-4xl font-bold mb-1 ${!plan.highlighted && 'text-gray-900'}`}>
                    {plan.price}
                  </p>
                  <p className={`text-sm mb-8 ${plan.highlighted ? 'text-blue-100' : 'text-gray-600'}`}>
                    {plan.period}
                  </p>

                  <ul className="space-y-3 mb-8">
                    {plan.features.map((feature, j) => (
                      <li key={j} className={`flex items-start gap-2 text-sm ${plan.highlighted ? 'text-blue-50' : 'text-gray-700'}`}>
                        <span className="text-lg mt-0.5">✓</span>
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>

                  <Link
                    to="/request-access"
                    className={`block w-full text-center py-3 rounded-lg font-semibold transition-colors ${
                      plan.highlighted
                        ? 'bg-white text-brand-blue hover:bg-blue-50'
                        : 'bg-brand-blue text-white hover:bg-brand-blue-dark'
                    }`}
                  >
                    Get started
                  </Link>
                </div>
              </div>
            ))}
          </div>

          {/* Honesty section — what's shipped vs. what's coming. We'd rather
              be straight than oversell. */}
          <div className="mt-16 bg-gray-50 border border-gray-200 rounded-xl p-6 sm:p-8">
            <h4 className="text-lg font-bold text-gray-900 mb-3">What's live today vs. what's coming</h4>
            <p className="text-sm text-gray-600 mb-4">
              We believe in shipping what we sell. Every feature listed is <strong>live in production</strong> and exercisable on the day you sign up — no tier gates it away. A few items are explicitly on the roadmap — we say so up front rather than hide it.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <div className="font-semibold text-emerald-700 mb-1">✓ Live now (free — every account)</div>
                <ul className="text-gray-700 space-y-1 list-disc pl-5">
                  <li>Multi-tenant SaaS, autoscaled on Google Cloud</li>
                  <li>Chat-First AI copilot with confirm-first writes; deal summaries + email drafts</li>
                  <li>Two-way email sync + Google Calendar meetings on the timeline</li>
                  <li>Sales forecasting, custom report builder, dashboards</li>
                  <li>Product catalog + quotes (CPQ); SMS + call logging</li>
                  <li>No-code automation rule builder; contact/company dedup &amp; merge</li>
                  <li>Plugins that execute live in a sandbox (confirm-first) + curated library</li>
                  <li>API keys + outbound webhooks (Zapier-ready); white-label + per-org flags</li>
                  <li>Self-service data export + deletion (GDPR/CCPA); tamper-resistant audit log</li>
                </ul>
              </div>
              <div>
                <div className="font-semibold text-amber-700 mb-1">🗺 On the roadmap / on request</div>
                <ul className="text-gray-700 space-y-1 list-disc pl-5">
                  <li>Enterprise SSO (OIDC) + SCIM — built, enabled on request</li>
                  <li>AI-driven multi-step campaigns</li>
                  <li>Plugin marketplace publishing</li>
                  <li>On-premise / private-cloud deployment</li>
                  <li>SOC 2 + ISO 27001 certifications</li>
                  <li>Third-party pen test (scheduled at customer #5)</li>
                </ul>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-4">
              Full feature-status matrix: <a href="https://github.com/jcbuffalo/theopencrm" target="_blank" rel="noreferrer" className="text-brand-blue underline">PRICING_AND_FEATURES.md</a>
            </p>
          </div>

          <div className="mt-12 text-center">
            <p className="text-gray-600 mb-2 text-sm max-w-2xl mx-auto">
              <span className="font-semibold">The math:</span> HubSpot Sales Hub runs $100/user/month — a 10-person team pays $12,000 a year before they've closed a deal. Managed hosting here starts at $15/seat ($1,800/yr for that same team), the self-host option is $0, and AI is pay-as-you-go on top — or bring your own key. Either way the software is open source and yours.
            </p>
            <p className="text-gray-600 mb-4">Sign up and you're in — no approval queue. AI usage pricing may be tuned as we learn from real-world usage.</p>
            <p className="text-gray-600">Have questions? <a href="mailto:johnbcoles@gmail.com" className="text-brand-blue font-semibold underline hover:no-underline">Email us</a></p>
          </div>
        </div>
      </section>

      {/* Free Checklist Lead Magnet */}
      <section className="py-20 bg-gray-900 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <div>
              <p className="text-blue-400 text-sm font-semibold uppercase tracking-wide mb-3">Free Resource</p>
              <h3 className="text-4xl font-bold mb-4">
                Before You Sign Anything — Read This First
              </h3>
              <p className="text-gray-300 text-lg mb-6">
                We built The Open CRM around a simple idea: most teams need a focused, configurable
                CRM — not a maximalist platform with hundreds of features they'll never touch.
              </p>
              <p className="text-gray-300 mb-8">
                Before you sign with any CRM vendor, download our free Decision Checklist. It walks through
                cost-of-ownership questions, red flags in custom-build proposals, and the questions every vendor
                should be able to answer.
              </p>
              <div className="space-y-3">
                {[
                  'Total cost of ownership questions to ask',
                  'Red flags in custom-build proposals',
                  'Questions every vendor should answer in writing',
                  'Build vs. buy decision framework',
                  'Vendor evaluation scorecard',
                ].map((item, i) => (
                  <p key={i} className="flex gap-3 items-start text-gray-300">
                    <span className="text-green-400 font-bold mt-0.5">✓</span>
                    {item}
                  </p>
                ))}
              </div>
            </div>
            <div className="bg-white rounded-2xl p-8 text-gray-900">
              <h4 className="text-2xl font-bold mb-2">Get the Free Checklist</h4>
              <p className="text-gray-600 mb-6">No email required — it's right there, open to everyone.</p>
              <Link
                to="/checklist"
                className="block w-full text-center py-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg text-lg mb-4"
              >
                View the Free Checklist →
              </Link>
              <p className="text-gray-500 text-sm text-center mb-6">Or get a personal consultation below</p>
              <div className="border-t pt-6">
                <p className="text-gray-700 font-medium mb-1">Have a specific situation?</p>
                <p className="text-gray-600 text-sm mb-4">
                  Tell us about your team and we'll give you an honest recommendation — even if it's not us.
                </p>
                <a
                  href="#contact"
                  className="block w-full text-center py-3 border-2 border-blue-600 text-blue-600 hover:bg-blue-50 font-semibold rounded-lg"
                >
                  Talk to Us
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Contact Form */}
      <section id="contact" className="py-20 bg-gray-50">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <h3 className="text-4xl font-bold text-gray-900 mb-4 text-center">Get in Touch</h3>
          <p className="text-xl text-gray-600 text-center mb-12">
            Not sure if we're the right fit? Tell us what you're working with — we'll be straight with you.
          </p>
          <ContactForm />
        </div>
      </section>

      {/* See it in action — three-up of real product surfaces */}
      <section className="bg-white py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h3 className="text-4xl font-bold text-gray-900 mb-3 text-center">See it in action</h3>
          <p className="text-xl text-gray-600 text-center mb-12 max-w-2xl mx-auto">
            Three workflows in one platform. Pick the path that matches your business.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="border border-gray-200 rounded-xl p-6 hover:shadow-md transition">
              <div className="text-3xl mb-3">📊</div>
              <h4 className="text-xl font-bold text-gray-900 mb-2">Generic CRM</h4>
              <p className="text-gray-600 text-sm mb-4">Companies, contacts, 6-stage deal pipeline, activities, tasks. Drag-and-drop Kanban. CSV import from HubSpot or Salesforce. The shape every sales team needs.</p>
              <p className="text-xs text-gray-500">Default for new sign-ups. White-labelable per org.</p>
            </div>
            <div className="border-2 border-brand-blue rounded-xl p-6 hover:shadow-md transition relative">
              <span className="absolute -top-3 left-4 bg-brand-blue text-white text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded">Vertical</span>
              <div className="text-3xl mb-3">🏭</div>
              <h4 className="text-xl font-bold text-gray-900 mb-2">Manufacturer's-Rep</h4>
              <p className="text-gray-600 text-sm mb-4">Full RFQ → vendor quote comparison → branded customer quote → PO → submittal → shipment → invoicing → service contract. {TOTAL_STAGE_COUNT}-stage lifecycle from a real customer SOW.</p>
              <p className="text-xs text-gray-500">Built for HC Zang Agency; available as a configured profile.</p>
            </div>
            <div className="border border-gray-200 rounded-xl p-6 hover:shadow-md transition">
              <div className="text-3xl mb-3">🧩</div>
              <h4 className="text-xl font-bold text-gray-900 mb-2">Your vertical, configured</h4>
              <p className="text-gray-600 text-sm mb-4">Adding a new vertical is a config change, not a fork. Define your stages, terminology, and entities; share the platform's bug fixes and security improvements.</p>
              <p className="text-xs text-gray-500">Talk to us about scoping your custom profile.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Honest CTA — replaces "Try Free for 30 Days" since signup is self-serve, not a trial */}
      <section className="bg-gradient-to-r from-brand-blue to-brand-blue-dark text-white py-16 sm:py-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h3 className="text-3xl sm:text-4xl font-bold mb-6">Stop paying seat licenses for software that doesn't fit.</h3>
          <p className="text-lg sm:text-xl text-blue-100 mb-10 leading-relaxed">
            Open source (AGPL-3.0), fair hosting from $15 a seat, pay-as-you-go AI or your own key on top, plain-English customization, your data portable. The CRM you'd build for yourself — if you had a year and a team.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link to="/request-access" className="px-8 py-4 bg-white text-brand-blue rounded-lg font-semibold hover:bg-gray-50 inline-block text-lg">
              Get started free
            </Link>
            <Link to="/pitch" className="px-8 py-4 border-2 border-white text-white hover:bg-white hover:text-brand-blue rounded-lg font-semibold inline-block text-lg transition">
              See the full deck
            </Link>
          </div>
          <p className="text-xs text-blue-200 mt-6">Sign up and you're in — no approval queue.</p>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-900 text-gray-400 py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
            <div>
              <h5 className="text-white font-semibold mb-4">The Open CRM</h5>
              <p className="text-sm">A lightweight, configurable CRM. White-labelable per workflow.</p>
            </div>
            {/* Footer link tap targets: each <a> is block + min-h-[32px] +
                flex items-center so the touch area meets 32px on mobile.
                Previously the inline anchors rendered at ~20px (text-sm line
                height) — the mobile audit flagged dozens of footer links as
                tiny tap targets across every public page. */}
            <div>
              <h6 className="text-white font-semibold mb-4">Product</h6>
              <ul className="space-y-1 text-sm">
                <li><a href="#whats-included" className="block py-1 min-h-[32px] flex items-center hover:text-white">What's Included</a></li>
                <li><a href="#customizations" className="block py-1 min-h-[32px] flex items-center hover:text-white">Customizations</a></li>
                <li><a href="#pricing" className="block py-1 min-h-[32px] flex items-center hover:text-white">Pricing</a></li>
                <li><Link to="/pitch" className="block py-1 min-h-[32px] flex items-center hover:text-white">Generic deck</Link></li>
              </ul>
            </div>
            <div>
              <h6 className="text-white font-semibold mb-4">Company</h6>
              <ul className="space-y-1 text-sm">
                <li><a href="#contact" className="block py-1 min-h-[32px] flex items-center hover:text-white">Contact</a></li>
                <li><a href="mailto:johnbcoles@gmail.com" className="block py-1 min-h-[32px] flex items-center hover:text-white">Email us</a></li>
              </ul>
            </div>
            <div>
              <h6 className="text-white font-semibold mb-4">Legal</h6>
              <ul className="space-y-1 text-sm">
                <li><a href="/privacy" className="block py-1 min-h-[32px] flex items-center hover:text-white">Privacy Policy</a></li>
                <li><a href="/terms" className="block py-1 min-h-[32px] flex items-center hover:text-white">Terms of Service</a></li>
                <li><a href="/data-deletion" className="block py-1 min-h-[32px] flex items-center hover:text-white">Delete my data</a></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-gray-800 pt-8 text-sm text-center space-y-1">
            <p>&copy; 2026 John Coles. All rights reserved.</p>
            <p className="text-xs text-gray-500">Software provided AS IS, without warranty. See <a href="/terms" className="underline hover:text-white">Terms</a> and <a href="/privacy" className="underline hover:text-white">Privacy Policy</a>.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
