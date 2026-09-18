// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Grounded capability map for the chat copilot.
//
// WHY: without this, the model improvises generic, often-wrong answers to
// "can I / how do I" questions (it suggested IMAP/BCC for email import — neither
// is a real feature here). The `how_do_i` chat tool looks up the matching entry
// and returns the truth: status, where it lives, the real gating flag, and steps.
// Keep this in sync with PRICING_AND_FEATURES.md + services/featureFlags.js.
//
// status: 'live' (works now) | 'config' (built, needs per-customer/admin setup)
//       | 'roadmap' (not built) | 'unsupported' (we will not do this)
//
// MATCHING: each entry has `keywords` (multi-word phrases, matched as stemmed
// token sequences — "add a field" matches "add a fields") and optional
// `synonyms` (single words that lean toward the topic but are weaker than a
// phrase hit: "column"/"property" → custom fields, "rule"/"trigger" →
// automation rules). lookupAll() returns the ranked matches so how_do_i can
// hand back the top two when a question is genuinely ambiguous.
//
// This file also owns the NAVIGATION REGISTRY (PAGES) — every authenticated
// destination the copilot may point at. The `open_page` tool and the
// action-chip builder in routes/aiRoutes.js both read it, so chips and the
// tool can never disagree about where a page lives.

const CAPABILITIES = [
  {
    topic: 'external_email_import',
    keywords: ['import email', 'external mailbox', 'imap', 'sync my inbox', 'connect gmail account', 'connect outlook', 'bcc', 'forward emails', 'pull in emails', 'old emails'],
    status: 'unsupported',
    summary: 'Importing/syncing a full external mailbox (IMAP, BCC-logging, inbox sync) is not a feature.',
    where: null,
    gating: null,
    how: 'What we DO have: per-deal Gmail thread linkage + Claude thread summaries (see "gmail_thread_sync"), and per-deal Outlook mail/calendar intel (see "outlook_m365"). For sending, I can draft and you can send follow-ups from any deal. There is no generic mailbox import.',
  },
  {
    topic: 'gmail_thread_sync',
    keywords: ['gmail', 'gmail thread', 'thread summary', 'email intel', 'link emails to deals', 'gmail sync'],
    status: 'config',
    summary: 'Per-deal Gmail thread linkage with Claude-authored thread summaries (a periodic inbound sync per connected org).',
    where: '/admin/feature-flags',
    gating: 'gmail_intel_enabled',
    how: 'An org owner/admin enables the gmail_intel_enabled flag (I can propose that), then connects Google from a deal\'s Gmail panel. Note: the gmail.readonly scope is a Google "restricted" scope — a general-audience rollout needs CASA verification (6–12 weeks). Best for single-tenant deployments today.',
  },
  {
    topic: 'csv_import',
    keywords: ['import csv', 'import contacts', 'import companies', 'import deals', 'bulk import', 'upload spreadsheet', 'spreadsheet', 'csv', 'excel', 'migrate my data', 'import my data', 'import wizard', 'upload a file'],
    synonyms: ['import', 'migrate', 'upload'],
    status: 'live',
    summary: 'CSV import for companies, contacts, and deals, with column mapping.',
    where: '/import',
    gating: null,
    how: 'Go to /import (the Import Wizard), pick the entity (companies, contacts, or deals), map your spreadsheet columns to CRM fields, and upload. Custom fields you have defined appear as mapping targets too.',
  },
  {
    topic: 'quickbooks',
    keywords: ['quickbooks', 'qb', 'accounting', 'invoice sync', 'intuit'],
    status: 'config',
    summary: 'QuickBooks Online integration: OAuth connect + invoice creation on the INVOICED stage.',
    where: '/admin/integrations',
    gating: 'quickbooks_enabled',
    how: 'A super-admin connects QuickBooks at /admin/integrations (needs QB_CLIENT_ID/SECRET set + a chart-of-accounts mapping). Then deals moving to INVOICED can create a QB invoice.',
  },
  {
    topic: 'teams_zoom_meetings',
    keywords: ['teams', 'zoom', 'meeting logs', 'call recording', 'transcript', 'webhook'],
    status: 'config',
    summary: 'Inbound Teams/Zoom webhook receivers that log meetings onto deals.',
    where: '/admin/integrations',
    gating: 'webhooks_enabled',
    how: 'Operator sets TEAMS_WEBHOOK_SECRET / ZOOM_WEBHOOK_SECRET_TOKEN and points a Power Automate / Zoom event app at the webhook URL.',
  },
  {
    topic: 'billing_upgrade',
    keywords: ['upgrade', 'billing', 'subscription', 'stripe', 'change plan', 'tier', 'pricing', 'how much does it cost'],
    synonyms: ['pay', 'plan', 'price'],
    status: 'config',
    summary: 'Stripe checkout + customer portal for tier upgrades.',
    where: '/settings',
    gating: null,
    how: 'Stripe checkout/portal UI is shipped but needs Stripe keys activated on the deployment; upgrades are processed manually until then. AI usage is metered separately — see "usage_and_ai_keys".',
  },
  {
    topic: 'usage_and_ai_keys',
    keywords: ['usage', 'ai usage', 'token usage', 'tokens', 'ai cost', 'ai spend', 'my own api key', 'own anthropic key', 'bring your own key', 'byo key', 'byok', 'anthropic key', 'api key for ai', 'ai billing', 'pay as you go', 'overage', 'ai quota', 'quota'],
    synonyms: ['token', 'quota', 'metered'],
    status: 'config',
    summary: 'AI usage is metered per org (requests, tokens, estimated cost) and shown at /usage; hosted AI is pay-as-you-go on top of the seat price, and self-hosters bring their own Anthropic key with no markup.',
    where: '/usage',
    gating: null,
    how: 'Check /usage for this month\'s AI requests, tokens, and estimated cost (per user and per feature). Self-host: set ANTHROPIC_API_KEY on your own deployment — you pay Anthropic directly, no markup. Hosted: usage is metered and billed pay-as-you-go via Stripe once the operator enables AI billing; or an org owner/admin can paste their own Anthropic key on /usage ("Use your own Anthropic key") — then AI runs on that key, billed by Anthropic directly at their rates with no markup, and the pay-as-you-go card never appears. The model/effort the copilot uses is chosen per org at /admin/ai-model.',
  },
  {
    topic: 'white_label_branding',
    keywords: ['branding', 'logo', 'white label', 'rename', 'custom color', 'company name', 'terminology', 'brand color', 'display name'],
    synonyms: ['brand', 'theme', 'colors'],
    status: 'live',
    summary: 'Per-org display name, logo, primary color, and label overrides.',
    where: '/admin/branding',
    gating: null,
    how: 'An org owner/admin sets display name, logo URL, primary color, and label overrides at /admin/branding.',
  },
  {
    topic: 'reports',
    keywords: ['report', 'reports', 'analytics', 'hit rate', 'pipeline value', 'per salesman', 'leaderboard', 'report builder', 'custom report', 'build a report', 'saved report', 'group by', 'chart', 'bar chart', 'pie chart', 'win rate', 'deals by stage', 'revenue by'],
    synonyms: ['chart', 'graph', 'metrics', 'breakdown'],
    status: 'live',
    summary: 'Dashboards + reports: hit rate, pipeline value, per-salesman, per-vendor, time-series — plus a custom report builder (pick an entity, filters, group-by, metric, chart) with saved reports.',
    where: '/reports',
    gating: 'reports_enabled',
    how: 'Open /reports (gated by reports_enabled) for the standard reports, or /reports/builder to build your own: entity (deals, contacts, companies, activities), filters, group_by, metric (count / sum:<field> / avg:<field>), and chart type (bar, line, pie, table). Or just ask me — "build a report of won deal value by month as a line chart" — and I will propose it with propose_report; Apply saves it to your Saved Reports. The dashboard at /dashboard has the at-a-glance metrics.',
  },
  {
    topic: 'forecast',
    keywords: ['forecast', 'forecasting', 'revenue forecast', 'sales forecast', 'weighted pipeline', 'projected revenue', 'expected revenue', 'what will we close', 'commit this quarter'],
    synonyms: ['projection', 'projected'],
    status: 'live',
    summary: 'Revenue forecast view: expected-close-date and probability-weighted pipeline by period.',
    where: '/forecast',
    gating: 'reports_enabled',
    how: 'Open /forecast (gated by reports_enabled). It weights open deals by probability and expected close date and rolls them up by period. Keep amount, probability, and expected_close_date filled in on deals for it to be useful. Commission reporting lives alongside it under /reports.',
  },
  {
    topic: 'two_factor',
    keywords: ['2fa', 'two factor', 'totp', 'authenticator', 'mfa'],
    status: 'config',
    summary: 'TOTP 2FA enroll/verify/disable.',
    where: '/security',
    gating: null,
    how: 'Enroll at /security (scan the QR with an authenticator app). Note: login does not yet force 2FA even when enabled — enforcement is in progress.',
  },
  {
    topic: 'plugins_automation',
    keywords: ['plugin', 'plugins', 'custom workflow', 'run code', 'integration builder', 'sandbox', 'plugin library', 'write code'],
    synonyms: ['script', 'code'],
    status: 'config',
    summary: 'Org-scoped plugins: generate drafts in plain English or install from the curated library, then run them in an isolated sandbox with confirm-first writes. (For simple when-X-then-Y rules you do NOT need plugins — see "automation_rules".)',
    where: '/plugins',
    gating: 'plugins_enabled',
    how: 'An org admin enables plugins_enabled (off by default), then you author at /plugins (plain-English generation, the curated library, or raw code). Runs execute in an isolated-vm sandbox in PREVIEW mode — any proposed CRM writes are staged, and only an org owner/admin can apply them. Plugins have no network access and can only call the allowlisted CRM SDK.',
  },
  {
    topic: 'build_tool_from_chat',
    keywords: ['build a tool', 'build me a tool', 'build a plugin', 'build me a plugin', 'make a tool', 'make me a tool', 'create a tool', 'create my own tool', 'my own tool', 'custom tool', 'tool from chat', 'write me a plugin'],
    status: 'config',
    summary: 'Build your own tool right here in chat: describe it in plain English and I generate a plugin draft you confirm before anything is saved.',
    where: '/plugins',
    gating: 'plugins_enabled',
    how: 'Requires the plugins module (plugins_enabled, off by default — an org owner/admin can enable it, and I can propose that). Then just describe the tool ("flag deals stuck 30 days and create a follow-up task each morning"). TWO confirm gates, honestly: (1) I generate and validator-screen a spec and show you a draft card — clicking Apply only SAVES it as an inactive draft in /plugins, nothing runs; (2) running it is the existing plugin flow — an isolated-vm sandbox preview that stages any writes, which an org owner/admin then applies. Generated tools never auto-execute, have no network access, and can only call the allowlisted CRM SDK (read/update deals, contacts, companies, tasks; create tasks) — so no Slack/webhook/external calls. For a simple when-X-then-Y rule, an automation rule (no plugins needed) is usually the better fit.',
  },
  {
    topic: 'extension_library',
    keywords: ['extension', 'extensions', 'extension library', 'app store', 'marketplace', 'install an extension', 'enable an extension', 'turn on an extension', 'ready-made automation', 'templates library'],
    synonyms: ['add-on', 'addon', 'app'],
    status: 'config',
    summary: 'A curated library of ready-made extensions (follow-ups, digests, data hygiene, CX, reporting) you can enable in one click — from the /plugins/library gallery or right here in chat.',
    where: '/plugins/library',
    gating: 'plugins_enabled',
    how: 'Requires the plugins module (plugins_enabled, off by default — an owner/admin can enable it, and I can propose that). Ask me "what extensions do you have for follow-ups?" (list_extensions shows the catalog with your org\'s installed status) and "turn on the stalled-deal digest" — I will propose it with propose_install_extension; an org owner/admin clicks Apply and it installs AND activates in one step. Or browse the gallery at /plugins/library and click Enable. Extensions marked with a required integration need that integration connected first.',
  },
  {
    topic: 'soc2_security',
    keywords: ['soc 2', 'soc2', 'iso 27001', 'pen test', 'compliance certification'],
    status: 'roadmap',
    summary: 'SOC 2 / ISO 27001 / external pen test.',
    where: '/handoff',
    gating: null,
    how: 'Not yet certified. What exists today: append-only audit log, JWT/bcrypt auth, rate limiting, GDPR/CCPA self-service. SOC 2 + pen test are on the roadmap. See /handoff for the security posture.',
  },
  {
    topic: 'gdpr_export_delete',
    keywords: ['export my data', 'gdpr', 'ccpa', 'delete my account', 'data deletion', 'download data'],
    status: 'live',
    summary: 'Self-service data export + account deletion (7-day grace).',
    where: '/settings#privacy',
    gating: null,
    how: 'Go to /settings#privacy to export all your data or schedule account deletion.',
  },
  {
    topic: 'crm_edits_via_chat',
    keywords: ['update deal', 'change stage', 'move deal', 'create task', 'log a call', 'log activity', 'add contact', 'add company', 'edit', 'make a change', 'book a meeting from chat', 'assign owner from chat', 'mark at risk', 'enroll a contact', 'run a playbook from chat'],
    status: 'live',
    summary: 'I can make changes directly in chat (confirm-first): deals, tasks, activities, contacts, companies, leads, cases, meetings, account lifecycle stage, record owners, sequence enrollment, and playbook runs.',
    where: null,
    gating: 'ai_features_enabled',
    how: 'Just ask — e.g. "move the Acme deal to negotiation", "book a meeting with Beta Friday 10am", "mark Acme at-risk", "assign the Gamma deal to Sam", "enroll Jane in the nurture sequence", "run the onboarding playbook for Acme". I will propose the change and you click Apply before anything is written. Enrolling in a sequence never sends email by itself — steps go out via the sequence worker, which stays inert until the deployment has an email transport.',
  },
  {
    topic: 'build_with_chat',
    keywords: ['what can you build', 'what can you do', 'what can i build', 'help me set up', 'set up my crm', 'set up my workspace', 'configure my workspace', 'customize my crm', 'customise my crm', 'customize the crm', 'tailor the crm', 'build my crm', 'get started', 'getting started', 'onboard my team'],
    synonyms: ['customize', 'customise', 'configure', 'setup'],
    status: 'live',
    summary: 'You can build your workspace from chat, confirm-first: custom fields, automation rules, saved views, custom reports, module toggles, and (with plugins on) custom tools — plus every CRM record change.',
    where: null,
    gating: 'ai_features_enabled',
    how: 'Describe what you want and I propose it; nothing changes until you click Apply. Examples: "add a Contract Value number field on deals" (custom field — owner/admin applies), "when a deal moves to Closed Won, create a task to send the welcome email" (automation rule — owner/admin applies), "save a view of hot deals over $50k" (saved view — any member), "report of deals by stage as a pie chart" (saved report), "turn on the customer portal module" (feature flag — owner/admin). I can also open any page for you ("open the report builder"). Things I cannot build yet: new pipeline stages (fixed per profile today) and external integrations that need credentials (those are set up under /admin/integrations).',
  },
  {
    topic: 'cohort_actions_via_chat',
    keywords: ['bulk update from chat', 'cohort', 'cohort action', 'everyone in a segment', 'all my accounts', 'mass update', 'bulk enroll', 'bulk assign', 'at scale', 'every churned', 'all at-risk', 'batch action'],
    status: 'live',
    summary: 'Cohort actions from chat: run one bulk action over every current member of a saved segment or an inline filter — set lifecycle stage, assign an owner, create a task each, open a case each, or enroll every contact in a sequence.',
    where: '/segments',
    gating: 'customer_success_enabled',
    how: 'Ask in plain English — e.g. "mark every account untouched for 90 days at-risk" or "open a case for each churned customer". I show the exact affected count and a sample BEFORE anything writes; you click Apply to run it. Applying re-checks membership, is capped at 5000 records per action, and requires an org owner/admin. Cohort sequence-enrollment only creates enrollments — email leaves solely via the suppression-aware sequence worker, which is inert until an email transport is configured.',
  },

  // --------------------------------------------------------------------------
  // BUILDING THE WORKSPACE — custom fields, stages, automation rules, saved
  // views. These are the "chat and BUILD" topics: each points at the real
  // admin page AND the propose_* tool that builds the thing from chat.
  // --------------------------------------------------------------------------
  {
    topic: 'custom_fields',
    keywords: ['custom field', 'custom fields', 'add a field', 'new field', 'extra field', 'another field', 'add a column', 'new column', 'custom property', 'custom properties', 'field on deals', 'field on contacts', 'field on companies', 'field on tasks', 'track something on', 'customizations', 'customisations', 'dropdown field', 'checkbox field', 'date field', 'number field', 'text field', 'picklist'],
    synonyms: ['field', 'fields', 'column', 'columns', 'property', 'properties', 'attribute', 'attributes', 'dropdown', 'picklist'],
    status: 'live',
    summary: 'Per-org custom fields on deals, companies, contacts, and tasks: text, number, date, select (dropdown), multiselect, or boolean (checkbox), optionally required. They render on the record forms and are CSV-import mapping targets.',
    where: '/admin/customizations',
    gating: null,
    how: 'Ask me — "add a Contract Value number field on deals" or "add a dropdown called Region (West, Central, East) to companies" — and I will propose it with propose_add_custom_field; an org owner/admin clicks Apply. Or manage them by hand at /admin/customizations (owner/admin). Rules: the field key is lowercase snake_case and cannot shadow a built-in column; select/multiselect need options; url/email fields are stored as text. Custom fields are NOT available on leads yet. Changing a field\'s type or key later means delete + re-create (values stay in the record JSON).',
  },
  {
    topic: 'pipeline_stages',
    keywords: ['pipeline stage', 'pipeline stages', 'deal stage', 'deal stages', 'add a stage', 'new stage', 'rename a stage', 'rename stage', 'remove a stage', 'change the stages', 'change stages', 'custom stages', 'edit stages', 'edit the pipeline', 'kanban columns', 'sales stages', 'what stages', 'which stages', 'stages do i have', 'my stages', 'stage names'],
    synonyms: ['stage', 'stages'],
    status: 'live',
    summary: 'Pipeline stages ARE editable per org: an owner/admin can add, rename, reorder, recolor, and remove stages, and mark which count as won / lost, at /settings/pipeline or by asking me (propose_update_pipeline). Until an org edits them, the stages are the profile default — generic: lead → qualified → proposal → negotiation → closed_won / closed_lost. jcp: LEAD → INTRO → SCOPING → PITCH → ENGAGED → CLOSED_WON / CLOSED_LOST. zang: the 29-stage Exhibit A lifecycle (TRIAGE → VENDOR_QUOTING → CUSTOMER_QUOTING → FOLLOW_UP … → INVOICED → CLOSED → SERVICE … END_USER) across Pre-Sale / Post-Sale / Post-Shipment. rin: runs the generic pipeline.',
    where: '/settings/pipeline',
    gating: null,
    how: 'Ask me — "add a Demo stage after Qualified", "rename Proposal to Quote Sent", "remove Negotiation and move its deals to Proposal", "put Qualified first" — and I will propose it with propose_update_pipeline; an org owner/admin clicks Apply. Or edit by hand at /settings/pipeline (owner/admin; members see it read-only). Rules: stage ids stay unique and stable, at least one won and one lost stage, labels up to 40 characters, and a stage that still holds deals can only be removed by choosing where its deals go (they move in the same save — nothing is orphaned). "Reset to default" returns to the profile stage set. The how_do_i result carries your_stages (your org\'s current list, custom edits included).',
    stages_by_profile: {
      generic: ['lead', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost'],
      jcp: ['LEAD', 'INTRO', 'SCOPING', 'PITCH', 'ENGAGED', 'CLOSED_WON', 'CLOSED_LOST'],
      zang: ['TRIAGE', 'VENDOR_QUOTING', 'CUSTOMER_QUOTING', 'FOLLOW_UP', 'NO_FOLLOW_UP', 'NO_QUOTE', 'LOST', 'COLD', 'CANCELLED', 'NOT_PROCESSED', 'PROCESSED', 'ORDACK', 'VAP', 'CAP', 'RELACK', 'MONITOR', 'COORDINATE', 'WHSE', 'TBI', 'COMM_WATCH', 'INVOICED', 'CLOSED_PAID', 'CLOSED', 'SERVICE', 'CLOSEOUTS', 'CUSTOMER_EXPERIENCE', 'WARRANTY', 'MARKETING', 'END_USER'],
      rin: 'see frontend/src/stages.js (getStageConfig("rin"))',
    },
  },
  {
    topic: 'automation_rules',
    keywords: ['automation', 'automations', 'automation rule', 'automation rules', 'automated rule', 'when a deal', 'when deal', 'when deals', 'when a task', 'if a deal', 'deal is idle', 'deals are idle', 'deal has been idle', 'deal hits', 'deal reaches', 'deal enters', 'automatically create', 'auto create', 'auto-create', 'automatically flag', 'automatically notify', 'stale deal alert', 'idle deal', 'idle deals', 'deal goes quiet', 'overdue task alert', 'follow-up task automatically', 'set up a rule', 'add a rule', 'create a rule', 'new rule', 'build an automation', 'workflow rule', 'trigger an action', 'when x then y'],
    synonyms: ['automation', 'automate', 'automated', 'automatically', 'rule', 'rules', 'trigger', 'triggers', 'workflow', 'workflows'],
    status: 'live',
    summary: 'No-code automation rules: WHEN a trigger fires (a deal reaches a stage / a deal is idle N days / a task is overdue) THEN run an action (create a follow-up task / notify the owner / flag the deal hot). Evaluated by the background automation engine, deduped per target.',
    where: '/admin/automation',
    gating: 'automation_enabled',
    how: 'Ask me in plain English — "when a deal moves to Closed Won, create a task \'Send welcome email\'" or "flag deals idle for 21 days as hot" — and I will propose it with propose_automation_rule (an org owner/admin clicks Apply). Or build it by hand at /admin/automation. Triggers today: deal_stage_is (needs a stage), deal_idle_days (needs days), task_overdue. Actions: create_task (title + priority), notify (in-app/email to the record owner), set_hot_flag (deal triggers only). Rules run on the automation scheduler (every few minutes in production) and never re-fire on the same record. This is NOT the plugins module — plugins (custom sandboxed code, off by default) are only needed for logic beyond these three triggers/actions. The built-in engine also runs stale-RFQ, hot-deal-gone-cold, expiring-quote, and renewal alerts automatically.',
  },
  {
    topic: 'saved_views',
    keywords: ['saved view', 'saved views', 'save this filter', 'save a filter', 'save my filter', 'save the filter', 'custom view', 'my view', 'view tab', 'filter tab', 'pinned filter', 'default view', 'share a view', 'shared view', 'saved filter', 'saved filters', 'create a view', 'new view', 'list view'],
    synonyms: ['view', 'views', 'tab', 'tabs', 'preset', 'presets', 'filter', 'filters'],
    status: 'live',
    summary: 'Saved views: named filter + sort presets rendered as tabs above the Companies, Contacts, Deals, and Tasks lists. Personal by default; the owner can share one with the whole org or make it their default tab.',
    where: '/deals',
    gating: null,
    how: 'Ask me — "save a view of hot deals over $50k called Big & Hot" or "make a shared contacts view for VPs" — and I will propose it with propose_saved_view (any member can apply their own views). Or on any list page, set your filters and click Save view. Views are yours to edit/delete; a shared view is read-only for everyone else. Filter keys are the same ones the list pages understand (deals: stage, phase, hot, search, amount_min/max, last_activity_window, overdue; contacts: status, search; companies: type, status, industry, search; tasks: bucket).',
  },

  // --------------------------------------------------------------------------
  // CORE CRM BASICS — so "how do I add a contact / create a task" gets a real
  // answer (and the propose_* tool) instead of an improvised one.
  // --------------------------------------------------------------------------
  {
    topic: 'tasks_basics',
    keywords: ['task', 'tasks', 'to-do', 'to do list', 'todo', 'reminder', 'reminders', 'recurring task', 'repeating task', 'due date', 'overdue tasks', 'assign a task', 'my tasks', 'follow-up task', 'follow up task', 'what is due', 'my day'],
    synonyms: ['task', 'tasks', 'todo', 'reminder', 'reminders', 'recurring'],
    status: 'live',
    summary: 'Tasks with due dates, priority, assignee, and optional deal/contact links; recurring tasks (daily/weekly/biweekly/monthly); overdue notifications; and My Day at /today for the "what is due now" view.',
    where: '/tasks',
    gating: null,
    how: 'Create tasks at /tasks (or from any deal/contact panel), set a due date + priority, assign a teammate, and optionally make it recurring. Overdue tasks trigger in-app notifications and show up in My Day (/today). Or just ask me — "create a task to call Beta tomorrow, high priority" — and I will propose it (propose_create_task); Apply creates it. "What is overdue?" gets you the live list.',
  },
  {
    topic: 'contacts_companies_basics',
    keywords: ['add a contact', 'add a company', 'add a person', 'new contact', 'new company', 'new customer', 'add a customer', 'create a contact', 'create a company', 'contact record', 'company record', 'link a contact to a company', 'duplicates', 'duplicate contacts', 'merge contacts', 'merge companies', 'account record', 'who is the contact'],
    synonyms: ['contact', 'contacts', 'company', 'companies', 'people', 'person', 'customer', 'customers'],
    status: 'live',
    summary: 'Companies (customers, vendors, partners) and the contacts who work there, with owners, statuses, custom fields, activity timelines, and duplicate detection + merge.',
    where: '/contacts',
    gating: null,
    how: 'Add people at /contacts and organizations at /companies (or ask me — "add Jane Doe at Acme as a contact" — and I will propose it with propose_upsert_contact / propose_upsert_company; Apply creates or updates the record). Link a contact to its company so deals, cases, and the Account 360 view roll up correctly. Find and merge duplicates at /duplicates. Import many at once at /import.',
  },
  {
    topic: 'deals_pipeline',
    keywords: ['create a deal', 'new deal', 'add a deal', 'opportunity', 'opportunities', 'deal board', 'pipeline view', 'move a deal', 'drag a deal', 'close a deal', 'won deal', 'lost deal', 'hot deal', 'flag hot', 'deal amount', 'close date'],
    synonyms: ['deal', 'opportunity', 'pipeline', 'kanban'],
    status: 'live',
    summary: 'Deals on a phase-tabbed Kanban pipeline (drag between stages), with amount, probability, expected close date, hot flag, owner, notes, linked company/contact, activities, and (per profile) quotes, POs, and shipments.',
    where: '/deals',
    gating: null,
    how: 'Work the board at /deals — drag a card to move its stage, open a card for the full panel. Or ask me: "move the Acme deal to negotiation", "flag the Beta deal hot", "what is the state of deal 42" — I read first, then propose the change (propose_update_deal) and you Apply. The stages themselves are editable by an owner/admin (see "pipeline_stages").',
  },

  // --------------------------------------------------------------------------
  // EXTERNAL SYNC — Drive / Outlook / Google Calendar. Flag-aware: how_do_i
  // callers annotate each entry with whether the org actually has it on.
  // --------------------------------------------------------------------------
  {
    topic: 'drive_intel',
    keywords: ['google drive', 'drive sync', 'drive intel', 'drive folder', 'documents from drive', 'link a drive folder', 'files from google', 'drive files on deals'],
    synonyms: ['drive'],
    status: 'config',
    summary: 'Google Drive deal intel: link a Drive folder to a deal, sync its files, and get Claude summaries of what the documents say (optional write-back of notes).',
    where: '/admin/feature-flags',
    gating: 'drive_intel_enabled',
    how: 'An org owner/admin enables drive_intel_enabled (and drive_intel_writeback_enabled if you want summaries written back to the deal). A super-admin sets the Google OAuth client at /admin/platform-integrations (no env vars needed). Then connect Google from a deal\'s Drive panel and pick the folder. Off by default; I can propose enabling the flag.',
  },
  {
    topic: 'outlook_m365',
    keywords: ['outlook', 'microsoft 365', 'm365', 'office 365', 'o365', 'exchange', 'outlook calendar', 'outlook mail', 'microsoft graph', 'msgraph', 'connect microsoft'],
    synonyms: ['microsoft'],
    status: 'config',
    summary: 'Microsoft 365 (Outlook) integration: per-org connect, periodic mail + calendar sync, and a per-deal "Outlook activity" panel.',
    where: '/admin/integrations',
    gating: 'outlook_mail_enabled',
    how: 'An org owner/admin enables outlook_mail_enabled and/or outlook_calendar_enabled (both off by default — I can propose that), then connects Microsoft 365 at /admin/integrations. The msgraph sync worker then pulls mail and calendar events per connected org, and each deal shows an Outlook activity section. Refresh tokens are stored encrypted (AES-256-GCM).',
  },
  {
    topic: 'google_calendar_sync',
    keywords: ['google calendar', 'gcal', 'calendar sync', 'sync my calendar', 'sync calendar', 'calendar integration', 'push meetings to my calendar', 'calendar events on deals'],
    synonyms: ['sync'],
    status: 'config',
    summary: 'Google Calendar sync: link calendar events to deals and run a periodic per-org calendar sync. Separate from the CRM\'s own in-app calendar/meetings.',
    where: '/admin/feature-flags',
    gating: 'calendar_enabled',
    how: 'An org owner/admin enables calendar_enabled (off by default — I can propose that), then connects Google from the Calendar page. The calendar sync worker keeps events current, and deals get a linked calendar event. Note: the in-app /calendar (meetings + agenda) works without any of this.',
  },

  // --------------------------------------------------------------------------
  // MODULES — the feature-flag surface itself.
  // --------------------------------------------------------------------------
  {
    topic: 'modules_feature_flags',
    keywords: ['module', 'modules', 'feature flag', 'feature flags', 'turn on', 'turn off', 'switch on', 'switch off', 'enable a module', 'disable a module', 'what can i add', 'add-ons', 'addons', 'which modules', 'what modules', 'what integrations', 'integrations', 'is it enabled', 'enabled for my org'],
    synonyms: ['module', 'modules', 'enable', 'enabled', 'disable', 'disabled', 'toggle', 'flag', 'flags'],
    status: 'live',
    summary: 'Every product module (quotes, products, leads, reports, customer success, campaigns, automation, AI, documents…) and integration (QuickBooks, webhooks, Drive, Gmail, Calendar, Outlook, enrichment, portal, SSO, plugins) is a per-org feature flag an owner/admin can switch on or off.',
    where: '/admin/feature-flags',
    gating: null,
    how: 'Ask me "what modules do I have on?" (list_modules shows the real effective status for your org) and "turn on the customer portal" — I will propose the flag change with propose_set_feature_flag; an org owner/admin clicks Apply. Or toggle by hand at /admin/feature-flags. Most modules default ON; the integrations (QuickBooks, webhooks, Drive, Gmail, Calendar, Outlook, enrichment, portal, SSO, plugins) default OFF.',
  },

  // --------------------------------------------------------------------------
  // Modules shipped in the July 2026 full-CRM wave (migrations 123-141). Keep
  // each "where" pointing at the real page in frontend/src/App.js and each
  // gating flag matching the requireFeature(...) mount in backend/index.js.
  // --------------------------------------------------------------------------
  {
    topic: 'leads',
    keywords: ['lead', 'leads', 'lead capture', 'lead form', 'convert a lead', 'qualify a lead', 'lead board', 'new lead', 'prospect intake'],
    status: 'live',
    summary: 'Lead board (new → working → qualified → converted / unqualified), public lead-capture forms with round-robin assignment, and one-click convert to contact + deal.',
    where: '/leads',
    gating: 'leads_enabled',
    how: 'Work leads at /leads. Build shareable capture forms (public URL /f/<token>) — submissions round-robin across your team. Converting a qualified lead creates the contact (and optionally a deal) in one transaction. I can also list leads by status or propose creating one right here in chat.',
  },
  {
    topic: 'support_cases',
    keywords: ['support case', 'cases', 'support ticket', 'ticket', 'sla', 'customer complaint', 'support request', 'service ticket'],
    status: 'live',
    summary: 'Customer support cases (open → pending → resolved → closed) with priority (low/normal/high/urgent) and SLA due dates, linked to companies/contacts and surfaced on the Account 360 timeline.',
    where: '/cases',
    gating: 'customer_success_enabled',
    how: 'Log and work cases at /cases. Set a priority and an SLA due date — breaches can trigger the case_sla_breach automation rule. I can list open cases (worst SLA first) or propose opening one from chat.',
  },
  {
    topic: 'meetings_calendar',
    keywords: ['meeting', 'meetings', 'calendar', 'schedule a meeting', 'agenda', 'book a meeting', 'upcoming meetings'],
    status: 'live',
    summary: 'In-app meetings plus a merged agenda (meetings + due tasks + logged meeting notes) on the Calendar page — no external account required.',
    where: '/calendar',
    gating: null,
    how: 'Create meetings at /calendar, optionally linked to a company, deal, or contact. This is the CRM\'s own calendar; live Google Calendar sync is a separate module (calendar_enabled), and Outlook/M365 sync has its own flags (outlook_mail_enabled / outlook_calendar_enabled).',
  },
  {
    topic: 'segments',
    keywords: ['segment', 'segments', 'bulk action', 'bulk update', 'cohort', 'customer list', 'filter group'],
    status: 'live',
    summary: 'Saved account/contact segments built from filter criteria, with bulk actions run against every member.',
    where: '/segments',
    gating: 'customer_success_enabled',
    how: 'Define a segment at /segments from filter criteria, then run bulk actions against its members.',
  },
  {
    topic: 'email_sequences',
    keywords: ['sequence', 'sequences', 'drip campaign', 'campaign', 'email series', 'nurture', 'enroll', 'automated emails'],
    status: 'config',
    summary: 'Multi-step email sequences: ordered steps with day delays; enrolled contacts receive each step when due (sent by the sequence worker).',
    where: '/sequences',
    gating: 'campaigns_enabled',
    how: 'Build sequences and enroll contacts at /sequences. NOTE: actual sending requires an email transport (Gmail app password or SendGrid) on the deployment — until then due steps are held (skipped: email_not_configured) and enrollments stay queued, so nothing is lost.',
  },
  {
    topic: 'surveys',
    keywords: ['survey', 'surveys', 'nps', 'csat', 'feedback form', 'customer feedback'],
    status: 'live',
    summary: 'NPS/CSAT surveys with public no-login response links; responses roll up per account for the customer-success surfaces.',
    where: '/surveys',
    gating: 'customer_success_enabled',
    how: 'Create a survey at /surveys and share its public link (/s/<token>). Responses are collected without a login and feed account health / CS reporting.',
  },
  {
    topic: 'playbooks',
    keywords: ['playbook', 'playbooks', 'onboarding checklist', 'success plan', 'runbook', 'qbr'],
    status: 'live',
    summary: 'Customer-success playbooks: reusable step checklists (onboarding, QBR, renewal prep) you run against an account and track to completion.',
    where: '/playbooks',
    gating: 'customer_success_enabled',
    how: 'Define playbook templates at /playbooks and launch a run against a company; each step is tracked to completion.',
  },
  {
    topic: 'winback',
    keywords: ['win-back', 'winback', 'win back', 'churn', 'churned', 're-engage', 'lost customer'],
    status: 'live',
    summary: 'Win-back board for churned customers: capture the churn reason/detail and work re-engagement from one place.',
    where: '/winback',
    gating: 'customer_success_enabled',
    how: 'Churned accounts land on /winback with their churn detail; work re-engagement from there. Retention analytics live in /reports and the lifecycle funnel.',
  },
  {
    topic: 'notifications',
    keywords: ['notification', 'notifications', 'bell', 'in-app alerts', 'notify me', 'notification center'],
    status: 'live',
    summary: 'In-app notification center (assignments, mentions, overdue nudges) plus per-channel notification preferences.',
    where: '/notifications',
    gating: null,
    how: 'Open /notifications (the bell icon) for your in-app feed. Email/SMS channel preferences live under /settings. If notifications seem missing, I can run a notification diagnostic in Debug mode.',
  },
  {
    topic: 'record_ownership',
    keywords: ['record owner', 'owner', 'assign to', 'my records', 'ownership', 'assigned to me', 'who owns'],
    status: 'live',
    summary: 'Companies, deals, contacts, leads, and cases carry an owner (owner_user_id); list pages support "my records" filtering.',
    where: null,
    gating: null,
    how: 'Set the owner on the record itself; use the owner / "my records" filters on the list pages to see just your book.',
  },
  {
    topic: 'tier_limits',
    keywords: ['tier limit', 'plan limit', 'usage limit', 'record limit', 'seat limit', 'record cap'],
    status: 'config',
    summary: 'Per-org record/seat tier limits exist in the schema (organizations.limits_tier) but are inert until an operator sets a tier on the org.',
    where: '/usage',
    gating: null,
    how: 'Nothing is capped by default. A super-admin sets limits_tier per org to activate caps. AI usage quotas are separate and already enforced per tier — check /usage for current consumption.',
  },
  {
    topic: 'customer_portal',
    keywords: ['customer portal', 'portal', 'client portal', 'share with customer', 'portal link', 'customer view'],
    status: 'config',
    summary: 'Read-only customer portal: mint a tokenized link a customer opens (no login) to see their own deals/documents overview — single-company scoped and revocable.',
    where: '/admin/feature-flags',
    gating: 'portal_enabled',
    how: 'An org admin enables the portal_enabled flag, then mints a portal token for a company (POST /api/portal). The customer opens /portal/<token> — read-only, scoped to that one company, revocable at any time.',
  },
];

// ---------------------------------------------------------------------------
// Matching. Phrase keywords are matched as stemmed token sequences so simple
// plurals/verb forms line up ("add a field" ⇔ "add fields"); single-word
// synonyms add a smaller weight so "column"/"property" lean toward custom
// fields without a phrase hit. Longer phrase = stronger signal, as before.
// ---------------------------------------------------------------------------
const SYNONYM_WEIGHT = 4;

function stem(word) {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('sses')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stemmedPhrase(text) {
  return normalize(text).split(' ').filter(Boolean).map(stem).join(' ');
}

function scoreCapability(cap, q, stemmedQ, tokenSet) {
  let score = 0;
  const matched = [];
  // Dedupe by stemmed form so "report" + "reports" (or a synonym that is also
  // a keyword) count once — otherwise plural/singular pairs double-score.
  const seen = new Set();
  for (const kw of cap.keywords || []) {
    const raw = kw.toLowerCase();
    const sk = stemmedPhrase(kw);
    if (seen.has(sk)) continue;
    if (q.includes(raw) || (sk && ` ${stemmedQ} `.includes(` ${sk} `))) {
      seen.add(sk);
      score += kw.length; // longer keyword = stronger signal
      matched.push(kw);
    }
  }
  for (const syn of cap.synonyms || []) {
    const st = stem(syn.toLowerCase());
    if (seen.has(st)) continue;
    if (tokenSet.has(st)) {
      seen.add(st);
      score += SYNONYM_WEIGHT;
      matched.push(syn);
    }
  }
  return { score, matched };
}

/**
 * Ranked capability matches for a question. Returns up to `limit` entries as
 * { capability, score, matched } with score > 0, best first. Ties break
 * toward the entry declared earlier (stable sort).
 */
function lookupAll(question, limit = 2) {
  if (!question || typeof question !== 'string') return [];
  const q = normalize(question);
  if (!q) return [];
  const stemmedQ = stemmedPhrase(question);
  const tokenSet = new Set(stemmedQ.split(' '));
  const scored = [];
  for (const cap of CAPABILITIES) {
    const { score, matched } = scoreCapability(cap, q, stemmedQ, tokenSet);
    if (score > 0) scored.push({ capability: cap, score, matched });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// Best-matching entry or null (back-compat signature).
function lookup(question) {
  const hits = lookupAll(question, 1);
  return hits.length ? hits[0].capability : null;
}

// ---------------------------------------------------------------------------
// NAVIGATION REGISTRY — every authenticated destination the copilot may open.
// `gating` mirrors the requireFeature(...) mount of the page's API (null =
// core). `aliases` are the plain-English names users say ("report builder",
// "modules", "flags"). Keep paths in lock-step with frontend/src/App.js.
// ---------------------------------------------------------------------------
const PAGES = [
  { key: 'chat',            path: '/chat',                 label: 'Open chat',                 aliases: ['copilot', 'assistant', 'home'] },
  { key: 'dashboard',       path: '/dashboard',            label: 'Open dashboard',            aliases: ['overview', 'metrics', 'kpis'] },
  { key: 'my_day',          path: '/today',                label: 'Open My Day',               aliases: ['today', 'my day', 'agenda for today', 'what is due today'] },
  { key: 'deals',           path: '/deals',                label: 'Open deals',                aliases: ['pipeline', 'kanban', 'deal board', 'opportunities'] },
  { key: 'pipeline_settings', path: '/settings/pipeline',  label: 'Open pipeline stages',      aliases: ['pipeline stages', 'edit stages', 'stage settings', 'deal stages', 'kanban columns'] },
  { key: 'hot_deals',       path: '/deals?hot=true',       label: 'Show hot deals',            aliases: ['hot pipeline'] },
  { key: 'pre_sale_deals',  path: '/deals?phase=pre_sale', label: 'Show pre-sale pipeline',    aliases: ['pre-sale', 'presale pipeline'] },
  { key: 'dormant_deals',   path: '/deals?last_activity_window=30d', label: 'Show dormant deals', aliases: ['stale deals', 'quiet deals', 'gone dark'] },
  { key: 'leads',           path: '/leads',                label: 'Open leads board',          aliases: ['lead board', 'prospects'], gating: 'leads_enabled' },
  { key: 'contacts',        path: '/contacts',             label: 'Open contacts',             aliases: ['people', 'persons'] },
  { key: 'companies',       path: '/companies',            label: 'Open companies',            aliases: ['organizations', 'orgs', 'customers', 'vendors'] },
  { key: 'duplicates',      path: '/duplicates',           label: 'Open duplicates',           aliases: ['merge duplicates', 'dedupe'] },
  { key: 'accounts',        path: '/accounts',             label: 'Open accounts',             aliases: ['account 360', 'account management', 'account health'], gating: 'customer_success_enabled' },
  { key: 'renewals',        path: '/renewals',             label: 'Open renewals',             aliases: ['renewal', 'upcoming renewals', 'service contracts renewals'], gating: 'customer_success_enabled' },
  { key: 'retention',       path: '/retention',            label: 'Open retention',            aliases: ['churn analytics', 'retention analytics'], gating: 'customer_success_enabled' },
  { key: 'lifecycle_funnel', path: '/lifecycle-funnel',    label: 'Open lifecycle funnel',     aliases: ['funnel', 'lifecycle'], gating: 'customer_success_enabled' },
  { key: 'cases',           path: '/cases',                label: 'Open cases',                aliases: ['support cases', 'tickets', 'support'], gating: 'customer_success_enabled' },
  { key: 'playbooks',       path: '/playbooks',            label: 'Open playbooks',            aliases: ['success playbooks', 'runbooks'], gating: 'customer_success_enabled' },
  { key: 'winback',         path: '/winback',              label: 'Open win-back',             aliases: ['win back', 'churned customers'], gating: 'customer_success_enabled' },
  { key: 'surveys',         path: '/surveys',              label: 'Open surveys',              aliases: ['nps', 'csat', 'feedback'], gating: 'customer_success_enabled' },
  { key: 'segments',        path: '/segments',             label: 'Open segments',             aliases: ['cohorts', 'bulk actions'], gating: 'customer_success_enabled' },
  { key: 'reports',         path: '/reports',              label: 'Open reports',              aliases: ['analytics', 'reporting'], gating: 'reports_enabled' },
  { key: 'report_builder',  path: '/reports/builder',      label: 'Open report builder',       aliases: ['build a report', 'custom report', 'custom reports', 'saved reports'], gating: 'reports_enabled' },
  { key: 'forecast',        path: '/forecast',             label: 'Open forecast',             aliases: ['forecasting', 'revenue forecast', 'weighted pipeline'], gating: 'reports_enabled' },
  { key: 'calendar',        path: '/calendar',             label: 'Open calendar',             aliases: ['meetings', 'agenda', 'schedule'] },
  { key: 'tasks',           path: '/tasks',                label: 'Open tasks',                aliases: ['to-dos', 'todos', 'my tasks', 'reminders'] },
  { key: 'overdue_tasks',   path: '/tasks?bucket=overdue', label: 'Show overdue tasks',        aliases: ['overdue', 'late tasks'] },
  { key: 'activities',      path: '/activities',           label: 'Open activities',           aliases: ['activity log', 'calls and emails', 'timeline'] },
  { key: 'notifications',   path: '/notifications',        label: 'Open notifications',        aliases: ['bell', 'alerts', 'notification center'] },
  { key: 'sequences',       path: '/sequences',            label: 'Open sequences',            aliases: ['email sequences', 'drip campaigns', 'campaigns', 'nurture'], gating: 'campaigns_enabled' },
  { key: 'quotes',          path: '/quotes',               label: 'Open quotes',               aliases: ['customer quotes', 'quote list'], gating: 'quotes_enabled' },
  { key: 'quote_builder',   path: '/quote-builder',        label: 'Open quote builder',        aliases: ['build a quote', 'cpq', 'sales quote'], gating: 'products_enabled' },
  { key: 'products',        path: '/products',             label: 'Open products',             aliases: ['product catalog', 'catalog', 'price list'], gating: 'products_enabled' },
  { key: 'issues',          path: '/issues',               label: 'Open issues',               aliases: ['blocking issues', 'issue tracker'] },
  { key: 'service_contracts', path: '/service-contracts',  label: 'Open service contracts',    aliases: ['contracts', 'maintenance contracts'] },
  { key: 'appreciation',    path: '/appreciation',         label: 'Open appreciation queue',   aliases: ['customer appreciation', 'thank-you queue'] },
  { key: 'import',          path: '/import',               label: 'Open import wizard',        aliases: ['csv import', 'import csv', 'upload spreadsheet', 'import data'] },
  { key: 'settings',        path: '/settings',             label: 'Open settings',             aliases: ['preferences', 'my settings', 'account settings'] },
  { key: 'privacy',         path: '/settings#privacy',     label: 'Open privacy settings',     aliases: ['export my data', 'delete my account', 'gdpr', 'your rights'] },
  { key: 'developer',       path: '/settings/developer',   label: 'Open developer settings',   aliases: ['api keys', 'personal access tokens', 'pat', 'webhooks out', 'outbound webhooks'] },
  { key: 'security',        path: '/security',             label: 'Open security',             aliases: ['2fa', 'two factor', 'password', 'mfa'] },
  { key: 'team',            path: '/team',                 label: 'Open team',                 aliases: ['members', 'invite', 'users', 'teammates', 'invite a user'] },
  { key: 'usage',           path: '/usage',                label: 'Open usage',                aliases: ['ai usage', 'tokens', 'quota', 'consumption'] },
  { key: 'plugins',         path: '/plugins',              label: 'Open plugins',              aliases: ['tools', 'my tools', 'custom tools'], gating: 'plugins_enabled' },
  { key: 'plugin_library',  path: '/plugins/library',      label: 'Open plugin library',       aliases: ['library', 'plugin templates', 'tool library'], gating: 'plugins_enabled' },
  { key: 'new_plugin',      path: '/plugins/new',          label: 'New plugin',                aliases: ['create a plugin', 'build a plugin', 'new tool'], gating: 'plugins_enabled' },
  { key: 'handoff',         path: '/handoff',              label: 'Open tech handoff',         aliases: ['technical docs', 'architecture', 'security posture', 'documentation'] },
  { key: 'modules',         path: '/admin/feature-flags',  label: 'Open modules',              aliases: ['feature flags', 'flags', 'module settings', 'enable modules', 'integrations toggles'] },
  { key: 'branding',        path: '/admin/branding',       label: 'Open branding',             aliases: ['white label', 'logo', 'brand', 'theme', 'colors'] },
  { key: 'custom_fields',   path: '/admin/customizations', label: 'Open custom fields',        aliases: ['customizations', 'customisations', 'fields', 'field definitions', 'properties'] },
  { key: 'automations',     path: '/admin/automation',     label: 'Open automations',          aliases: ['automation', 'automation rules', 'rules', 'triggers', 'workflows'], gating: 'automation_enabled' },
  { key: 'email_templates', path: '/admin/email-templates', label: 'Open email templates',     aliases: ['templates', 'email template'] },
  { key: 'integrations',    path: '/admin/integrations',   label: 'Open integrations',         aliases: ['quickbooks', 'outlook', 'microsoft 365', 'teams', 'zoom', 'connect an integration'] },
  { key: 'ai_model',        path: '/admin/ai-model',       label: 'Open AI model settings',    aliases: ['ai settings', 'model settings', 'which model', 'ai model'] },
  { key: 'admin',           path: '/admin',                label: 'Open admin',                aliases: ['admin panel', 'administration', 'admin home'] },
  { key: 'access_requests', path: '/admin/access-requests', label: 'Open access requests',     aliases: ['pending users', 'approve users', 'access request'] },
  { key: 'org_activity',    path: '/admin/activity',       label: 'Open org activity',         aliases: ['audit log', 'activity log admin', 'who did what'] },
  { key: 'pitch_readiness', path: '/admin/pitch-readiness', label: 'Open pitch readiness',     aliases: ['system health', 'readiness', 'demo readiness'] },
];

const PAGE_BY_KEY = new Map(PAGES.map((p) => [p.key, p]));

// Look up a registry entry by key. Throws on an unknown key so a typo in the
// chip map fails loudly at test time instead of shipping a dead chip.
function pageFor(key) {
  const p = PAGE_BY_KEY.get(key);
  if (!p) throw new Error(`Unknown page key: ${key}`);
  return p;
}

// Plain-English → registry entry. Accepts the key ("report_builder"), the
// label ("report builder"), a path ("/reports/builder"), or an alias. Exact
// matches win; otherwise the entry whose key/label/aliases share the most
// stemmed tokens with the query. Returns { page } or { page: null,
// suggestions: [...] } with the closest few labels so the copilot can ask.
function resolvePage(query) {
  const raw = normalize(query).replace(/^(open|go to|goto|show|show me|take me to|navigate to|the)\s+/g, '').replace(/\s+(page|screen|tab)$/, '').trim();
  if (!raw) return { page: null, suggestions: PAGES.slice(0, 5).map((p) => p.key) };
  const asKey = raw.replace(/[\s-]+/g, '_');
  if (PAGE_BY_KEY.has(asKey)) return { page: PAGE_BY_KEY.get(asKey) };
  const byPath = PAGES.find((p) => p.path === String(query || '').trim());
  if (byPath) return { page: byPath };

  const qTokens = new Set(stemmedPhrase(raw).split(' ').filter(Boolean));
  let best = null;
  let bestScore = 0;
  const scored = [];
  for (const p of PAGES) {
    const names = [p.key.replace(/_/g, ' '), p.label.replace(/^(open|show|new)\s+/i, ''), ...(p.aliases || [])];
    let score = 0;
    for (const n of names) {
      const sn = stemmedPhrase(n);
      if (!sn) continue;
      if (sn === stemmedPhrase(raw)) { score = Math.max(score, 100); continue; }
      if (` ${stemmedPhrase(raw)} `.includes(` ${sn} `)) { score = Math.max(score, 50 + sn.length); continue; }
      const nTokens = sn.split(' ');
      const overlap = nTokens.filter((t) => qTokens.has(t)).length;
      if (overlap > 0) score = Math.max(score, Math.round((overlap / nTokens.length) * 40));
    }
    if (score > 0) scored.push({ page: p, score });
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (best && bestScore >= 40) return { page: best };
  scored.sort((a, b) => b.score - a.score);
  return { page: null, suggestions: scored.slice(0, 5).map((s) => s.page.key) };
}

module.exports = { CAPABILITIES, lookup, lookupAll, normalize, PAGES, pageFor, resolvePage };
