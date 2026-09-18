// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useState } from 'react';
import { Link } from 'react-router-dom';

const Section = ({ title, icon, children }) => (
  <div className="mb-12">
    <h2 className="text-2xl font-bold text-gray-900 mb-6 flex items-center gap-3 pb-3 border-b-2 border-blue-100">
      <span className="text-3xl">{icon}</span>
      {title}
    </h2>
    {children}
  </div>
);

const CheckItem = ({ text, sub }) => (
  <li className="flex items-start gap-3 py-2">
    <span className="mt-1 w-5 h-5 rounded border-2 border-gray-400 flex-shrink-0 print:border-gray-600"></span>
    <div>
      <p className="text-gray-800">{text}</p>
      {sub && <p className="text-gray-500 text-sm mt-0.5">{sub}</p>}
    </div>
  </li>
);

const RedFlag = ({ text }) => (
  <li className="flex items-start gap-3 py-2">
    <span className="text-red-500 font-bold text-lg flex-shrink-0">⚠</span>
    <p className="text-gray-800">{text}</p>
  </li>
);

const GreenFlag = ({ text }) => (
  <li className="flex items-start gap-3 py-2">
    <span className="text-green-600 font-bold text-lg flex-shrink-0">✓</span>
    <p className="text-gray-800">{text}</p>
  </li>
);

const CostRow = ({ label, low, high, notes }) => (
  <tr className="border-b border-gray-100">
    <td className="py-3 px-4 font-medium text-gray-900">{label}</td>
    <td className="py-3 px-4 text-gray-700">{low}</td>
    <td className="py-3 px-4 text-gray-700">{high}</td>
    <td className="py-3 px-4 text-gray-600 text-sm">{notes}</td>
  </tr>
);

