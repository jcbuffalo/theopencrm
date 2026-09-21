// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Shared chrome for the public marketing pages (Compare, Vertical): a nav,
// a footer that cross-links every comparison + vertical page (internal
// linking is most of the SEO here), and the two blocks every page ends in —
// the "Tell it how you sell" demo and the Build-my-CRM CTA pair.
//
// Mobile-first: 16px gutters (px-4), CTAs are min-h-[44px], tables scroll
// inside their own wrapper so the page never scrolls sideways at 375px. No
// emoji anywhere in this chrome (design-system smoke test enforces it).

import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Icon from './ui/Icon';
import { COMPARISONS } from '../marketing/comparisons';
import { VERTICALS } from '../marketing/verticals';
import { rememberSetupIntent, SIGNUP_PATH, GITHUB_URL } from '../marketing/cta';

const CTA_BASE =
  'inline-flex items-center justify-center gap-2 min-h-[44px] px-6 py-3 rounded-lg text-base font-semibold transition-colors ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:ring-offset-2';

// Primary CTA. Stores the /setup intent, then goes to signup. A plain
// <button>, not a <Link>, because we need the side effect before navigation.
// `templateId`: a platform workspace template (from /api/public/workspace-
// templates) to pre-load on /setup after signup — the /crm-for pages pass
// the live one for their vertical.
export function BuildMyCrmButton({ className = '', size = 'lg', children = 'Build my CRM', templateId = null }) {
  const navigate = useNavigate();
  const sizeCls = size === 'sm' ? 'min-h-[44px] px-4 py-2 text-sm' : '';
  return (
    <button
      type="button"
      onClick={() => {
        rememberSetupIntent({ templateId });
        navigate(SIGNUP_PATH);
      }}
      className={`${CTA_BASE} ${sizeCls} bg-brand-blue hover:bg-brand-blue-dark text-white ${className}`}
    >
      {children}
      <Icon name="arrow-right" size={18} />
    </button>
  );
}

export function GitHubButton({ className = '' }) {
  return (
    <a
      href={GITHUB_URL}
      target="_blank"
      rel="noreferrer"
      className={`${CTA_BASE} border-2 border-gray-300 text-gray-900 hover:bg-gray-50 ${className}`}
    >
      Read the source on GitHub
      <Icon name="external" size={16} />
    </a>
  );
}

export function CtaPair({ note, templateId = null }) {
  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-3">
        <BuildMyCrmButton templateId={templateId} />
        <GitHubButton />
      </div>
      <p className="text-sm text-gray-600 mt-3">
        {note || 'Free to start, no card. You describe how you sell on the first screen; the CRM proposes the setup; you approve it.'}
      </p>
    </div>
  );
}

export function MarketingNav() {
  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-40">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex justify-between items-center gap-3">
        <Link to="/" className="text-lg sm:text-xl font-bold text-brand-blue whitespace-nowrap">The Open CRM</Link>
        {/* Below sm only the logo + primary CTA fit at 375px; Sign in, Pricing
            and GitHub are repeated in the footer. */}
        <div className="flex gap-3 sm:gap-5 items-center text-sm">
          <Link to="/#pricing" className="hidden md:inline-flex text-gray-600 hover:text-gray-900 py-2">Pricing</Link>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="hidden md:inline-flex text-gray-600 hover:text-gray-900 py-2">GitHub</a>
          <Link to="/login" className="hidden sm:inline-flex items-center text-gray-600 hover:text-gray-900 py-2 min-h-[44px]">Sign in</Link>
          <BuildMyCrmButton size="sm" />
        </div>
      </div>
    </nav>
  );
}

export function MarketingFooter() {
  return (
    <footer className="bg-gray-900 text-gray-400 py-12">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 grid grid-cols-1 sm:grid-cols-3 gap-8 text-sm">
        <div>
          <div className="text-white font-semibold mb-3">Compare</div>
          <ul className="space-y-2">
            {COMPARISONS.map((c) => (
              <li key={c.slug}>
                <Link to={c.path} className="hover:text-white">{c.eyebrow}</Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="text-white font-semibold mb-3">Built for how you sell</div>
          <ul className="space-y-2 columns-1 sm:columns-2">
            {VERTICALS.map((v) => (
              <li key={v.id} className="break-inside-avoid">
                <Link to={`/crm-for/${v.slug}`} className="hover:text-white">{v.name}</Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="text-white font-semibold mb-3">The Open CRM</div>
          <ul className="space-y-2">
            <li><Link to="/" className="hover:text-white">Home</Link></li>
            <li><Link to="/login" className="hover:text-white">Sign in</Link></li>
            <li><Link to="/#pricing" className="hover:text-white">Pricing</Link></li>
            <li><a href={GITHUB_URL} target="_blank" rel="noreferrer" className="hover:text-white">Source on GitHub (AGPL-3.0)</a></li>
            <li><Link to="/launch" className="hover:text-white">Launch post</Link></li>
            <li><Link to="/privacy" className="hover:text-white">Privacy</Link></li>
            <li><Link to="/terms" className="hover:text-white">Terms</Link></li>
          </ul>
          <p className="mt-6 text-xs text-gray-500">
            Competitor prices are published list prices on annual billing and are checked periodically; see the footnote on each comparison page for the date.
          </p>
        </div>
      </div>
    </footer>
  );
}

// The static "Tell it how you sell" demo: one description in, four things
// out. `demo` = { description, pipeline, fields, rule, view }.
export function TellItDemo({ demo, compact = false }) {
  const outcomes = [
    ['Pipeline', demo.pipeline],
    ['Fields', demo.fields],
    ['Follow-up rule', demo.rule],
    ['Saved view', demo.view],
  ];
  return (
    <div className={`grid grid-cols-1 ${compact ? '' : 'lg:grid-cols-2'} gap-6 items-start`}>
      <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
        <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">You type</div>
        <p className="text-gray-800 leading-relaxed italic">"{demo.description}"</p>
      </div>
      <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
        <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">It proposes, you approve</div>
        <ul className="space-y-3">
          {outcomes.map(([label, value]) => (
            <li key={label} className="flex gap-3 items-start">
              <span className="mt-0.5 shrink-0 inline-flex h-5 w-5 items-center justify-center rounded-full bg-green-100 text-green-700">
                <Icon name="check" size={14} />
              </span>
              <div>
                <div className="text-sm font-semibold text-gray-900">{label}</div>
                <div className="text-sm text-gray-700">{value}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// Horizontal stage flow that wraps on phones instead of scrolling.
export function StageFlow({ stages }) {
  return (
    <ol className="flex flex-wrap gap-2 items-center" aria-label="Pipeline stages">
      {stages.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <span className="inline-block px-3 py-1.5 rounded-full bg-brand-blue/10 text-brand-blue text-sm font-medium">{s}</span>
          {i < stages.length - 1 && <Icon name="chevron-right" size={14} className="text-gray-400" />}
        </li>
      ))}
    </ol>
  );
}

// Page section wrapper with the shared 16px gutter.
export function Section({ className = '', children, id }) {
  return (
    <section id={id} className={className}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">{children}</div>
    </section>
  );
}
