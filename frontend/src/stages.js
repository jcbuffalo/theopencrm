// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Stage definitions, keyed by org profile.
//
// `generic` — vanilla CRM pipeline. Default for all new orgs.
// `zang`    — manufacturer's-rep workflow per the Zang Hitch contract Exhibit A.
// `jcp`     — John Coles Projects: personal-project sales funnel for dogfooding
//             new features against real (sales-facing) opportunities.
//
// Stage-ID casing follows the backend `VALID_STAGES` enum in
// `backend/utils/dealStages.js`. Zang IDs are uppercase (Exhibit A canonical);
// generic IDs are lowercase to match what's already stored in `deals.stage`
// for non-Zang orgs (see PR #10 — backend-side fix; this file is the
// frontend-side counterpart). Dragging a card on the Kanban posts `stage.id`
// straight to PATCH /api/deals/:id/stage, so these IDs MUST round-trip
// against the backend enum exactly.
//
// The Deals page picks the appropriate config based on me.org_profile.
//
// PER-ORG EDITABLE STAGES (migration 155): `/auth/me` also returns
// `org_pipeline` — the org's EFFECTIVE pipeline from the backend
// (services/pipelines.js). When it is CUSTOM (`is_custom: true`) the stages,
// labels, colors, phases, and terminal ids below come from it instead of the
// hardcoded profile set; when it isn't, everything is byte-for-byte what it
// was, so nothing changes for an org that never edited its stages.
// AuthContext registers the current pipelines here (setCurrentOrgPipelines,
// keyed by deal_type since spec 201 — 'default' is the main pipeline) so
// every existing `getStageConfig(profile)` caller resolves it without
// threading a second argument through the app; pass `{ dealType }` to
// resolve another pipeline of the org.

import {
  PRE_SALE_STAGES, POST_SALE_STAGES, POST_SHIP_STAGES, PHASES as ZANG_PHASES,
  STAGE_LABEL as ZANG_STAGE_LABEL, stageColors as zangStageColors, urgencyColor,
} from './zangStages';

const GENERIC_STAGES = [
  { id: 'lead',         label: 'Lead',         desc: 'New opportunity' },
  { id: 'qualified',    label: 'Qualified',    desc: 'Worth pursuing' },
  { id: 'proposal',     label: 'Proposal',     desc: 'Quote / proposal sent' },
  { id: 'negotiation',  label: 'Negotiation',  desc: 'Active back-and-forth' },
  { id: 'closed_won',   label: 'Closed Won',   desc: 'Won the deal' },
  { id: 'closed_lost',  label: 'Closed Lost',  desc: 'Did not win' },
];

const GENERIC_COLORS = {
  lead:         { bg: 'bg-slate-50',   header: 'bg-slate-100',   border: 'border-slate-200'   },
  qualified:    { bg: 'bg-blue-50',    header: 'bg-blue-100',    border: 'border-blue-200'    },
  proposal:     { bg: 'bg-cyan-50',    header: 'bg-cyan-100',    border: 'border-cyan-200'    },
  negotiation:  { bg: 'bg-yellow-50',  header: 'bg-yellow-100',  border: 'border-yellow-200'  },
  closed_won:   { bg: 'bg-green-50',   header: 'bg-green-100',   border: 'border-green-200'   },
  closed_lost:  { bg: 'bg-red-50',     header: 'bg-red-100',     border: 'border-red-200'     },
};

const GENERIC_LABELS = {};
GENERIC_STAGES.forEach(s => { GENERIC_LABELS[s.id] = s.label; });

function genericStageColors(id) {
  return GENERIC_COLORS[id] || { bg: 'bg-gray-50', header: 'bg-gray-100', border: 'border-gray-200' };
}

const GENERIC_PHASES = [
  { id: 'pipeline', label: 'Pipeline', stages: GENERIC_STAGES },
];

// ---------------------------------------------------------------------------
// `jcp` — John Coles Projects. A personal sales funnel: people I'm pulling
// into one of my own projects (consulting, side ventures, open-source
// collaborations). Keeps the canonical CLOSED_WON / CLOSED_LOST terminal IDs
// so the existing reports/funnel metrics keep working unchanged.
// ---------------------------------------------------------------------------

