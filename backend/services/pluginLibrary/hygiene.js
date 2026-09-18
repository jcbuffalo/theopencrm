// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Curated library — DATA HYGIENE entries. See ./index.js for the authoring
// contract. All five run on a schedule, read via the SDK list surfaces, and
// file ONE digest task each — never a task per record — so they stay far
// inside the run budgets and never spam the task list.

module.exports = [
  {
    slug: 'contact-data-gaps-digest',
    name: 'Contacts missing email or phone',
    category: 'hygiene',
    icon: '📇',
    summary:
      'A contact you can\'t reach is a name, not a contact. Every Monday this sweeps your contact list for records missing an email address or phone number and files a single digest task naming the first fifteen (with the full count), so someone can spend ten minutes filling the gaps instead of discovering them mid-outreach.',
    tags: ['data-quality', 'contacts', 'digest'],
    spec: {
      name: 'contact-data-gaps-digest',
      summary: 'Weekly digest task of contacts missing an email or phone number.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1' },
      actions: [
        { kind: 'create_task', title_template: 'Fill contact data gaps ({count} contacts)', due_in_days: 2 },
      ],
      source_code: `// Weekly digest of contacts missing email or phone.
module.exports = {
  async run({ crm }) {
    var contacts = await crm.listContacts({});
    var gaps = contacts.filter(function (c) { return !c.email || !c.phone; });
    if (gaps.length === 0) {
      crm.log('All ' + contacts.length + ' contacts have email and phone. Nothing to do.');
      return { gaps: 0 };
    }
    var lines = gaps.slice(0, 15).map(function (c) {
      var name = [c.first_name, c.last_name].filter(Boolean).join(' ') || ('contact #' + c.id);
      var missing = [];
      if (!c.email) missing.push('email');
      if (!c.phone) missing.push('phone');
      return '- ' + name + ' (missing ' + missing.join(' + ') + ')';
    });
    var due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Fill contact data gaps (' + gaps.length + ' contact' + (gaps.length === 1 ? '' : 's') + ')',
      description: 'These contacts are missing an email address or phone number:\\n' +
        lines.join('\\n') +
        (gaps.length > 15 ? '\\n...and ' + (gaps.length - 15) + ' more.' : '') +
        '\\nTen minutes of cleanup now saves a scramble the next time you need to reach them.',
      due_date: due,
      priority: 'low',
    });
    crm.log('Contacts with data gaps: ' + gaps.length + ' of ' + contacts.length);
    return { gaps: gaps.length, total: contacts.length };
  },
};`,
    },
  },
  {
    slug: 'company-data-gaps-digest',
    name: 'Companies missing industry or website',
    category: 'hygiene',
    icon: '🏢',
    summary:
      'Industry and website are the two company fields everything else leans on — segmentation, reporting, research before a call. This weekly sweep finds companies missing either one and files a single digest task listing them, so your account list stays segmentable and every rep walks into calls with the basics on record.',
    tags: ['data-quality', 'companies', 'digest'],
    spec: {
      name: 'company-data-gaps-digest',
      summary: 'Weekly digest task of companies missing industry or website.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1' },
      actions: [
        { kind: 'create_task', title_template: 'Fill company data gaps ({count} companies)', due_in_days: 2 },
      ],
      source_code: `// Weekly digest of companies missing industry or website.
module.exports = {
  async run({ crm }) {
    var companies = await crm.listCompanies({});
    var gaps = companies.filter(function (c) { return !c.industry || !c.website; });
    if (gaps.length === 0) {
      crm.log('All ' + companies.length + ' companies have industry and website set.');
      return { gaps: 0 };
    }
    var lines = gaps.slice(0, 15).map(function (c) {
      var missing = [];
      if (!c.industry) missing.push('industry');
      if (!c.website) missing.push('website');
      return '- ' + (c.name || ('company #' + c.id)) + ' (missing ' + missing.join(' + ') + ')';
    });
    var due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Fill company data gaps (' + gaps.length + ' compan' + (gaps.length === 1 ? 'y' : 'ies') + ')',
      description: 'These companies are missing an industry or website:\\n' +
        lines.join('\\n') +
        (gaps.length > 15 ? '\\n...and ' + (gaps.length - 15) + ' more.' : '') +
        '\\nComplete records keep segments, reports, and pre-call research accurate.',
      due_date: due,
      priority: 'low',
    });
    crm.log('Companies with data gaps: ' + gaps.length + ' of ' + companies.length);
    return { gaps: gaps.length, total: companies.length };
  },
};`,
    },
  },
  {
    slug: 'orphan-contacts-report',
    name: 'Orphan contacts (no company)',
    category: 'hygiene',
    icon: '🧩',
    summary:
      'Contacts with no company attached fall out of account views, account 360s, and segment filters — they effectively vanish from your account-based workflows. This weekly report finds every contact without a company and files one digest task listing them, so each can be linked to the right account or consciously left standalone.',
    tags: ['data-quality', 'contacts', 'accounts'],
    spec: {
      name: 'orphan-contacts-report',
      summary: 'Weekly digest task of contacts not linked to any company.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 2' },
      actions: [
        { kind: 'create_task', title_template: 'Link orphan contacts to companies ({count})', due_in_days: 3 },
      ],
      source_code: `// Weekly digest of contacts with no company link.
module.exports = {
  async run({ crm }) {
    var contacts = await crm.listContacts({});
    var orphans = contacts.filter(function (c) { return !c.company_id; });
    if (orphans.length === 0) {
      crm.log('Every contact is linked to a company. Nothing to do.');
      return { orphans: 0 };
    }
    var lines = orphans.slice(0, 15).map(function (c) {
      var name = [c.first_name, c.last_name].filter(Boolean).join(' ') || ('contact #' + c.id);
      return '- ' + name + (c.email ? ' (' + c.email + ')' : '');
    });
    var due = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Link orphan contacts to companies (' + orphans.length + ')',
      description: 'These contacts are not attached to any company, so they are invisible to account views and segments:\\n' +
        lines.join('\\n') +
        (orphans.length > 15 ? '\\n...and ' + (orphans.length - 15) + ' more.' : '') +
        '\\nLink each to the right company, or confirm it should stay standalone.',
      due_date: due,
      priority: 'low',
    });
    crm.log('Orphan contacts: ' + orphans.length + ' of ' + contacts.length);
    return { orphans: orphans.length, total: contacts.length };
  },
};`,
    },
  },
  {
    slug: 'deal-fields-enforcer',
    name: 'Deals missing amount or close date',
    category: 'hygiene',
    icon: '🎯',
    summary:
      'A deal with no amount or no expected close date can\'t be forecast — it just haunts the pipeline. This daily check finds open deals missing either field and files one digest task listing the worst offenders, so your forecast is built on deals that actually carry the numbers a forecast needs.',
    tags: ['data-quality', 'deals', 'forecast'],
    spec: {
      name: 'deal-fields-enforcer',
      summary: 'Daily digest task of open deals missing amount or expected close date.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1-5' },
      actions: [
        { kind: 'create_task', title_template: 'Complete forecast fields on {count} deals', due_in_days: 1 },
      ],
      source_code: `// Daily digest of open deals missing amount or expected close date.
module.exports = {
  async run({ crm }) {
    var deals = await crm.listDeals({ status: 'open' });
    var gaps = deals.filter(function (d) {
      var noAmount = d.amount == null || Number(d.amount) === 0;
      var noDate = !d.expected_close_date;
      return noAmount || noDate;
    });
    if (gaps.length === 0) {
      crm.log('All ' + deals.length + ' open deals carry an amount and close date.');
      return { gaps: 0 };
    }
    var lines = gaps.slice(0, 12).map(function (d) {
      var missing = [];
      if (d.amount == null || Number(d.amount) === 0) missing.push('amount');
      if (!d.expected_close_date) missing.push('close date');
      return '- ' + (d.title || ('#' + d.id)) + ' [' + d.stage + '] (missing ' + missing.join(' + ') + ')';
    });
    var due = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Complete forecast fields on ' + gaps.length + ' deal' + (gaps.length === 1 ? '' : 's'),
      description: 'These open deals are missing the fields the forecast depends on:\\n' +
        lines.join('\\n') +
        (gaps.length > 12 ? '\\n...and ' + (gaps.length - 12) + ' more.' : '') +
        '\\nAdd an amount and expected close date to each, or close out deals that are no longer real.',
      due_date: due,
      priority: 'medium',
    });
    crm.log('Open deals missing forecast fields: ' + gaps.length + ' of ' + deals.length);
    return { gaps: gaps.length, total: deals.length };
  },
};`,
    },
  },
  {
    slug: 'stage-stuck-report',
    name: 'Stage-stuck deals report',
    category: 'hygiene',
    icon: '🚦',
    summary:
      'Deals that sit untouched in one stage for weeks are where pipelines quietly rot. This daily report finds open deals not updated in 21+ days, groups them by stage, and files a single digest task showing the count per stage plus the longest-stuck examples — a ready-made agenda for your next pipeline review.',
    tags: ['pipeline', 'staleness', 'digest'],
    spec: {
      name: 'stage-stuck-report',
      summary: 'Daily digest of open deals untouched for 21+ days, grouped by stage (based on last update time).',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1-5', stuck_days: 21 },
      actions: [
        { kind: 'create_task', title_template: 'Pipeline review: {count} deals stuck 21+ days', due_in_days: 1 },
      ],
      source_code: `// Daily report of deals sitting untouched (by last update) for 21+ days.
module.exports = {
  async run({ crm, input }) {
    var stuckDays = (input && Number(input.stuck_days)) || 21;
    var cutoff = Date.now() - stuckDays * 86400000;
    var deals = await crm.listDeals({ status: 'open' });
    var stuck = deals.filter(function (d) {
      var last = d.last_activity_at || d.updated_at || d.created_at;
      return last && new Date(last).getTime() < cutoff;
    });
    if (stuck.length === 0) {
      crm.log('No open deals untouched for ' + stuckDays + '+ days.');
      return { stuck: 0 };
    }
    var byStage = {};
    for (var i = 0; i < stuck.length; i++) {
      var s = stuck[i].stage || '(no stage)';
      byStage[s] = (byStage[s] || 0) + 1;
    }
    var stageLines = Object.keys(byStage).map(function (s) { return '- ' + s + ': ' + byStage[s]; });
    var oldest = stuck.slice().sort(function (a, b) {
      var ta = new Date(a.last_activity_at || a.updated_at || a.created_at).getTime();
      var tb = new Date(b.last_activity_at || b.updated_at || b.created_at).getTime();
      return ta - tb;
    }).slice(0, 5).map(function (d) {
      var days = Math.floor((Date.now() - new Date(d.last_activity_at || d.updated_at || d.created_at).getTime()) / 86400000);
      return '- ' + (d.title || ('#' + d.id)) + ' [' + d.stage + '] — ' + days + ' days';
    });
    var due = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Pipeline review: ' + stuck.length + ' deal' + (stuck.length === 1 ? '' : 's') + ' stuck ' + stuckDays + '+ days',
      description: 'Open deals untouched for ' + stuckDays + '+ days (based on last update), by stage:\\n' +
        stageLines.join('\\n') +
        '\\nLongest-stuck:\\n' + oldest.join('\\n') +
        '\\nFor each: advance it, park it with a dated next step, or close it out honestly.',
      due_date: due,
      priority: 'medium',
    });
    crm.log('Stage-stuck deals: ' + stuck.length + ' of ' + deals.length);
    return { stuck: stuck.length, total: deals.length };
  },
};`,
    },
  },
];