export default function Checklist() {
  const [formData, setFormData] = useState({ name: '', email: '', company: '', message: '' });
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
        body: JSON.stringify({ ...formData, interest: 'checklist + consultation' }),
      });
      setSubmitted(true);
    } catch {
      setSubmitted(true); // still show success — email submission is best-effort
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-white">
      {/* Nav */}
      <nav className="bg-white border-b border-gray-200 sticky top-0 z-50 print:hidden">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <Link to="/" className="text-xl font-bold text-blue-600">The Open CRM</Link>
          <div className="flex gap-4 items-center">
            <Link to="/" className="text-gray-600 hover:text-gray-900 text-sm">Home</Link>
            <Link to="/login" className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm">Sign In</Link>
          </div>
        </div>
      </nav>

      {/* Header */}
      <div className="bg-gradient-to-br from-blue-600 to-blue-800 text-white py-16 print:py-8">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-blue-200 text-sm font-semibold uppercase tracking-wide mb-3">Free Resource</p>
            <h1 className="text-4xl md:text-5xl font-bold mb-4">The CRM Decision Checklist</h1>
            <p className="text-xl text-blue-100 mb-6">
              Before you sign a contract, buy a subscription, or hand a developer $50,000 — work through this first.
            </p>
            <p className="text-blue-200">
              Covers: Build vs. Buy analysis · True cost of ownership · Red flags in custom CRM proposals ·
              Questions every vendor must answer · Evaluation scorecard
            </p>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16">

        {/* Section 1: Audit your current situation */}
        <Section title="Step 1 — Audit Your Current Situation" icon="🔍">
          <p className="text-gray-600 mb-6">Before evaluating any new CRM, be honest about what you have and what you actually need. Most businesses outgrow spreadsheets before they need Salesforce.</p>
          <ul className="space-y-1">
            <CheckItem text="How are you currently tracking customers and deals?" sub="Spreadsheet, email inbox, sticky notes, or existing CRM?" />
            <CheckItem text="How many active contacts / companies do you manage?" sub="Under 500 = simple CRM. 500–5k = mid-market. 5k+ = need proper segmentation." />
            <CheckItem text="How many people on your team will use the CRM?" sub="Under 10 users = lightweight tool works fine. 10–50 = need roles/permissions." />
            <CheckItem text="What does your sales process actually look like?" sub="Map it out: Lead → Qualified → Proposal → Negotiation → Close. If you can't draw it, don't buy software yet." />
            <CheckItem text="What's your #1 pain point with the current system?" sub="'We lose track of deals' → pipeline. 'We don't know who talked to who' → activity log. 'We can't report on anything' → analytics." />
            <CheckItem text="What integrations do you actually use daily?" sub="Email, calendar, Slack, billing. Only pay for integrations you'll set up in week 1." />
            <CheckItem text="What's your actual CRM budget per month?" sub="Honest number. Include per-seat costs multiplied by your team size." />
            <CheckItem text="Do you need a mobile app or is web-only fine?" sub="Most B2B sales teams are fine with web. Mobile-first = add 2–3 months to any custom build." />
          </ul>
        </Section>

        {/* Section 2: True Cost of Ownership */}
        <Section title="Step 2 — True Cost of Ownership" icon="💰">
          <p className="text-gray-600 mb-6">
            Vendors quote per-seat monthly pricing. The real number is 3–5x that once you add implementation, training, integrations, and annual lock-in. Here's what to actually budget:
          </p>

          <div className="overflow-x-auto rounded-lg border border-gray-200 mb-8">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="py-3 px-4 text-left font-semibold text-gray-900">Option</th>
                  <th className="py-3 px-4 text-left font-semibold text-gray-900">Year 1 Low</th>
                  <th className="py-3 px-4 text-left font-semibold text-gray-900">Year 1 High</th>
                  <th className="py-3 px-4 text-left font-semibold text-gray-900">Notes</th>
                </tr>
              </thead>
              <tbody>
                <CostRow label="Spreadsheets (Google/Excel)" low="$0" high="$0" notes="Works until it doesn't. Breaks at ~50 deals." />
                <CostRow label="The Open CRM" low="$180/yr" high="$936/yr" notes="$15–39/user/mo. No implementation fee. Up in 1 day." />
                <CostRow label="HubSpot Starter" low="$1,200/yr" high="$9,600/yr" notes="$100/user/mo. Add $2k–10k for onboarding if using a partner." />
                <CostRow label="HubSpot Professional" low="$9,600/yr" high="$24,000/yr" notes="$800/mo flat. Required for most automation features." />
                <CostRow label="Salesforce Essentials" low="$3,600/yr" high="$12,000/yr" notes="$25–75/user/mo. Add $5k–20k for implementation." />
                <CostRow label="Salesforce Enterprise" low="$18,000/yr" high="$60,000+/yr" notes="$150/user/mo. Budget $20–100k for a Salesforce partner to set it up." />
                <CostRow label="Custom Build (freelancer)" low="$15,000" high="$60,000" notes="3–9 month timeline. Maintenance ongoing. Often stalls." />
                <CostRow label="Custom Build (agency)" low="$50,000" high="$250,000+" notes="6–18 months. Requires dedicated project manager on your side." />
              </tbody>
            </table>
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-lg p-6">
            <h3 className="font-bold text-amber-900 mb-3">Hidden costs to ask about before signing:</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {[
                'Data migration from your old system',
                'Training for your team',
                'Custom field configuration',
                'Integration setup (email, Slack, billing)',
                'Annual contract vs. month-to-month premium',
                'Support tier (email-only vs. phone)',
                'API access (often gated to higher tiers)',
                'Storage limits and overage fees',
                'Number of automations/workflows allowed',
                'Reporting features (often locked to Enterprise)',
              ].map((item, i) => (
                <p key={i} className="flex gap-2 text-amber-800 text-sm">
                  <span>•</span> {item}
                </p>
              ))}
            </div>
          </div>
        </Section>

        {/* Section 3: Build vs Buy Decision */}
        <Section title="Step 3 — Build vs. Buy Decision Framework" icon="⚖️">
          <p className="text-gray-600 mb-6">
            Custom CRM builds are often pitched as the flexible, scalable choice. They can be — but only in specific situations. Use this framework before saying yes to a custom quote.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
            <div className="bg-green-50 rounded-lg p-6 border border-green-200">
              <h3 className="font-bold text-green-900 mb-4 text-lg">Build makes sense when:</h3>
              <ul className="space-y-2">
                {[
                  'Your sales process is genuinely unique (not just "different than HubSpot defaults")',
                  'You have regulatory/compliance requirements no SaaS can meet',
                  'You need deep integration with proprietary internal systems',
                  'You have an in-house engineering team to maintain it',
                  'You\'ve already tried 2–3 SaaS CRMs and hit hard limits',
                  'The business case shows ROI within 12 months',
                ].map((item, i) => <GreenFlag key={i} text={item} />)}
              </ul>
            </div>

            <div className="bg-red-50 rounded-lg p-6 border border-red-200">
              <h3 className="font-bold text-red-900 mb-4 text-lg">Don't build when:</h3>
              <ul className="space-y-2">
                {[
                  'You haven\'t tried a SaaS CRM yet — you don\'t know your real requirements',
                  'Budget is under $50k — custom builds always run over',
                  'You don\'t have an in-house tech resource to own it',
                  'Timeline is under 6 months — it won\'t be ready',
                  'The "unique" requirement is a field that HubSpot already has',
                  'The proposal doesn\'t include maintenance costs years 2–5',
                ].map((item, i) => <RedFlag key={i} text={item} />)}
              </ul>
            </div>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
            <h3 className="font-bold text-blue-900 mb-2">The lightweight custom build option</h3>
            <p className="text-blue-800">
              There's a middle path: a lightweight, opinionated CRM built on open-source foundations (like The Open CRM) that can be stood up in days, customized to your workflow in weeks, and costs a fraction of a bespoke build.
              This is what most small businesses actually need — not a blank canvas, but a strong starting point that's already 80% right.
            </p>
          </div>
        </Section>

        {/* Section 4: Custom Build Proposal Checklist */}
        <Section title="Step 4 — Evaluating a Custom CRM Proposal" icon="📋">
          <p className="text-gray-600 mb-6">
            If you've received a proposal from a developer or agency to build a custom CRM, run it through this checklist before signing. A professional proposal should address every item here.
          </p>

          <h3 className="font-semibold text-gray-900 mb-3 text-lg">The proposal must include:</h3>
          <ul className="space-y-1 mb-8">
            <CheckItem text="Detailed scope of work with specific features listed (not vague 'CRM features')" />
            <CheckItem text="Technology stack with version numbers (Node 18, React 18, PostgreSQL 14, etc.)" />
            <CheckItem text="Database schema or entity-relationship diagram" sub="If they can't show this, they haven't thought through your data model." />
            <CheckItem text="Milestone payment schedule tied to deliverables, not time" />
            <CheckItem text="Who owns the code and data when the project ends?" sub="Must be you. Never accept vendor lock-in on code they built for you." />
            <CheckItem text="Hosting cost breakdown (separate from build cost)" sub="Cloud hosting typically $50–500/mo depending on scale." />
            <CheckItem text="Maintenance and support plan post-launch" sub="Who fixes bugs after delivery? At what cost?" />
            <CheckItem text="Data migration plan (if moving from existing system)" />
            <CheckItem text="Testing approach: what gets tested and by whom?" />
            <CheckItem text="Timeline with specific go-live date (not just duration estimate)" />
            <CheckItem text="What happens if the project runs over budget or time?" />
            <CheckItem text="References: 2–3 similar projects you can actually call" />
          </ul>

          <h3 className="font-semibold text-red-800 mb-3 text-lg">Red flags in proposals:</h3>
          <ul className="space-y-1 mb-8">
            <RedFlag text="'We'll figure out the exact features as we go' — scope creep guaranteed" />
            <RedFlag text="No fixed price — time-and-materials on a project you don't understand yet" />
            <RedFlag text="They host the app under their account (you can never leave)" />
            <RedFlag text="'We'll use our own framework' — means maintenance requires them forever" />
            <RedFlag text="No mention of testing, QA, or staging environment" />
            <RedFlag text="No prior CRM projects in their portfolio" />
            <RedFlag text="Timeline under 3 months for a full CRM — it won't ship on time" />
            <RedFlag text="Full payment upfront — always pay in milestone installments" />
            <RedFlag text="'We own the IP until final payment' — they can hold your software hostage" />
            <RedFlag text="No written spec — verbal agreements about software always end badly" />
          </ul>

          <h3 className="font-semibold text-gray-900 mb-3 text-lg">Questions to ask before signing:</h3>
          <ul className="space-y-1">
            <CheckItem text="Show me a similar CRM you've built. Can I call that client?" />
            <CheckItem text="What's the most common reason projects like this run over budget?" />
            <CheckItem text="Walk me through exactly how my sales team would use this on day one." />
            <CheckItem text="What happens to my data if we part ways after launch?" />
            <CheckItem text="How do I add a new field or report without hiring you?" />
            <CheckItem text="Who is my point of contact if something breaks on a Friday at 5pm?" />
            <CheckItem text="What does year 2 support cost?" />
            <CheckItem text="Can you show me the staging environment before launch?" />
          </ul>
        </Section>

        {/* Section 5: Evaluation Scorecard */}
        <Section title="Step 5 — Vendor Evaluation Scorecard" icon="📊">
          <p className="text-gray-600 mb-6">
            Score each option 1–5 on the following dimensions. Multiply by the weight. Highest total wins — but any score of 1 on "Data Ownership" or "Security" is a hard disqualifier.
          </p>

          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="py-3 px-4 text-left font-semibold text-gray-900">Dimension</th>
                  <th className="py-3 px-4 text-center font-semibold text-gray-900">Weight</th>
                  <th className="py-3 px-4 text-center font-semibold text-gray-900">Option A</th>
                  <th className="py-3 px-4 text-center font-semibold text-gray-900">Option B</th>
                  <th className="py-3 px-4 text-center font-semibold text-gray-900">Option C</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['Time to go live', '3x', '', '', ''],
                  ['Total year 1 cost', '3x', '', '', ''],
                  ['Fits your sales process', '3x', '', '', ''],
                  ['Data ownership & portability', '2x ⚠', '', '', ''],
                  ['Security & compliance', '2x ⚠', '', '', ''],
                  ['Ease of use for your team', '2x', '', '', ''],
                  ['Integration with existing tools', '2x', '', '', ''],
                  ['Support & documentation quality', '1x', '', '', ''],
                  ['Vendor stability / longevity', '1x', '', '', ''],
                  ['Mobile experience', '1x', '', '', ''],
                  ['TOTAL SCORE', '', '', '', ''],
                ].map(([dim, weight, a, b, c], i) => (
                  <tr key={i} className={`border-b border-gray-100 ${i === 10 ? 'bg-blue-50 font-bold' : ''}`}>
                    <td className="py-3 px-4 text-gray-900">{dim}</td>
                    <td className="py-3 px-4 text-center text-gray-600">{weight}</td>
                    <td className="py-3 px-4 text-center">
                      <span className="inline-block w-12 border-b-2 border-gray-300">&nbsp;</span>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <span className="inline-block w-12 border-b-2 border-gray-300">&nbsp;</span>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <span className="inline-block w-12 border-b-2 border-gray-300">&nbsp;</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-gray-500 text-sm mt-3">Score 1 (terrible) to 5 (excellent). ⚠ = hard disqualifier if scored 1.</p>
        </Section>

        {/* Section 6: The Lightweight Build Option */}
        <Section title="Step 6 — The Lightweight Custom Build Reality Check" icon="⚡">
          <p className="text-gray-600 mb-6">
            One option most people don't consider: starting with a well-built lightweight CRM framework and customizing it for your business. This is what we did with The Open CRM. Here's what's realistic:
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            {[
              {
                label: 'What takes 1 day',
                color: 'green',
                items: [
                  'Deploy the base CRM',
                  'Configure Google OAuth login',
                  'Invite your team',
                  'Start entering contacts & deals',
                ],
              },
              {
                label: 'What takes 1–2 weeks',
                color: 'blue',
                items: [
                  'Custom fields for your workflow',
                  'Tailored pipeline stages',
                  'Connect to your email',
                  'Basic reporting dashboard',
                ],
              },
              {
                label: 'What takes 1–3 months',
                color: 'purple',
                items: [
                  'AI contact enrichment',
                  'Automated activity logging',
                  'Deep integrations (billing, ERP)',
                  'Advanced forecasting',
                ],
              },
            ].map((col, i) => (
              <div key={i} className={`rounded-lg p-6 border-2 ${
                col.color === 'green' ? 'border-green-200 bg-green-50' :
                col.color === 'blue' ? 'border-blue-200 bg-blue-50' :
                'border-purple-200 bg-purple-50'
              }`}>
                <h4 className={`font-bold mb-3 ${
                  col.color === 'green' ? 'text-green-900' :
                  col.color === 'blue' ? 'text-blue-900' :
                  'text-purple-900'
                }`}>{col.label}</h4>
                <ul className="space-y-2">
                  {col.items.map((item, j) => (
                    <li key={j} className="flex gap-2 text-sm text-gray-700">
                      <span>✓</span> {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="bg-gray-900 text-white rounded-lg p-8">
            <h3 className="text-xl font-bold mb-2">Bottom line</h3>
            <p className="text-gray-300 mb-4">
              Most small businesses need 20% of what Salesforce offers. A lightweight CRM built on a solid open-source foundation gets you there in days, not months, at a fraction of the cost.
              The question isn't "build or buy" — it's "what's the right starting point?"
            </p>
            <p className="text-gray-300">
              The Open CRM is that starting point. It ships with contacts, companies, deals, activities, tasks, and pipelines out of the box.
              Customizations — AI enrichment, integrations, advanced reporting — layer on when you're ready.
            </p>
          </div>
        </Section>

        {/* Contact Form */}
        <div id="contact" className="bg-blue-50 rounded-2xl p-8 md:p-12 border border-blue-100">
          <div className="max-w-2xl mx-auto">
            <h2 className="text-3xl font-bold text-gray-900 mb-2 text-center">Talk to Us</h2>
            <p className="text-gray-600 text-center mb-8">
              Have a specific situation? We'll tell you honestly whether our CRM is the right fit — or point you somewhere else.
            </p>

            {submitted ? (
              <div className="text-center py-8">
                <div className="text-5xl mb-4">✅</div>
                <h3 className="text-2xl font-bold text-gray-900 mb-2">Got it!</h3>
                <p className="text-gray-600">We'll get back to you within 24 hours at the email you provided.</p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Your name *</label>
                    <input
                      type="text"
                      required
                      value={formData.name}
                      onChange={e => setFormData({ ...formData, name: e.target.value })}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Jane Smith"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Email address *</label>
                    <input
                      type="email"
                      required
                      value={formData.email}
                      onChange={e => setFormData({ ...formData, email: e.target.value })}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="jane@company.com"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Company</label>
                  <input
                    type="text"
                    value={formData.company}
                    onChange={e => setFormData({ ...formData, company: e.target.value })}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Acme Corp"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">What's your situation? *</label>
                  <textarea
                    required
                    rows={4}
                    value={formData.message}
                    onChange={e => setFormData({ ...formData, message: e.target.value })}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="We're a 15-person team currently using spreadsheets. We're evaluating HubSpot vs. a custom build. Our process is..."
                  />
                </div>
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full py-4 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-lg transition text-lg"
                >
                  {submitting ? 'Sending...' : 'Send Message'}
                </button>
                <p className="text-center text-gray-500 text-sm">
                  No spam. Honest advice only. We respond within 24 hours.
                </p>
              </form>
            )}
          </div>
        </div>

      </div>

      {/* Footer */}
      <footer className="bg-gray-900 text-gray-400 py-8 print:hidden">
        <div className="max-w-5xl mx-auto px-4 text-center">
          <Link to="/" className="text-white font-semibold hover:underline">The Open CRM</Link>
          <span className="mx-3">·</span>
          <Link to="/login" className="hover:text-white">Sign In</Link>
          <span className="mx-3">·</span>
          <a href="mailto:team@theopencrm.com" className="hover:text-white">team@theopencrm.com</a>
          <p className="mt-4 text-sm">&copy; 2026 The Open CRM. Built by developers, for developers.</p>
        </div>
      </footer>
    </div>
  );
}