const JCP_STAGES = [
  { id: 'LEAD',         label: 'Lead',         desc: 'Heard about me / I heard about them' },
  { id: 'INTRO',        label: 'Intro',        desc: 'First conversation' },
  { id: 'SCOPING',      label: 'Scoping',      desc: 'Defining the project + fit' },
  { id: 'PITCH',        label: 'Pitch',        desc: 'Proposal / scope sent' },
  { id: 'ENGAGED',      label: 'Engaged',      desc: 'Verbal yes, work starting' },
  { id: 'CLOSED_WON',   label: 'Delivered',    desc: 'Project landed / live' },
  { id: 'CLOSED_LOST',  label: 'Parked / No',  desc: 'Not now or not a fit' },
];

const JCP_COLORS = {
  LEAD:        { bg: 'bg-slate-50',   header: 'bg-slate-100',   border: 'border-slate-200'   },
  INTRO:       { bg: 'bg-indigo-50',  header: 'bg-indigo-100',  border: 'border-indigo-200'  },
  SCOPING:     { bg: 'bg-cyan-50',    header: 'bg-cyan-100',    border: 'border-cyan-200'    },
  PITCH:       { bg: 'bg-amber-50',   header: 'bg-amber-100',   border: 'border-amber-200'   },
  ENGAGED:     { bg: 'bg-violet-50',  header: 'bg-violet-100',  border: 'border-violet-200'  },
  CLOSED_WON:  { bg: 'bg-emerald-50', header: 'bg-emerald-100', border: 'border-emerald-200' },
  CLOSED_LOST: { bg: 'bg-rose-50',    header: 'bg-rose-100',    border: 'border-rose-200'    },
};

const JCP_LABELS = {};
JCP_STAGES.forEach(s => { JCP_LABELS[s.id] = s.label; });

function jcpStageColors(id) {
  return JCP_COLORS[id] || { bg: 'bg-gray-50', header: 'bg-gray-100', border: 'border-gray-200' };
}

const JCP_PHASES = [
  { id: 'funnel', label: 'Funnel', stages: JCP_STAGES },
];

// Canonical list of white-label profiles. This is the single source of truth
// for "which profiles exist" — admin <select>s, provisioning, and any other
// place that needs to enumerate profiles should consume this instead of
// hardcoding a local array (which is how `rin` kept getting dropped).
export const KNOWN_PROFILES = [
  { id: 'generic', label: 'Generic',                    description: '6-stage sales pipeline. Default for new customers.' },
  { id: 'zang',    label: "Zang (Manufacturer's Rep)",  description: '29-stage RFQ → Quote → PO → Invoice lifecycle with vendor management, submittals, change orders, post-shipment service contracts.' },
  { id: 'jcp',     label: 'John Coles Projects',        description: '7-stage personal-project funnel (Lead → Intro → Scoping → Pitch → Engaged → Delivered/Parked) for dogfooding.' },
  { id: 'rin',     label: 'RIN (Rural Inspector Network)', description: 'Dealer-account management + inspector-recruiting funnel. Runs the post-sale account-management motion on the generic pipeline.' },
];

// ---------------------------------------------------------------------------
// Tone palette for custom stages. Literal class strings (Tailwind's scanner
// needs to see them) — keep in sync with backend services/pipelines.TONES.
// ---------------------------------------------------------------------------
export const TONES = ['slate', 'gray', 'stone', 'red', 'orange', 'amber', 'yellow', 'emerald', 'green', 'cyan', 'blue', 'indigo', 'violet', 'purple', 'rose'];

const TONE_CLASSES = {
  slate:   { bg: 'bg-slate-50',   header: 'bg-slate-100',   border: 'border-slate-200',   swatch: 'bg-slate-400'   },
  gray:    { bg: 'bg-gray-50',    header: 'bg-gray-100',    border: 'border-gray-200',    swatch: 'bg-gray-400'    },
  stone:   { bg: 'bg-stone-50',   header: 'bg-stone-100',   border: 'border-stone-200',   swatch: 'bg-stone-400'   },
  red:     { bg: 'bg-red-50',     header: 'bg-red-100',     border: 'border-red-200',     swatch: 'bg-red-400'     },
  orange:  { bg: 'bg-orange-50',  header: 'bg-orange-100',  border: 'border-orange-200',  swatch: 'bg-orange-400'  },
  amber:   { bg: 'bg-amber-50',   header: 'bg-amber-100',   border: 'border-amber-200',   swatch: 'bg-amber-400'   },
  yellow:  { bg: 'bg-yellow-50',  header: 'bg-yellow-100',  border: 'border-yellow-200',  swatch: 'bg-yellow-400'  },
  emerald: { bg: 'bg-emerald-50', header: 'bg-emerald-100', border: 'border-emerald-200', swatch: 'bg-emerald-400' },
  green:   { bg: 'bg-green-50',   header: 'bg-green-100',   border: 'border-green-200',   swatch: 'bg-green-400'   },
  cyan:    { bg: 'bg-cyan-50',    header: 'bg-cyan-100',    border: 'border-cyan-200',    swatch: 'bg-cyan-400'    },
  blue:    { bg: 'bg-blue-50',    header: 'bg-blue-100',    border: 'border-blue-200',    swatch: 'bg-blue-400'    },
  indigo:  { bg: 'bg-indigo-50',  header: 'bg-indigo-100',  border: 'border-indigo-200',  swatch: 'bg-indigo-400'  },
  violet:  { bg: 'bg-violet-50',  header: 'bg-violet-100',  border: 'border-violet-200',  swatch: 'bg-violet-400'  },
  purple:  { bg: 'bg-purple-50',  header: 'bg-purple-100',  border: 'border-purple-200',  swatch: 'bg-purple-400'  },
  rose:    { bg: 'bg-rose-50',    header: 'bg-rose-100',    border: 'border-rose-200',    swatch: 'bg-rose-400'    },
};

