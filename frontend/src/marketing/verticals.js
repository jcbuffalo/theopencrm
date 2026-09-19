// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Vertical landing pages, one per starting template in
// backend/services/onboardingTemplates.js (spec 203, Phase 3).
//
// The `id` of every entry MUST equal a template id in that backend file —
// backend/test/marketingVerticals.test.js reads this file as text and asserts
// the two id sets are identical, so adding a template without a page here (or
// the reverse) fails the suite. `slug` is the hyphenated URL form used at
// /crm-for/:slug; the page also resolves the raw id so either spelling works.
//
// The stage flow, fields, rule and view on each page are written BY HAND from
// the template's description. They are what a reasonable planner run produces
// for that template — not a promise of the exact output, which the /setup
// page shows the user for review before anything is applied.
//
// Voice: the way the owner would explain it to a friend in that business.
// Short. No superlatives. No emoji.

export const VERTICALS = [
  {
    id: 'b2b_sales',
    slug: 'b2b-sales',
    name: 'B2B sales team',
    title: 'CRM for B2B sales teams',
    headline: 'A pipeline your reps will actually update.',
    intro:
      'Leads come in from the site, referrals and outbound. A rep qualifies on the first call, sends a proposal, and most deals go a round on price before they close. That is the standard funnel, and the standard six stages fit it. The point here is what sits around the stages: the fields you report on and the nudge when a deal goes quiet.',
    stages: ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'],
    fields: ['Deal amount', 'Expected close date', 'Lead source (website, referral, outbound)'],
    rule: 'No activity on a deal for 14 days: create a follow-up task for the rep who owns it.',
    view: 'Stale deals, sorted by days since the last touch.',
    say: 'We sell to other businesses. Leads come from the website, referrals and outbound. A rep qualifies, sends a proposal, we negotiate, we win or lose. Nudge the rep if a deal sits two weeks.',
  },
  {
    id: 'saas',
    slug: 'saas',
    name: 'SaaS / software',
    title: 'CRM for SaaS and software companies',
    headline: 'Trials, demos, security review, renewal. In that order.',
    intro:
      'Software deals have two stages most CRMs do not ship with: security review and procurement. They are where deals stall, and they are where a follow-up rule earns its keep. After the close, the renewal date is the field that matters for the next twelve months.',
    stages: ['Trial or demo booked', 'Demo done', 'Quote sent', 'Security review', 'Procurement', 'Closed won', 'Closed lost'],
    fields: ['Annual contract value', 'Seat count', 'Plan tier', 'Renewal date'],
    rule: 'In Security review for more than 10 days: create a follow-up task for the owner.',
    view: 'Renewals due in the next 90 days.',
    say: 'Prospects sign up for a trial or book a demo. After the demo we scope seats and send a quote; bigger deals go through security review and procurement. We close on an annual contract and track ACV, seats, plan and renewal date.',
  },
  {
    id: 'professional_services',
    slug: 'professional-services',
    name: 'Consulting / professional services',
    title: 'CRM for consulting and professional services firms',
    headline: 'From intro call to signed SOW, without a spreadsheet on the side.',
    intro:
      'Consulting sales are a conversation, then a discovery call, then a scope and a statement of work with a number on it. The SOW sits with the client for a while. The fields that matter are the engagement value, when it would start, which service line it is, and who referred it, because referrals are most of the pipeline.',
    stages: ['Intro', 'Discovery', 'Scoping', 'SOW sent', 'Negotiation', 'Signed', 'Lost'],
    fields: ['Engagement value', 'Estimated start date', 'Service line', 'Referred by'],
    rule: 'SOW out for 7 days with no answer: create a follow-up task.',
    view: 'SOWs awaiting signature.',
    say: 'We start with an intro conversation, then a discovery call, then write a scope and an SOW with a fee. Clients review, sometimes negotiate scope, then sign. We track engagement value, start date, service line and referrer.',
  },
  {
    id: 'agency',
    slug: 'agency',
    name: 'Marketing / creative agency',
    title: 'CRM for marketing and creative agencies',
    headline: 'Briefs, chemistry calls, pitches, and the retainers that keep the lights on.',
    intro:
      'Agency new business is a brief or an introduction, a chemistry call, and a pitch. What you win is either a project or a monthly retainer, and you need to see those two separately in the pipeline number. Big pitches deserve a flag so the whole team knows.',
    stages: ['Brief received', 'Chemistry call', 'Pitch', 'Negotiation', 'Won', 'Lost'],
    fields: ['Project or retainer', 'Monthly or total value', 'Service (brand, web, paid media, content)', 'Pitch date'],
    rule: 'Deal value over $50,000: mark it hot so it shows at the top of the board.',
    view: 'Pitches this month.',
    say: 'A prospect sends a brief or we get introduced. We run a chemistry call, respond with a pitch, and win a project or a monthly retainer. Track project vs retainer, value, service, and pitch date. Flag anything over $50k.',
  },
  {
    id: 'recruiting',
    slug: 'recruiting',
    name: 'Recruiting / staffing',
    title: 'CRM for recruiting and staffing agencies',
    headline: 'Every open role is a deal. Every stalled shortlist is a reminder.',
    intro:
      'In recruiting the deal is the role, and it moves through sourcing, screening, a shortlist to the client, interviews, an offer, a placement. The client going quiet after a shortlist is the biggest leak in the funnel. The rule below is for exactly that.',
    stages: ['Role opened', 'Sourcing', 'Screening', 'Shortlist submitted', 'Client interviews', 'Offer', 'Placed', 'Lost'],
    fields: ['Placement fee', 'Role title', 'Salary range', 'Contract or permanent'],
    rule: 'Shortlist with the client for 5 days and no feedback: remind the recruiter.',
    view: 'Shortlists awaiting client feedback.',
    say: 'Clients give us open roles. We source, screen, submit a shortlist, run client interviews, extend an offer and place. Track fee, role title, salary range, contract vs perm. Remind me if a shortlist sits 5 days.',
  },
  {
    id: 'real_estate',
    slug: 'commercial-real-estate',
    name: 'Commercial real estate',
    title: 'CRM for commercial real estate brokers',
    headline: 'Inquiry to closing, with due diligence where deals actually go quiet.',
    intro:
      'A commercial deal starts as an inquiry on a listing or a client you represent, and moves through showings, an LOI, the lease or purchase negotiation, due diligence and closing. Due diligence is the long quiet stretch; the check-in rule keeps you in the room.',
    stages: ['Inquiry', 'Showing', 'LOI', 'Negotiation', 'Due diligence', 'Closed', 'Lost'],
    fields: ['Property address', 'Square footage', 'Lease or sale', 'Commission', 'Target close date'],
    rule: 'In Due diligence with no activity for 14 days: create a check-in task.',
    view: 'Deals in due diligence, with days since last activity.',
    say: 'Deals start as an inquiry on a listing or a buyer or tenant we represent. Showings, then LOI, then negotiate the lease or purchase, then due diligence, then closing. Track address, square footage, lease vs sale, commission, target close.',
  },
  {
    id: 'construction',
    slug: 'construction',
    name: 'Construction / contracting',
    title: 'CRM for construction contractors',
    headline: 'Bid invitations in, awards out, and nothing due tomorrow you forgot about.',
    intro:
      'Construction sales is estimating. A bid invitation or a client request comes in, you walk the site, build the estimate, submit, and either win or lose. Awarded jobs go to contract and mobilization. The bid due date is the one field that can cost you a job by itself, so it drives a reminder.',
    stages: ['Bid invited', 'Site visit', 'Estimating', 'Bid submitted', 'Awarded', 'Contract signed', 'Mobilized', 'Lost'],
    fields: ['Bid amount', 'Bid due date', 'Project type (commercial, residential, renovation)', 'GC or owner', 'Site address'],
    rule: 'Bid due date is 3 days out: remind the estimator.',
    view: 'Bids due this week.',
    say: 'Opportunities come in as bid invitations or client requests. We do a site visit, build an estimate, submit a bid, get awarded or lose. Awarded jobs go to contract then mobilization. Remind the estimator 3 days before a bid is due.',
  },
  {
    id: 'distribution',
    slug: 'distribution',
    name: 'Wholesale / distribution',
    title: 'CRM for wholesale distributors',
    headline: 'Open the account, get the first order, then never let it go quiet.',
    intro:
      'In distribution the first order is the beginning, not the end. Accounts come in from reps and trade shows, you qualify, send a price list or quote, get a first order, and then the whole game is reorders. The rule below is the one that pays for the CRM: it tells the rep which accounts stopped ordering.',
    stages: ['New account', 'Qualified', 'Quote or price list sent', 'First order', 'Reordering', 'Lost'],
    fields: ['Estimated annual volume', 'Product category', 'Territory', 'Payment terms'],
    rule: 'No order in 60 days: flag the account for its rep.',
    view: 'Accounts gone quiet, by territory.',
    say: 'New accounts come through reps and trade shows. We qualify, send a price list or quote, take a first order, then work on repeat orders. Track annual volume, product category, territory, payment terms. Flag accounts that have not ordered in 60 days.',
  },
  {
    id: 'equipment_sales',
    slug: 'equipment-sales',
    name: 'Equipment dealer',
    title: 'CRM for equipment dealers',
    headline: 'Demo, quote, financing, delivery. One board for the whole thing.',
    intro:
      'Equipment sales run from an inquiry through a demo, a quote that often carries a financing option, a negotiation on trade-in and terms, and then the part most CRMs forget: delivery and installation. Open quotes are where money sits, so they get the follow-up rule.',
    stages: ['Inquiry', 'Qualified', 'Demo', 'Quote sent', 'Negotiation', 'Closed', 'Delivered', 'Lost'],
    fields: ['Equipment model', 'New or used', 'Quote amount', 'Financing status', 'Delivery date'],
    rule: 'Quote open for more than 10 days: create a follow-up task.',
    view: 'Open quotes, oldest first.',
    say: 'A prospect inquires, we qualify need and budget, schedule a demo, send a quote often with financing, negotiate trade-in and terms, close. Then we schedule delivery and install. Track model, new vs used, quote amount, financing status, delivery date.',
  },
  {
    id: 'manufacturer_rep',
    slug: 'manufacturer-rep',
    name: "Manufacturer's rep",
    title: "CRM for manufacturer's representatives",
    headline: 'RFQ to PO, with the vendor quoting step nobody else models.',
    intro:
      "A rep agency lives on RFQs. Each one gets triaged, priced by the manufacturers you represent, turned into a customer quote, and chased until there is a purchase order or the job is lost. The vendor quoting step is the one generic CRMs do not have, and it is where half the work is. This is the process the product was first built around, so it is well worn.",
    stages: ['RFQ', 'Vendor quoting', 'Customer quote', 'Follow up', 'PO', 'Lost'],
    fields: ['RFQ number', 'Vendor', 'Quote amount', 'Commission rate', 'Requested ship date'],
    rule: 'Customer quote with no response for 7 days: create a follow-up task.',
    view: 'Quotes awaiting customer response.',
    say: 'Customers send us RFQs. We triage, request pricing from the manufacturers we represent, build a customer quote from the vendor quotes, and follow up until we get a PO or lose it. Track RFQ number, vendor, quote amount, commission rate, requested ship date.',
  },
  {
    id: 'field_service',
    slug: 'field-service',
    name: 'Field / technical services',
    title: 'CRM for field and technical service companies',
    headline: 'Survey, propose, approve, schedule, done. And nothing approved sits unscheduled.',
    intro:
      'Field service sales end in a calendar, not a signature. A request comes in, you survey the site, propose a fix or a service contract, get approval, schedule, complete. The gap between approved and scheduled is where customers get annoyed, so the coordinator gets a rule for it.',
    stages: ['Request', 'Site survey', 'Proposal', 'Approved', 'Scheduled', 'Complete', 'Lost'],
    fields: ['Service type', 'Site address', 'Contract value', 'One-off or recurring', 'Scheduled date'],
    rule: 'Approved but not scheduled after 5 days: notify the coordinator.',
    view: 'Approved and unscheduled.',
    say: 'A customer requests service or a quote. We survey the site, propose a fix or a service contract, get approval, schedule the work, complete it. Track service type, site address, contract value, one-off vs recurring, scheduled date.',
  },
  {
    id: 'nonprofit',
    slug: 'nonprofit',
    name: 'Nonprofit / fundraising',
    title: 'CRM for nonprofit fundraising',
    headline: 'Prospects, asks, pledges, gifts. A pipeline for development officers.',
    intro:
      'Fundraising is a sales process that refuses to call itself one. You identify a prospect, cultivate the relationship, make an ask or submit a grant proposal, receive a pledge, and then the gift. Proposals sit with foundations for a long time; the rule below makes sure they do not sit forever.',
    stages: ['Prospect', 'Cultivation', 'Ask or proposal', 'Pledged', 'Gift received', 'Declined'],
    fields: ['Ask amount', 'Gift type (individual, foundation, corporate)', 'Program supported', 'Pledge date'],
    rule: 'Proposal with no response after 30 days: create a follow-up task.',
    view: 'Open asks, by program.',
    say: 'We raise money from donors and foundations. Identify a prospect, cultivate, make an ask or submit a grant proposal, receive a pledge, then the gift. Track ask amount, gift type, program, pledge date. Follow up on proposals after 30 days.',
  },
];

export function getVertical(slugOrId) {
  if (!slugOrId) return null;
  return VERTICALS.find((v) => v.slug === slugOrId || v.id === slugOrId) || null;
}
