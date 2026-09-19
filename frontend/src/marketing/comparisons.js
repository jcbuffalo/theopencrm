// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Data for the comparison landing pages (spec 203, Phase 3). One component
// (pages/Compare.js) renders all of these; each entry is a route.
//
// Rules for this file:
//   - Every claim in the "us" column must be a green row in
//     PRICING_AND_FEATURES.md. Do not claim SOC 2, on-prem, a marketplace, or
//     AI campaigns — none of those are shipped.
//   - The "them" column is honest, including where they win. A reader who
//     already uses the product will know if we are lying, and that is the
//     reader we most want to convert.
//   - Prices come from ./competitorPrices.js, never typed inline.
//   - Voice: plain, first person where it fits, no superlatives.

import { COMPETITORS, OPEN_CRM_TIERS } from './competitorPrices';

// The workspace-builder demo block shared by all comparison pages. It is the
// same kind of description the /setup builder takes; the four outcomes are the
// four things the planner actually emits (stages, fields, rules, views).
export const SHARED_DEMO = {
  description:
    "We sell to other businesses. Leads come from the website and referrals. A rep qualifies on a first call, sends a proposal, and most deals go through a round on price before we win or lose. We track amount, expected close, and lead source. If a deal sits two weeks with no activity, nudge the rep.",
  pipeline: 'Lead, Qualified, Proposal, Negotiation, Won, Lost',
  fields: 'Expected close date, Lead source (picklist)',
  rule: 'No activity for 14 days: create a follow-up task for the deal owner',
  view: '"Stale deals" saved view, sorted by days since last touch',
};

const US = {
  seatPrice: `$${OPEN_CRM_TIERS.starter.perSeat} Starter / $${OPEN_CRM_TIERS.pro.perSeat} Pro per seat, or $0 self-hosted`,
  contactPricing: 'None on paid tiers. Free tier is capped at 100 contacts; Starter and Pro are uncapped',
  setup: 'Describe how you sell; the builder proposes stages, fields, a rule and a view. You approve, it applies',
  pipelines: 'Editable stages per org, and separate pipelines per deal type',
  customFields: 'Yes, including date fields that can drive automations',
  automation: 'Trigger rules (stage entry, inactivity, N days before or after any date field), plus sandboxed extensions',
  ai: 'Chat copilot with confirm-first actions. Pay-as-you-go metered, or bring your own Anthropic key at no markup',
  source: 'Open source, AGPL-3.0. Fork it, self-host it, take your data with you',
  api: 'Personal access tokens and outbound webhooks',
  sso: 'TOTP 2FA on every tier; OIDC SSO and SCIM exist but are enabled on request, not self-serve',
  import: 'CSV import with HubSpot and Salesforce column presets and stage translation',
};