export function toneClasses(tone) {
  return TONE_CLASSES[tone] || TONE_CLASSES.gray;
}

const PHASE_LABELS = { pre_sale: 'Pre-Sale', post_sale: 'Post-Sale', post_ship: 'Post-Shipment', pipeline: 'Pipeline', funnel: 'Funnel' };

// The org's effective pipelines, registered by AuthContext after /auth/me —
// a map keyed by deal_type (spec 201; 'default' is the main pipeline). Only
// CUSTOM pipelines are kept — a profile default is rendered from the
// hardcoded sets above, exactly as before. Legacy setCurrentOrgPipeline
// still works and sets just the default entry.
let currentOrgPipelines = {};

export function setCurrentOrgPipeline(pipeline) {
  // null = "no org pipeline" (sign-out / fetch failure) — clears everything.
  if (!pipeline) setCurrentOrgPipelines(null);
  else setCurrentOrgPipelines({ ...currentOrgPipelines, default: pipeline });
}

// `pipelines` is { dealType: pipeline } (e.g. /auth/me org_pipelines).
// Falsy clears the registry.
export function setCurrentOrgPipelines(pipelines) {
  const next = {};
  Object.entries(pipelines || {}).forEach(([dealType, p]) => {
    if (isCustomPipeline(p)) next[dealType] = p;
  });
  currentOrgPipelines = next;
}

export function getCurrentOrgPipeline(dealType = 'default') {
  return currentOrgPipelines[dealType] || null;
}

export function getCurrentOrgPipelines() {
  return currentOrgPipelines;
}

export function isCustomPipeline(pipeline) {
  return !!(pipeline && pipeline.is_custom && Array.isArray(pipeline.stages) && pipeline.stages.length > 0);
}

// Build a config from a custom pipeline on top of the profile's base config
// (feature toggles like showAdvancedPanels stay profile-driven).
function applyPipeline(base, pipeline) {
  const stages = pipeline.stages.map(st => ({
    id: st.id,
    label: st.label,
    desc: st.desc || '',
    tone: st.tone || 'gray',
    is_won: !!st.is_won,
    is_lost: !!st.is_lost,
  }));
  const byId = {};
  stages.forEach(st => { byId[st.id] = st; });

  let phases;
  if (Array.isArray(pipeline.phases) && pipeline.phases.length) {
    phases = pipeline.phases.map(ph => ({
      id: ph.id,
      label: ph.label || PHASE_LABELS[ph.id] || ph.id,
      stages: (ph.stage_ids || []).map(id => byId[id]).filter(Boolean),
    })).filter(ph => ph.stages.length > 0);
  }
  if (!phases || !phases.length) {
    const id = base.profile === 'jcp' ? 'funnel' : 'pipeline';
    phases = [{ id, label: PHASE_LABELS[id], stages }];
  }

  return {
    ...base,
    phases,
    allStages: stages,
    stageLabel: id => (byId[id] ? byId[id].label : id),
    stageColors: id => toneClasses(byId[id] ? byId[id].tone : null),
    terminalStageIds: stages.filter(st => st.is_won || st.is_lost).map(st => st.id),
    defaultStage: stages[0].id,
    isCustomPipeline: true,
    pipelineName: pipeline.name || null,
  };
}

