// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// PUBLIC PAGE — /crm-for/:slug. One page per starting template in the
// workspace builder (marketing/verticals.js mirrors
// backend/services/onboardingTemplates.js; a backend test keeps the id sets
// equal). Shows the stage flow, fields, follow-up rule and saved view that
// template implies, then the same Build-my-CRM CTA as everywhere else.
// Spec 203, Phase 3. SEO meta per slug is in server.js PUBLIC_META.

import React from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { getVertical, VERTICALS } from '../marketing/verticals';
import { COMPARISONS } from '../marketing/comparisons';
import { usePlatformTemplate } from '../marketing/usePlatformTemplate';
import { MarketingNav, MarketingFooter, CtaPair, TellItDemo, StageFlow, Section, BuildMyCrmButton } from '../components/MarketingShell';

export default function Vertical({ slug: slugProp }) {
  const params = useParams();
  const slug = slugProp || params.slug;
  const v = getVertical(slug);
  // The live starter template for this vertical (null until loaded / if the
  // gallery is unreachable). Hooks run before any early return.
  const live = usePlatformTemplate(v ? v.id : null);
  if (!v) return <Navigate to="/" replace />;

  // Canonical URL uses the hyphenated slug; the raw template id also resolves.
  if (slug !== v.slug) return <Navigate to={`/crm-for/${v.slug}`} replace />;

  const demo = {
    description: v.say,
    pipeline: v.stages.join(', '),
    fields: v.fields.join('; '),
    rule: v.rule,
    view: v.view,
  };

  return (
    <div className="min-h-screen bg-white">
      <MarketingNav />

      <Section className="py-12 sm:py-20">
        <p className="text-sm font-semibold text-brand-blue uppercase tracking-wider mb-3">{v.title}</p>
        <h1 className="text-3xl sm:text-5xl font-bold text-gray-900 leading-tight mb-5 max-w-4xl">{v.headline}</h1>
        <p className="text-lg sm:text-xl text-gray-700 leading-relaxed max-w-3xl mb-8">{v.intro}</p>
        <CtaPair
          templateId={live ? live.id : null}
          note={live
            ? `Starts from the "${live.name}" template on the first screen after signup (no AI needed to draft it), or type it in your own words. You approve everything before it is created.`
            : `Pick "${v.name}" as your starting template after signup, or type it in your own words. You approve everything before it is created.`}
        />
      </Section>

      {live && <LiveTemplateCard tpl={live} />}

      <Section className="bg-gray-50 border-y border-gray-200 py-12 sm:py-16">
        <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-2">The pipeline this template starts from</h2>
        <p className="text-gray-600 mb-6">Stages are per-workspace and editable afterwards. If your process has a step this does not, say so in the description and it is added.</p>
        <StageFlow stages={v.stages} />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-10">
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h3 className="text-base font-semibold text-gray-900 mb-3">Fields it tracks</h3>
            <ul className="space-y-2 text-sm text-gray-700">
              {v.fields.map((f) => (
                <li key={f} className="flex gap-2"><span className="text-brand-blue font-bold">-</span>{f}</li>
              ))}
            </ul>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h3 className="text-base font-semibold text-gray-900 mb-3">The follow-up rule</h3>
            <p className="text-sm text-gray-700 leading-relaxed">{v.rule}</p>
            <p className="text-xs text-gray-500 mt-3">Rules run on a schedule and create a task, send a notification, or flag a deal. Edit or switch them off any time in Settings.</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h3 className="text-base font-semibold text-gray-900 mb-3">The saved view</h3>
            <p className="text-sm text-gray-700 leading-relaxed">{v.view}</p>
            <p className="text-xs text-gray-500 mt-3">One click from the Deals page. Add your own from any filter.</p>
          </div>
        </div>
      </Section>

      <Section className="py-12 sm:py-16">
        <p className="text-sm font-semibold text-brand-blue uppercase tracking-wider mb-2">How setup works here</p>
        <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-3">Tell it how you sell.</h2>
        <p className="text-gray-700 max-w-3xl mb-8 leading-relaxed">
          This is roughly what the "{v.name}" template says, and what comes back. Edit the wording, or write your own from scratch; either way you get a checklist to approve, not a finished configuration you have to undo.
        </p>
        <TellItDemo demo={demo} />
      </Section>

      <Section className="bg-gray-50 border-y border-gray-200 py-12 sm:py-16">
        <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-6">What you get with it</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 text-sm">
          {[
            ['The whole CRM', 'Companies, contacts, leads with capture forms, deals, quotes, tasks, meetings, email sequences, reports and a weighted forecast.'],
            ['After the sale', 'Account 360, renewals, health scores, NPS pulse, support cases, playbooks, and a customer portal you can switch on.'],
            ['A copilot that does the work', 'Ask it what to do today, who has gone dark, or to change a field. Every write is a proposal you confirm.'],
            ['Yours', 'Open source under AGPL-3.0. Hosted from $15 a seat, or self-host for $0. Export everything, any time.'],
          ].map(([t, b]) => (
            <div key={t} className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="font-semibold text-gray-900 mb-2">{t}</h3>
              <p className="text-gray-700 leading-relaxed">{b}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section className="bg-gray-900 text-white py-14 sm:py-20">
        <h2 className="text-2xl sm:text-4xl font-bold mb-4">Start with the {v.name.toLowerCase()} template.</h2>
        <p className="text-gray-300 max-w-2xl mb-8 leading-relaxed">
          Free to start, no card. Describe how you sell on the first screen, approve the setup, and your team is working in it the same afternoon.
        </p>
        <div className="[&_p]:text-gray-400">
          <CtaPair templateId={live ? live.id : null} />
        </div>
      </Section>

      <Section className="py-12">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-3">Other businesses</h2>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
              {VERTICALS.filter((o) => o.id !== v.id).map((o) => (
                <li key={o.id}><Link to={`/crm-for/${o.slug}`} className="text-brand-blue hover:underline">{o.name}</Link></li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-3">Switching from something</h2>
            <ul className="space-y-2 text-sm">
              {COMPARISONS.map((o) => (
                <li key={o.slug}><Link to={o.path} className="text-brand-blue hover:underline">{o.title}</Link></li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <MarketingFooter />
    </div>
  );
}

// The real, seeded starter template — what the visitor actually gets, straight
// from the public gallery. Static copy above stays as the SEO/offline baseline.
function LiveTemplateCard({ tpl }) {
  const stages = Array.isArray(tpl.stages) ? tpl.stages : [];
  const fields = Array.isArray(tpl.field_labels) ? tpl.field_labels : [];
  const uses = Number(tpl.use_count) || 0;
  const rules = Number(tpl.automation_count) || 0;
  const views = Number(tpl.view_count) || 0;
  return (
    <Section className="pb-12 sm:pb-16">
      <div className="rounded-2xl border-2 border-brand-blue/30 bg-brand-blue/5 p-6 sm:p-8" data-testid="live-template">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-brand-blue mb-1">Live starter template</p>
            <h2 className="text-xl sm:text-2xl font-bold text-gray-900">{tpl.name}</h2>
            {tpl.tagline && <p className="text-gray-700 mt-1">{tpl.tagline}</p>}
          </div>
          <div className="shrink-0">
            <BuildMyCrmButton templateId={tpl.id}>Start with this template</BuildMyCrmButton>
          </div>
        </div>
        {stages.length > 0 && (
          <div className="mb-5">
            <div className="text-sm font-semibold text-gray-900 mb-2">{tpl.pipeline_name ? `${tpl.pipeline_name} pipeline` : 'Pipeline'}</div>
            <StageFlow stages={stages} />
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="font-semibold text-gray-900 mb-1">{fields.length} custom field{fields.length === 1 ? '' : 's'}</div>
            <div className="text-gray-700">{fields.length ? fields.join(', ') : 'Uses the standard deal fields.'}</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="font-semibold text-gray-900 mb-1">{rules} follow-up rule{rules === 1 ? '' : 's'}</div>
            <div className="text-gray-700">Each one creates a task or flags a deal on a schedule. Switch off any time.</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="font-semibold text-gray-900 mb-1">{views} saved view{views === 1 ? '' : 's'}</div>
            <div className="text-gray-700">{uses > 0 ? `Used by ${uses} workspace${uses === 1 ? '' : 's'} so far.` : 'One click from the Deals page.'}</div>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-4">
          Applied without an AI call, as a checklist you approve item by item. Every stage, field and rule is editable afterwards.
        </p>
      </div>
    </Section>
  );
}
