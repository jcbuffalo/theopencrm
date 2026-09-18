// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// getStageConfig(profile, orgPipeline) — per-org editable stages.
//
//   • Without a pipeline (or with a non-custom one) every profile renders
//     exactly what it did before: same ids, labels, phases, terminal ids.
//   • With a CUSTOM pipeline, stages/labels/colors/phases/terminal ids come
//     from it; profile feature toggles stay profile-driven.
//   • AuthContext registers the current pipeline via setCurrentOrgPipeline so
//     the zero-arg call sites resolve it too.

import { describe, it, expect, afterEach } from 'vitest';
import { getStageConfig, setCurrentOrgPipeline, getCurrentOrgPipeline, toneClasses, TONES } from './stages';

const CUSTOM = {
  profile: 'generic',
  is_custom: true,
  name: 'Sales',
  stages: [
    { id: 'new', label: 'New', tone: 'slate' },
    { id: 'demo', label: 'Demo', tone: 'violet', desc: 'Product demo booked' },
    { id: 'won', label: 'Won', tone: 'green', is_won: true },
    { id: 'lost', label: 'Lost', tone: 'red', is_lost: true },
  ],
  phases: [{ id: 'pipeline', label: 'Pipeline', stage_ids: ['new', 'demo', 'won', 'lost'] }],
  default_stage: 'new',
};

afterEach(() => setCurrentOrgPipeline(null));

describe('getStageConfig without an org pipeline', () => {
  it('generic keeps the 6 lowercase stages and terminal ids', () => {
    const cfg = getStageConfig('generic');
    expect(cfg.phases).toHaveLength(1);
    expect(cfg.allStages.map(s => s.id)).toEqual(['lead', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost']);
    expect(cfg.terminalStageIds).toEqual(['closed_won', 'closed_lost']);
    expect(cfg.defaultStage).toBe('lead');
    expect(cfg.stageLabel('closed_won')).toBe('Closed Won');
    expect(cfg.stageColors('qualified').header).toBe('bg-blue-100');
    expect(cfg.isCustomPipeline).toBeUndefined();
  });

  it('zang keeps three phases and 29 stages', () => {
    const cfg = getStageConfig('zang');
    expect(cfg.phases.map(p => p.id)).toEqual(['pre_sale', 'post_sale', 'post_ship']);
    expect(cfg.allStages).toHaveLength(29);
    expect(cfg.showAdvancedPanels).toBe(true);
  });

  it('a non-custom pipeline object is ignored (profile default wins)', () => {
    const cfg = getStageConfig('jcp', { ...CUSTOM, is_custom: false });
    expect(cfg.allStages.map(s => s.id)).toEqual(['LEAD', 'INTRO', 'SCOPING', 'PITCH', 'ENGAGED', 'CLOSED_WON', 'CLOSED_LOST']);
    expect(cfg.brandSubtitle).toBe('John Coles Projects');
  });
});

describe('getStageConfig with a custom org pipeline', () => {
  it('stages, labels, colors, terminal ids and default stage come from the pipeline', () => {
    const cfg = getStageConfig('generic', CUSTOM);
    expect(cfg.isCustomPipeline).toBe(true);
    expect(cfg.pipelineName).toBe('Sales');
    expect(cfg.phases).toHaveLength(1);
    expect(cfg.phases[0].stages.map(s => s.id)).toEqual(['new', 'demo', 'won', 'lost']);
    expect(cfg.allStages[1].desc).toBe('Product demo booked');
    expect(cfg.stageLabel('demo')).toBe('Demo');
    expect(cfg.stageLabel('unknown')).toBe('unknown');
    expect(cfg.stageColors('demo')).toEqual(toneClasses('violet'));
    expect(cfg.stageColors('nope')).toEqual(toneClasses('gray'));
    expect(cfg.terminalStageIds).toEqual(['won', 'lost']);
    expect(cfg.defaultStage).toBe('new');
    // Profile toggles are untouched.
    expect(cfg.showAccountManagement).toBe(true);
    expect(cfg.showAdvancedPanels).toBe(false);
  });

  it('zang custom pipelines keep multi-phase grouping from stage phases', () => {
    const zang = {
      is_custom: true,
      stages: [
        { id: 'A', label: 'A', phase: 'pre_sale', tone: 'blue' },
        { id: 'B', label: 'B', phase: 'post_sale', tone: 'green', is_won: true },
        { id: 'C', label: 'C', phase: 'pre_sale', tone: 'red', is_lost: true },
      ],
      phases: [
        { id: 'pre_sale', label: 'Pre-Sale', stage_ids: ['A', 'C'] },
        { id: 'post_sale', label: 'Post-Sale', stage_ids: ['B'] },
      ],
    };
    const cfg = getStageConfig('zang', zang);
    expect(cfg.phases.map(p => p.id)).toEqual(['pre_sale', 'post_sale']);
    expect(cfg.phases[0].stages.map(s => s.id)).toEqual(['A', 'C']);
    expect(cfg.showOrderDetails).toBe(true);
  });

  it('a registered pipeline is picked up by zero-argument callers; null forces the default', () => {
    setCurrentOrgPipeline(CUSTOM);
    expect(getCurrentOrgPipeline()).toBe(CUSTOM);
    expect(getStageConfig('generic').allStages.map(s => s.id)).toEqual(['new', 'demo', 'won', 'lost']);
    expect(getStageConfig('generic', null).allStages[0].id).toBe('lead');
    setCurrentOrgPipeline({ is_custom: false, stages: [] });
    expect(getCurrentOrgPipeline()).toBeNull();
    expect(getStageConfig('generic').allStages[0].id).toBe('lead');
  });

  it('every tone maps to literal Tailwind classes', () => {
    TONES.forEach(t => {
      const c = toneClasses(t);
      expect(c.bg).toMatch(new RegExp(`^bg-${t}-50$`));
      expect(c.header).toMatch(new RegExp(`^bg-${t}-100$`));
      expect(c.border).toMatch(new RegExp(`^border-${t}-200$`));
    });
  });
});