/**
 * Returns the workflow config for a given profile, merged with the org's
 * custom pipeline when it has one. The second argument accepts every
 * historical form plus a deal_type selector (spec 201):
 *
 *   getStageConfig(profile)                   — the registered DEFAULT pipeline
 *   getStageConfig(profile, null)             — force the profile default
 *   getStageConfig(profile, pipelineObject)   — use that pipeline explicitly
 *   getStageConfig(profile, { dealType })     — the registered pipeline for
 *     that deal type, falling back to the registered default (mirrors the
 *     backend type-row → default-row → profile-default chain)
 *
 *   {
 *     profile,
 *     phases:   [{ id, label, stages: [...] }],
 *     stageLabel(id),
 *     stageColors(id),
 *     showAdvancedPanels,    // submittals, change orders, vendor RFQ comparison
 *     showOrderDetails,      // PO #, ship-to, POC, target ship
 *     showAccountManagement, // CS post-sale surfaces: Accounts (360) + Renewals
 *     terminalStageIds,      // stages a deal is "done" in — no more expected
 *                            //   activity; used to exclude closed deals from
 *                            //   the overdue filter (case-sensitive, matches
 *                            //   deals.stage exactly).
 *     isCustomPipeline,      // true when the org edited its stages
 *   }
 */
export function getStageConfig(profile, orgPipeline = undefined) {
  const base = baseStageConfig(profile);
  let pipeline;
  if (orgPipeline === undefined) {
    pipeline = getCurrentOrgPipeline();
  } else if (orgPipeline && !Array.isArray(orgPipeline.stages) && 'dealType' in orgPipeline) {
    pipeline = getCurrentOrgPipeline(orgPipeline.dealType || 'default') || getCurrentOrgPipeline();
  } else {
    pipeline = orgPipeline;
  }
  if (isCustomPipeline(pipeline)) return applyPipeline(base, pipeline);
  return base;
}

function baseStageConfig(profile) {
  if (profile === 'zang') {
    return {
      profile: 'zang',
      phases: ZANG_PHASES,
      allStages: [...PRE_SALE_STAGES, ...POST_SALE_STAGES, ...POST_SHIP_STAGES],
      stageLabel: id => ZANG_STAGE_LABEL[id] || id,
      stageColors: zangStageColors,
      showAdvancedPanels: true,
      showOrderDetails: true,
      showAccountManagement: true,
      terminalStageIds: ['INVOICED', 'CLOSED_PAID', 'CLOSED', 'LOST', 'CANCELLED'],
      defaultStage: 'TRIAGE',
      brandSubtitle: 'Manufacturer\'s-Rep Edition',
    };
  }
  if (profile === 'jcp') {
    return {
      profile: 'jcp',
      phases: JCP_PHASES,
      allStages: JCP_STAGES,
      stageLabel: id => JCP_LABELS[id] || id,
      stageColors: jcpStageColors,
      showAdvancedPanels: false,
      showOrderDetails: false,
      showAccountManagement: false,
      terminalStageIds: ['CLOSED_WON', 'CLOSED_LOST'],
      defaultStage: 'LEAD',
      brandSubtitle: 'John Coles Projects',
    };
  }
  // `rin` (Rural Inspector Network) — spec only today, but it runs the same
  // post-sale account-management motion as `zang`, so it opts into the CS
  // surfaces. Falls through to the generic pipeline config otherwise.
  if (profile === 'rin') {
    return {
      profile: 'rin',
      phases: GENERIC_PHASES,
      allStages: GENERIC_STAGES,
      stageLabel: id => GENERIC_LABELS[id] || id,
      stageColors: genericStageColors,
      showAdvancedPanels: false,
      showOrderDetails: false,
      showAccountManagement: true,
      terminalStageIds: ['closed_won', 'closed_lost'],
      // Generic stage ids are lowercase — 'LEAD' here would post an invalid
      // stage on deal create for rin orgs (backend enum is case-sensitive).
      defaultStage: 'lead',
      brandSubtitle: null,
    };
  }
  return {
    profile: 'generic',
    phases: GENERIC_PHASES,
    allStages: GENERIC_STAGES,
    stageLabel: id => GENERIC_LABELS[id] || id,
    stageColors: genericStageColors,
    showAdvancedPanels: false,
    showOrderDetails: false,
    // Account management (Accounts 360 + Renewals + Contracts) is CORE to a
    // full-lifecycle CRM, not a vertical add-on — surface it for generic too so
    // a standard customer runs the whole relationship, not just acquisition.
    showAccountManagement: true,
    terminalStageIds: ['closed_won', 'closed_lost'],
    defaultStage: 'lead',
    brandSubtitle: null,
  };
}

export { urgencyColor };
