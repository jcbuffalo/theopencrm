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

  // --------------------------------------------------------------------------
  // WAVE 2 (2026-09) — dedupe detection, lost-deal cleanup, company rollups.
  // Weekly entries run on schedule.daily and gate on Monday inside the source
  // (schedule payloads carry the UTC date; there is no dispatched weekly
  // event yet). Detection entries file ONE digest and never auto-merge —
  // merging records is a human decision.
  // --------------------------------------------------------------------------
  {
    slug: 'contact-dupe-detector',
    name: 'Duplicate-contact detector',
    category: 'hygiene',
    icon: '🧑‍🤝‍🧑',
    summary:
      'Duplicate contacts split the conversation history and guarantee someone works a cold copy of a warm relationship. Every Monday this sweeps your contacts for records sharing an email address or a normalized full name and files one digest task listing the suspected pairs. It never merges anything itself — merging is a judgment call — it just makes sure the pairs stop hiding.',
    tags: ['dedupe', 'contacts', 'digest'],
    spec: {
      name: 'contact-dupe-detector',
      summary: 'Weekly (Monday) digest task of contact pairs sharing an email or normalized name. Detection only — never auto-merges.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1' },
      actions: [
        { kind: 'create_task', title_template: 'Review suspected duplicate contacts ({count})', due_in_days: 2 },
      ],
      source_code: `// Weekly sweep for contacts that look like duplicates. Detection only.
module.exports = {
  async run({ crm, input }) {
    var t = (input && input.trigger) || input || {};
    var ref = t.date ? new Date(String(t.date)) : new Date();
    if (ref.getUTCDay() !== 1) {
      crm.log('Not Monday — the weekly duplicate sweep runs Mondays.');
      return { skipped: true, reason: 'not_monday' };
    }
    var contacts = await crm.listContacts({});
    var byEmail = {};
    var byName = {};
    var pairs = [];
    var flagged = {};
    function addPair(a, b, why) {
      var key = Math.min(a.id, b.id) + '-' + Math.max(a.id, b.id);
      if (flagged[key]) return;
      flagged[key] = true;
      pairs.push({ a: a, b: b, why: why });
    }
    for (var i = 0; i < contacts.length; i++) {
      var c = contacts[i];
      var email = String(c.email || '').trim().toLowerCase();
      if (email) {
        if (byEmail[email]) addPair(byEmail[email], c, 'same email ' + email);
        else byEmail[email] = c;
      }
      var name = [c.first_name, c.last_name].filter(Boolean).join(' ')
        .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (name) {
        if (byName[name]) addPair(byName[name], c, 'same name "' + name + '"');
        else byName[name] = c;
      }
    }
    if (pairs.length === 0) {
      crm.log('No suspected duplicate contacts among ' + contacts.length + '.');
      return { duplicates: 0, contacts: contacts.length };
    }
    var lines = pairs.slice(0, 12).map(function (p) {
      var an = [p.a.first_name, p.a.last_name].filter(Boolean).join(' ') || ('#' + p.a.id);
      return '- #' + p.a.id + ' and #' + p.b.id + ' (' + an + '): ' + p.why;
    });
    var due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Review suspected duplicate contacts (' + pairs.length + ' pair' + (pairs.length === 1 ? '' : 's') + ')',
      description: 'These contacts share an email address or a normalized name and may be duplicates:\\n' +
        lines.join('\\n') +
        (pairs.length > 12 ? '\\n...and ' + (pairs.length - 12) + ' more pair(s).' : '') +
        '\\nReview each pair and merge or annotate — this extension only detects, it never merges.',
      due_date: due,
      priority: 'medium',
    });
    crm.log('Suspected duplicate contact pairs: ' + pairs.length + ' of ' + contacts.length + ' contacts.');
    return { duplicates: pairs.length, contacts: contacts.length };
  },
};`,
    },
  },
  {
    slug: 'company-dupe-detector',
    name: 'Duplicate-company detector',
    category: 'hygiene',
    icon: '🏢',
    summary:
      '"Acme", "Acme Inc" and "Acme, LLC" are one customer wearing three coats — and three copies of the truth about them. Every Monday this normalizes company names (legal suffixes and punctuation stripped) and website domains, matches them, and files one digest task of suspected duplicate pairs. Detection only: merging stays a human call.',
    tags: ['dedupe', 'companies', 'digest'],
    spec: {
      name: 'company-dupe-detector',
      summary: 'Weekly (Monday) digest task of company pairs matching on normalized name or website domain. Detection only.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1' },
      actions: [
        { kind: 'create_task', title_template: 'Review suspected duplicate companies ({count})', due_in_days: 2 },
      ],
      source_code: `// Weekly sweep for companies that look like duplicates. Detection only.
module.exports = {
  async run({ crm, input }) {
    var t = (input && input.trigger) || input || {};
    var ref = t.date ? new Date(String(t.date)) : new Date();
    if (ref.getUTCDay() !== 1) {
      crm.log('Not Monday — the weekly duplicate sweep runs Mondays.');
      return { skipped: true, reason: 'not_monday' };
    }
    var companies = await crm.listCompanies({});
    function normName(name) {
      return String(name || '').toLowerCase()
        .replace(/\\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|gmbh|plc)\\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ').trim();
    }
    function domain(website) {
      var w = String(website || '').toLowerCase()
        .replace(/^https?:\\/\\//, '').replace(/^www\\./, '');
      var slash = w.indexOf('/');
      return slash === -1 ? w : w.slice(0, slash);
    }
    var byName = {};
    var byDomain = {};
    var pairs = [];
    var flagged = {};
    function addPair(a, b, why) {
      var key = Math.min(a.id, b.id) + '-' + Math.max(a.id, b.id);
      if (flagged[key]) return;
      flagged[key] = true;
      pairs.push({ a: a, b: b, why: why });
    }
    for (var i = 0; i < companies.length; i++) {
      var c = companies[i];
      var n = normName(c.name);
      if (n) {
        if (byName[n]) addPair(byName[n], c, 'same normalized name "' + n + '"');
        else byName[n] = c;
      }
      var d = domain(c.website);
      if (d) {
        if (byDomain[d]) addPair(byDomain[d], c, 'same domain ' + d);
        else byDomain[d] = c;
      }
    }
    if (pairs.length === 0) {
      crm.log('No suspected duplicate companies among ' + companies.length + '.');
      return { duplicates: 0, companies: companies.length };
    }
    var lines = pairs.slice(0, 12).map(function (p) {
      return '- #' + p.a.id + ' "' + (p.a.name || '') + '" and #' + p.b.id + ' "' + (p.b.name || '') + '": ' + p.why;
    });
    var due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Review suspected duplicate companies (' + pairs.length + ' pair' + (pairs.length === 1 ? '' : 's') + ')',
      description: 'These companies match on normalized name or website domain and may be duplicates:\\n' +
        lines.join('\\n') +
        (pairs.length > 12 ? '\\n...and ' + (pairs.length - 12) + ' more pair(s).' : '') +
        '\\nReview each pair and merge or annotate — this extension only detects, it never merges.',
      due_date: due,
      priority: 'medium',
    });
    crm.log('Suspected duplicate company pairs: ' + pairs.length + ' of ' + companies.length + ' companies.');
    return { duplicates: pairs.length, companies: companies.length };
  },
};`,
    },
  },
  {
    slug: 'lost-deal-cleanup',
    name: 'Lost-deal cleanup sweep',
    category: 'hygiene',
    icon: '🧹',
    summary:
      'A lost deal that leaves its follow-up tasks open keeps generating busywork for a deal that no longer exists. When a deal moves to closed-lost, this cancels every open task still attached to it (up to 25) and files one wrap-up task asking for the loss reason to be logged — so the task list empties honestly and the loss still teaches something.',
    tags: ['cleanup', 'closed-lost', 'tasks'],
    spec: {
      name: 'lost-deal-cleanup',
      summary: 'On closed-lost, cancel the deal\'s open tasks (max 25) and create one wrap-up task to log the loss reason.',
      triggerEvent: 'deal.stage_changed',
      triggerFilter: { stage: 'CLOSED_LOST' },
      actions: [
        { kind: 'set_field', entity: 'task', field: 'status', value: 'cancelled' },
        { kind: 'create_task', title_template: 'Wrap up lost deal: {deal.title}', due_in_days: 2 },
      ],
      source_code: `// Cancel a lost deal's open tasks and ask for the loss reason.
module.exports = {
  async run({ crm, input }) {
    var t = (input && input.trigger) || input || {};
    var rec = t.deal || t.record || t;
    var stage = String(t.stage || t.newStage || t.new_stage || rec.stage || '').toUpperCase();
    if (stage !== 'CLOSED_LOST') return { skipped: true, reason: 'not_closed_lost' };
    var dealId = Number(rec.id || t.id || t.dealId || t.deal_id);
    if (!Number.isInteger(dealId) || dealId <= 0) return { skipped: true, reason: 'no_deal_id' };
    var title = rec.title || t.title || ('deal #' + dealId);
    var open = await crm.listTasks({ deal_id: dealId, status: 'open' });
    var cancelled = 0;
    for (var i = 0; i < open.length && cancelled < 25; i++) {
      // Belt and braces: only cancel tasks actually linked to this deal and
      // still open (the filter should guarantee both).
      var linked = open[i].deal_id == null ? null : Number(open[i].deal_id);
      if (linked !== dealId) continue;
      if (open[i].status !== 'open' && open[i].status !== 'in_progress') continue;
      await crm.updateTask(open[i].id, { status: 'cancelled' });
      cancelled++;
    }
    var due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Wrap up lost deal: ' + title,
      description: 'This deal closed lost; ' + cancelled + ' open task(s) on it were cancelled automatically.\\n' +
        'Before moving on, log the loss reason on the deal: who won instead, why, and what (if anything) would have changed the outcome. ' +
        'Losses that get a reason become pattern data; losses that do not just become quota.',
      due_date: due,
      priority: 'medium',
      deal_id: dealId,
    });
    crm.log('Lost-deal cleanup for ' + title + ': ' + cancelled + ' task(s) cancelled.');
    return { tasks_cancelled: cancelled, wrap_up_created: true };
  },
};`,
    },
  },
  {
    slug: 'company-rollup-digest',
    name: 'Company pipeline rollups',
    category: 'hygiene',
    icon: '🧾',
    summary:
      'The numbers Salesforce admins buy rollup add-ons for: per-company open pipeline value, open-deal count, and days since last activity. Every day this computes them across your open deals and files one digest task showing the top ten accounts by open pipeline — quiet ones flagged — so account-level exposure is a glance, not a spreadsheet exercise. (The SDK has no custom-field write surface, so the rollups land as a digest rather than stamped fields.)',
    tags: ['rollups', 'companies', 'digest'],
    spec: {
      name: 'company-rollup-digest',
      summary: 'Daily digest task of per-company rollups over open deals: pipeline value, deal count, days since last activity.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1-5' },
      actions: [
        { kind: 'create_task', title_template: 'Company pipeline rollups — {today}', due_in_days: 0 },
      ],
      source_code: `// Roll up open-deal value / count / recency per company into one digest.
module.exports = {
  async run({ crm }) {
    var deals = await crm.listDeals({ status: 'open' });
    var rollup = {};
    for (var i = 0; i < deals.length; i++) {
      var d = deals[i];
      if (!d.company_id) continue;
      var r = rollup[d.company_id] || (rollup[d.company_id] = { amount: 0, count: 0, last: 0 });
      r.amount += Number(d.amount) || 0;
      r.count++;
      var t = new Date(d.last_activity_at || d.updated_at || d.created_at || 0).getTime();
      if (t > r.last) r.last = t;
    }
    var ids = Object.keys(rollup);
    if (ids.length === 0) {
      crm.log('No open deals attached to companies — nothing to roll up.');
      return { companies: 0 };
    }
    var companies = await crm.listCompanies({});
    var nameById = {};
    for (var j = 0; j < companies.length; j++) nameById[companies[j].id] = companies[j].name;
    ids.sort(function (a, b) { return rollup[b].amount - rollup[a].amount; });
    var now = Date.now();
    var lines = ids.slice(0, 10).map(function (id) {
      var r = rollup[id];
      var quiet = r.last ? Math.floor((now - r.last) / 86400000) : null;
      return '- ' + (nameById[id] || ('company #' + id)) + ': $' + Math.round(r.amount) +
        ' across ' + r.count + ' deal(s), last activity ' +
        (quiet === null ? 'unknown' : quiet + ' day(s) ago' + (quiet >= 30 ? ' — QUIET' : ''));
    });
    var today = new Date().toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Company pipeline rollups — ' + today,
      description: 'Open pipeline by account (top ' + Math.min(ids.length, 10) + ' of ' + ids.length + '):\\n' +
        lines.join('\\n') +
        '\\nBig exposure + long silence is the combination to act on first.',
      due_date: today,
      priority: 'low',
    });
    crm.log('Company rollups computed for ' + ids.length + ' account(s) across ' + deals.length + ' open deals.');
    return { companies: ids.length, open_deals: deals.length };
  },
};`,
    },
  },
];