export const COMPARISONS = [
  {
    slug: 'hubspot',
    path: '/hubspot-alternative',
    competitor: COMPETITORS.hubspot,
    eyebrow: 'HubSpot alternative',
    title: 'HubSpot alternative for teams that just need the CRM',
    headline: "Your CRM shouldn't require a marketing platform.",
    sub: 'HubSpot is a good marketing suite with a CRM attached. If what you actually need is a sales pipeline your team will use, you are paying for the suite and for every contact it stores.',
    metaTitle: 'HubSpot alternative — The Open CRM',
    metaDesc:
      "A HubSpot Sales Hub alternative without contact-tier pricing or onboarding fees. Describe how you sell and the CRM builds your pipeline. $15/seat hosted or $0 self-hosted, open source.",
    pains: [
      {
        title: 'Contact-tier pricing',
        body: 'Marketing Hub bills by contacts stored, and Sales Hub Professional jumps to $100 a seat with a $1,500 onboarding fee before anyone logs in. Your CRM bill grows because your list grew, not because your team did.',
      },
      {
        title: 'Feature bloat you pay to ignore',
        body: 'Sequences, playbooks, forecasting and quotes are gated by tier, so the tier you need for one feature drags along forty you will never open.',
      },
      {
        title: 'Your process, their objects',
        body: 'You can rename deal stages. You cannot easily describe a process that does not look like the default funnel without an admin building it property by property.',
      },
    ],
    table: [
      { feature: 'Per-seat price (annual list)', them: 'Starter $15, Professional $100, Enterprise $150', us: US.seatPrice },
      { feature: 'Pricing by contact count', them: 'Yes on Marketing Hub; Sales Hub has contact caps by tier', us: US.contactPricing },
      { feature: 'Required onboarding fee', them: '$1,500 (Professional), $3,500 (Enterprise)', us: 'None' },
      { feature: 'Getting set up', them: 'Admin configures properties, pipelines and workflows by hand, or pays for onboarding', us: US.setup },
      { feature: 'Multiple pipelines', them: 'Professional and above', us: US.pipelines },
      { feature: 'Automation', them: 'Workflows, Professional and above. Very mature', us: US.automation },
      { feature: 'AI', them: 'Breeze, bundled into higher tiers with credit limits', us: US.ai },
      { feature: 'Marketing automation, landing pages, ads', them: 'Yes, and this is where HubSpot is genuinely strong', us: 'No. Lead capture forms and plain email sequences only. If you need Marketing Hub, keep it' },
      { feature: 'Source code and self-hosting', them: 'Closed, hosted only', us: US.source },
      { feature: 'Switching in', them: 'Standard export', us: US.import },
    ],
    honest: 'If your team leans on HubSpot for marketing automation, landing pages or ad attribution, this is not a replacement for that half. It replaces the Sales Hub half, for people who resent paying suite prices for a pipeline.',
    importFrom: 'HubSpot',
  },
  {
    slug: 'salesforce',
    path: '/salesforce-alternative',
    competitor: COMPETITORS.salesforce,
    eyebrow: 'Salesforce alternative',
    title: 'Salesforce alternative you can change yourself',
    headline: 'Stop hiring consultants to change your CRM.',
    sub: 'Salesforce can model anything, once someone certified has built it. Every change after that is a ticket, a partner, or a week. The Open CRM takes a plain-English description and proposes the change.',
    metaTitle: 'Salesforce alternative — The Open CRM',
    metaDesc:
      'A Salesforce Sales Cloud alternative for 10-100 person teams: describe how you sell and the CRM proposes your pipeline, fields and automations. No consultants, $15/seat hosted or $0 self-hosted.',
    pains: [
      {
        title: 'Implementation is a project',
        body: 'Enterprise is $175 a seat before the partner engagement that actually configures it. For a 20-person team the first year is frequently more implementation than licence.',
      },
      {
        title: 'Changes need an admin',
        body: 'Adding a field, a stage, or a follow-up rule is real work in Setup. Teams stop asking, and the CRM slowly stops matching how they sell.',
      },
      {
        title: 'Locked in by the effort you put in',
        body: 'The more you customize, the harder it is to leave. That is the design.',
      },
    ],
    table: [
      { feature: 'Per-seat price (annual list)', them: 'Starter $25, Pro $100, Enterprise $175, Unlimited $350', us: US.seatPrice },
      { feature: 'Implementation', them: 'Usually a partner engagement, quoted separately', us: US.setup },
      { feature: 'Changing a field, stage or rule', them: 'Admin in Setup, or a partner', us: 'Ask the copilot in chat; it proposes, you approve. Or edit in Settings' },
      { feature: 'Custom objects and depth', them: 'Practically unlimited. Nothing here matches Salesforce for sheer modelling depth', us: 'Custom fields on companies, contacts and deals; pipelines per deal type; line items. Not custom objects' },
      { feature: 'Automation', them: 'Flow. Extremely capable, and a skill to learn', us: US.automation },
      { feature: 'AI', them: 'Agentforce, priced per user or per conversation on top', us: US.ai },
      { feature: 'Reporting', them: 'Deep, and the reason many teams stay', us: 'Dashboards, a custom report builder and weighted forecasting. Good for a sales team, not a BI tool' },
      { feature: 'SSO and provisioning', them: 'Included on Enterprise', us: US.sso },
      { feature: 'Source code and self-hosting', them: 'Closed', us: US.source },
      { feature: 'Switching in', them: 'Report export to CSV', us: US.import },
    ],
    honest: 'If you have a Salesforce admin, custom objects, and a team of hundreds, stay. This is for the 10-100 person team that is paying Salesforce prices for a pipeline nobody dares change.',
    importFrom: 'Salesforce',
  },
  {
    slug: 'pipedrive',
    path: '/pipedrive-alternative',
    competitor: COMPETITORS.pipedrive,
    eyebrow: 'Pipedrive alternative',
    title: 'Pipedrive alternative with more room to grow',
    headline: 'Simple to start. No ceiling when your process gets real.',
    sub: 'Pipedrive got the pipeline right. The trouble starts when you need a second pipeline, a post-sale stage set, account management, or an automation the Advanced tier does not include.',
    metaTitle: 'Pipedrive alternative — The Open CRM',
    metaDesc:
      'A Pipedrive alternative that stays simple but does not stop at the pipeline: multiple pipelines, automation, account management, and an AI copilot that builds your setup from a description. $15/seat or $0 self-hosted.',
    pains: [
      {
        title: 'The add-on bill',
        body: 'LeadBooster, Smart Docs, Campaigns and Projects are each priced on top. The $29 seat is rarely the seat you end up paying for.',
      },
      {
        title: 'It ends at the close',
        body: 'Renewals, account health, support cases and the customer relationship after the deal are somebody else\'s tool.',
      },
      {
        title: 'Automations by tier',
        body: 'The number of automations you can run is a tier limit. Process improvements become billing decisions.',
      },
    ],
    table: [
      { feature: 'Per-seat price (annual list)', them: 'Essential $14, Advanced $29, Professional $59, Power $69', us: US.seatPrice },
      { feature: 'Pipeline UX', them: 'Excellent. Still the benchmark for a clean Kanban', us: 'Kanban board with drag and drop, per-org stages, a pipeline switcher once you have more than one' },
      { feature: 'Getting set up', them: 'Quick by hand; templates by industry', us: US.setup },
      { feature: 'Automation', them: 'Counted per tier, Advanced and above', us: US.automation },
      { feature: 'After the sale', them: 'Not the focus. Projects is a paid add-on', us: 'Accounts 360, renewals, health scores, NPS pulse, cases, playbooks, a customer portal. Included' },
      { feature: 'Email', them: 'Two-way sync on Advanced and above; Campaigns is an add-on', us: 'Sequences and templates included; Gmail and Outlook sync exist but need OAuth configured by the operator' },
      { feature: 'AI', them: 'AI assistant features on higher tiers', us: US.ai },
      { feature: 'Source code and self-hosting', them: 'Closed', us: US.source },
      { feature: 'Free plan', them: 'None, 14-day trial', us: 'Free hosted tier (1 seat, 100 contacts, 10 deals) and free self-host' },
    ],
    honest: 'Pipedrive has a more polished mobile app and a larger integrations marketplace. If you live in the pipeline view and nothing else, it is hard to beat. This is for the team whose process has outgrown one board.',
    importFrom: null,
  },
  {
    slug: 'zoho',
    path: '/zoho-alternative',
    competitor: COMPETITORS.zoho,
    eyebrow: 'Zoho CRM alternative',
    title: 'Zoho CRM alternative that is one tool, not fifty',
    headline: 'Simplicity without the ceiling, and without the suite.',
    sub: 'Zoho CRM is inexpensive and does a great deal. It is also one of forty-plus Zoho apps, and the customization that makes it fit tends to require Deluge scripting or a partner.',
    metaTitle: 'Zoho CRM alternative — The Open CRM',
    metaDesc:
      'A Zoho CRM alternative that configures itself from a description of how you sell. Open source, $15/seat hosted or $0 self-hosted, with an AI copilot and confirm-first automation.',
    pains: [
      {
        title: 'Customization means scripting',
        body: 'Real workflow changes in Zoho often mean Deluge functions, Blueprint design, or a partner. Cheap seats, expensive changes.',
      },
      {
        title: 'The suite pull',
        body: 'Campaigns, Desk, Books, Projects: each is another app, another login, another line item. The CRM is the door into the suite.',
      },
      {
        title: 'Your data, their format',
        body: 'You can export. You cannot take the software with you.',
      },
    ],
    table: [
      { feature: 'Per-seat price (annual list)', them: 'Standard $14, Professional $23, Enterprise $40, Ultimate $52', us: US.seatPrice },
      { feature: 'Free plan', them: 'Yes, up to 3 users', us: 'Free hosted tier (1 seat, 100 contacts, 10 deals) and free self-host' },
      { feature: 'Getting set up', them: 'By hand in Setup; Blueprint for process design', us: US.setup },
      { feature: 'Customization', them: 'Very deep. Deluge scripting for anything non-trivial', us: 'Custom fields, pipelines per deal type, trigger rules, and sandboxed extensions written from a plain-English description, all confirm-first' },
      { feature: 'Automation', them: 'Workflow rules, Blueprint, and scripting', us: US.automation },
      { feature: 'AI', them: 'Zia, included on higher tiers', us: US.ai },
      { feature: 'Breadth', them: 'Enormous, across the Zoho suite', us: 'A full-lifecycle CRM: sales, account management, support cases, quotes, reports. Not accounting, not projects' },
      { feature: 'Source code and self-hosting', them: 'Closed', us: US.source },
      { feature: 'API and webhooks', them: 'Yes, mature', us: US.api },
    ],
    honest: 'Zoho is cheaper at the low end and its suite is real. If you already run Zoho Books and Desk, the integration is worth a lot. This is for the team that wants one CRM they can change without a scripting language.',
    importFrom: null,
  },
  {
    slug: 'spreadsheet',
    path: '/spreadsheet-crm',
    competitor: COMPETITORS.spreadsheet,
    eyebrow: 'Spreadsheet to CRM',
    title: 'Turn your spreadsheet into a real CRM',
    headline: 'Turn your spreadsheet into a real CRM.',
    sub: 'The spreadsheet works because it matches exactly how you sell. Most CRMs fail because they do not. Describe the columns and the tabs you have now, and the builder proposes the same thing as a pipeline with fields and follow-ups.',
    metaTitle: 'Spreadsheet CRM: move from Google Sheets or Excel — The Open CRM',
    metaDesc:
      'Running sales from a spreadsheet? Describe your columns and tabs and The Open CRM builds the matching pipeline, fields and follow-up rules. Import the sheet as CSV. Free to start, open source.',
    pains: [
      {
        title: 'It only works for one person',
        body: 'The moment two people edit it, rows go missing, and nobody knows who last talked to the customer.',
      },
      {
        title: 'Nothing reminds you',
        body: 'A spreadsheet does not notice a deal has sat untouched for three weeks. You notice at the end of the quarter.',
      },
      {
        title: 'Every CRM you tried made you adapt',
        body: 'You have columns the CRM did not have and stages it did not allow. So you went back to the sheet.',
      },
    ],
    table: [
      { feature: 'Cost', them: '$0, plus the hours someone spends maintaining it', us: US.seatPrice },
      { feature: 'Matches how you actually sell', them: 'Perfectly, because you built it', us: US.setup },
      { feature: 'Your custom columns', them: 'Any column you like', us: US.customFields },
      { feature: 'Reminders and follow-ups', them: 'None, unless you script them', us: US.automation },
      { feature: 'Multiple people', them: 'Shared editing, no history, no ownership', us: 'Owners on companies and deals, an activity timeline, an append-only audit log' },
      { feature: 'Reporting', them: 'Pivot tables you rebuild each month', us: 'Dashboards, a report builder and a weighted forecast, live' },
      { feature: 'Getting your data in', them: 'It is already there', us: 'Import the sheet as CSV; columns map to fields, stage names translate onto your pipeline' },
      { feature: 'Getting your data out', them: 'Trivial', us: 'CSV export and a self-service full data export, any time' },
      { feature: 'Free', them: 'Yes', us: 'Free hosted tier (1 seat, 100 contacts, 10 deals) and free self-host' },
    ],
    honest: 'If you are one person with thirty deals, the spreadsheet may honestly be fine. Switch when a second person needs it, or when you missed a follow-up that cost you.',
    importFrom: null,
  },
  {
    slug: 'custom',
    path: '/custom-crm-alternative',
    competitor: COMPETITORS.custom,
    eyebrow: 'Custom CRM alternative',
    title: 'Custom CRM without building a custom CRM',
    headline: 'Get the custom CRM without building the custom CRM.',
    sub: 'You looked at building your own because nothing off the shelf fit your process. That instinct is right. Building and maintaining it is the part that goes wrong. Describe the process; the builder proposes the fit, on a codebase you can also read and fork.',
    metaTitle: 'Custom CRM alternative — The Open CRM',
    metaDesc:
      'Thinking about building your own CRM? The Open CRM configures itself from a description of your process and is open source (AGPL-3.0) if you ever need to go further. $15/seat hosted or $0 self-hosted.',
    pains: [
      {
        title: 'The first version is the cheap part',
        body: 'Auth, permissions, audit logs, import, export, email, mobile: the CRM you scoped is a quarter of the CRM you need.',
      },
      {
        title: 'Maintenance never ends',
        body: 'The developer who built it moves on. Every new field is a deploy. The business keeps changing and the software stops.',
      },
      {
        title: 'You wanted fit, not ownership of a codebase',
        body: 'Custom was a means to a process that matches. There is a shorter path to the same fit.',
      },
    ],
    table: [
      { feature: 'Cost', them: 'Developer time to build, then developer time to change, indefinitely', us: US.seatPrice },
      { feature: 'Fit to your process', them: 'Exact, at the moment it ships', us: US.setup },
      { feature: 'Changing it later', them: 'A ticket and a deploy', us: 'Ask the copilot or edit in Settings. Stages, fields, rules and views are all per-org configuration' },
      { feature: 'What you get on day one', them: 'What you scoped', us: 'Companies, contacts, leads, deals, quotes, tasks, meetings, sequences, reports, account management, cases, portal, import, export, 2FA, audit log' },
      { feature: 'Extending it with code', them: 'Of course, it is yours', us: 'Sandboxed extensions run confirm-first inside the app; and the whole codebase is AGPL-3.0 if you need to fork' },
      { feature: 'Owning the code', them: 'Yes', us: US.source },
      { feature: 'Security basics', them: 'Yours to build and keep patched', us: 'httpOnly session cookies, CSRF, rate limits, TOTP 2FA, append-only audit log, GDPR export and deletion. Not SOC 2 certified' },
      { feature: 'Hosting', them: 'Yours', us: 'Hosted from $15 a seat, or run it yourself for $0' },
    ],
    honest: 'If your process genuinely needs custom objects and screens no CRM has, you may still need to build. Start here anyway: the fork is free and you will know exactly what is missing before you write a line.',
    importFrom: null,
  },
];

export function getComparison(slug) {
  return COMPARISONS.find((c) => c.slug === slug) || null;
}
