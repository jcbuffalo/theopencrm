// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Starting templates for the first-run workspace builder (spec 203, Phase 1).
//
// A template is NOT a stored configuration — it is a pre-written answer to
// "how does your business sell?" that goes through exactly the same planner
// (services/onboardingPlanner.js) as a description the user types. That keeps
// one code path, and it means a template can be edited by appending "…but we
// also X" before submitting. Persisted, cloneable configurations are Phase 2
// (workspace_templates); these are the cheap version that ships first.
//
// Voice: first person, concrete, the way an owner would actually say it. The
// planner is good at turning that into stages/fields/rules; it is bad at
// turning marketing copy into them.

const TEMPLATES = [
  {
    id: 'b2b_sales',
    name: 'B2B sales team',
    tagline: 'Leads, qualification, proposals, a clean close.',
    description:
      'We sell to other businesses. Leads come in from the website, referrals, and outbound. A rep qualifies the lead on a first call, then sends a proposal with pricing. Most deals go through a round of negotiation on price and terms before we win or lose them. We track the deal amount, the expected close date, and where the lead came from. If a deal sits with no activity for two weeks the rep should get a nudge.',
  },
  {
    id: 'saas',
    name: 'SaaS / software',
    tagline: 'Trials, demos, annual contracts, renewals.',
    description:
      'We sell software subscriptions. Prospects sign up for a trial or book a demo. After the demo we scope the seat count and send a quote; larger deals go through security review and procurement. We close on an annual contract and track contract value, seat count, plan tier, and the renewal date. Anything in security review for more than 10 days needs a follow-up task.',
  },
  {
    id: 'professional_services',
    name: 'Consulting / professional services',
    tagline: 'Discovery, scoping, statements of work.',
    description:
      'We are a consulting firm. Work starts with an intro conversation, then a discovery call to understand the problem, then we write a scope and a statement of work with a fee. Clients review the SOW, sometimes negotiate scope, then sign. We track the engagement value, the estimated start date, the service line, and who referred the client. When a SOW has been out for a week with no answer, create a follow-up task.',
  },
  {
    id: 'agency',
    name: 'Marketing / creative agency',
    tagline: 'Briefs, pitches, retainers and projects.',
    description:
      'We are an agency. A prospect sends a brief or we get introduced. We run a chemistry call, respond with a pitch or proposal, and either win a project or a monthly retainer. We track whether it is a project or retainer, the monthly or total value, the service (brand, web, paid media, content), and the pitch date. Flag any deal over $50,000 as hot.',
  },
  {
    id: 'recruiting',
    name: 'Recruiting / staffing',
    tagline: 'Client roles, candidates, placements.',
    description:
      'We are a recruiting agency. Client companies give us open roles. For each role we source candidates, screen them, submit a shortlist to the client, run client interviews, extend an offer, and make a placement. We track the placement fee, the role title, the salary range, and whether it is contract or permanent. If a shortlist has been with a client for 5 days without feedback, remind the recruiter.',
  },
  {
    id: 'real_estate',
    name: 'Commercial real estate',
    tagline: 'Listings, showings, LOIs, closings.',
    description:
      'We broker commercial real estate. A deal starts as an inquiry on a listing or a buyer/tenant we are representing. We do showings, then a letter of intent, then negotiate the lease or purchase agreement, then due diligence, then closing. We track the property address, the square footage, the deal type (lease or sale), the commission, and the target close date. Deals in due diligence with no activity for 14 days need a check-in.',
  },
  {
    id: 'construction',
    name: 'Construction / contracting',
    tagline: 'Bids, estimates, awards, change orders.',
    description:
      'We are a construction contractor. Opportunities come in as bid invitations or client requests. We do a site visit, build an estimate, submit a bid, and either get awarded or lose. Awarded jobs move into contract signing and then mobilization. We track the bid amount, the bid due date, the project type (commercial, residential, renovation), the general contractor or owner, and the site address. Remind the estimator when a bid due date is 3 days out.',
  },
  {
    id: 'distribution',
    name: 'Wholesale / distribution',
    tagline: 'Account opening, quotes, orders, reorders.',
    description:
      'We distribute products to business customers. New accounts come in through reps and trade shows. We qualify the account, send a price list or quote, take a first order, and then work on repeat orders. We track the estimated annual volume, the product category, the territory, and the payment terms. Accounts that have not ordered in 60 days should be flagged for the rep.',
  },
  {
    id: 'equipment_sales',
    name: 'Equipment dealer',
    tagline: 'Demos, quotes, financing, delivery.',
    description:
      'We sell and lease equipment. A prospect inquires, we qualify their need and budget, schedule a demo, send a quote (often with a financing option), negotiate trade-in and terms, and close. After the sale we schedule delivery and installation. We track the equipment model, new versus used, the quote amount, the financing status, and the delivery date. Quotes open for more than 10 days get a follow-up task.',
  },
  {
    id: 'manufacturer_rep',
    name: "Manufacturer's rep",
    tagline: 'RFQs, vendor quotes, customer quotes, POs.',
    description:
      'We are a manufacturer\'s representative. Customers send us RFQs. We triage each one, request pricing from the manufacturers we represent, build a customer quote from the vendor quotes, and follow up until we get a purchase order or lose the job. After the PO we track order acknowledgement, shipment, and invoicing. We track the RFQ number, the vendor, the quote amount, the commission rate, and the requested ship date. Quotes with no customer response for 7 days need a follow-up task.',
  },
  {
    id: 'field_service',
    name: 'Field / technical services',
    tagline: 'Site surveys, proposals, service contracts.',
    description:
      'We provide technical field services. A customer requests service or a quote. We do a site survey or assessment, propose a fix or a service contract, get approval, schedule the work, and complete it. We track the service type, the site address, the contract value, whether it is one-off or recurring, and the scheduled date. Approved work not yet scheduled after 5 days should notify the coordinator.',
  },
  {
    id: 'nonprofit',
    name: 'Nonprofit / fundraising',
    tagline: 'Prospects, asks, pledges, gifts.',
    description:
      'We are a nonprofit raising money from donors and foundations. We identify a prospect, cultivate the relationship, make an ask or submit a grant proposal, receive a pledge, and then the gift. We track the ask amount, the gift type (individual, foundation, corporate), the program it supports, and the pledge date. Any proposal without a response after 30 days needs a follow-up.',
  },
];

function listTemplates() {
  return TEMPLATES.map(({ id, name, tagline }) => ({ id, name, tagline }));
}

function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

module.exports = { TEMPLATES, listTemplates, getTemplate };
