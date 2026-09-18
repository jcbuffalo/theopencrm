# The Open CRM — Design System

Lightweight, refined, one product. Every page: `bg-gray-50` page → white cards with `shadow-card` → one `h1` + one primary CTA. Body copy 14px in tables, 15px prose on md+. No emoji in chrome — use `<Icon>`.

## Tokens (`tailwind.config.cjs`, `src/index.css`)

| Token | Value | Use |
|---|---|---|
| `bg-brand-blue` / `hover:bg-brand-blue-dark` | `#2076CD` / `#1B5FAD` | THE primary. `bg-blue-600` and `bg-primary-600` are legacy — rewrite them. |
| `success-*` `warning-*` `danger-*` `info-*` | emerald / amber / red / brand ramp | Semantic colours. Say `text-danger-600`, not `text-red-600`; `bg-warning-50`, not `bg-yellow-50`. |
| `rounded` (= `rounded-lg`, 8px) | `borderRadius.DEFAULT = 0.5rem` | Controls, cards, tables. `rounded-md` (6px) for dense/sm controls, `rounded-full` for pills. Don't use `rounded-xl`/`2xl` in chrome. |
| `shadow-card` | soft 1–3px | Resting surfaces (Card, DataTable, stat tiles). |
| `shadow-overlay` | deep, diffuse | Floating surfaces (Modal, Drawer, Menu). |
| Focus ring | 2px brand-blue via `focus-visible` | Set globally in `index.css`; controls add `focus:ring-2 focus:ring-brand-blue/20`. |
| Type | `h1` `text-2xl font-semibold tracking-tight` · Card title `text-base font-semibold` · body `text-sm` · table header `text-xs uppercase tracking-wider text-gray-500` | Unclassed body text is 15px on md+ (set on `<body>`, so rem-based spacing is untouched). |

## Primitives (`src/components/ui`, `import { … } from '../components/ui'`)

Each file has its API documented at the top. Summary:

```jsx
<Container size="wide">                       // <main>; default max-w-6xl · wide 7xl · narrow 3xl · full
  <PageHeader
    title="Companies" subtitle="…"
    primaryAction={{ label: 'New company', onClick }}          // exactly one; icon defaults to "plus"
    secondaryActions={[{ label: 'Import CSV', icon: 'upload', onClick }, …]}   // → "…" Menu (inline:true → ghost button)
    actions={<Input size="sm" leadingIcon="search" … />}     // free-form toolbar slot (filters, toggles)
    actionSize="sm" className="mb-3"                          // compact boards (Deals)
  />
  <div className="space-y-6">
    {error && <Alert tone="danger" onDismiss={…}>{error}</Alert>}   // info | success | warning | danger; title?, icon?, action?
    <Card padding="sm"><Input leadingIcon="search" … /><Select wrapperClassName="w-40">…</Select></Card>
    <DataTable columns={cols} data={rows} loading={loading} onEdit onDelete rowActions emptyState={{ icon: 'building', title, message, action }} />
  </div>
</Container>
```

- **Button** — `variant` primary | secondary | ghost | danger · `size` sm | md | lg · `icon` / `iconRight` (Icon name or node) · `loading` + `loadingLabel` · `as="a" href`.
- **Input / Select / Textarea** — `label`, `hint`, `error` (sets `aria-invalid` + `role=alert`), `size` sm | md, `leadingIcon` (Input), `options` (Select), `wrapperClassName` for width. All native props pass through. `controlClasses()` from `Field.js` for a one-off control.
- **Card** — `title`, `subtitle`, `actions`, `padding` md | sm | none, `as`. **CardSection** for divided settings blocks. Put a `DataTable flush` inside `<Card padding="none">`.
- **Modal / Drawer** — same API: `open`, `onClose`, `title`, `description`, `size` sm | md | lg | xl, `footer`, `initialFocusRef`, `closeOnBackdrop`. Escape, backdrop click, focus trap, scroll lock, focus restore, portal. Put a `<form id="x">` in the body and `<Button type="submit" form="x">` in the footer.
- **Tabs** — `items=[{ id, label, count?, hint?, disabled? }]`, `value`, `onChange`; brand-blue underline; arrow keys move + select.
- **Menu** — `items=[{ label, icon?, onClick, danger?, disabled? } | { type: 'divider' }]`, `label`, `trigger?`, `size`.
- **StatusBadge** — `tone` neutral | info | success | warning | error (alias danger) | accent, `label` (node ok), `size` sm | md.
- **EmptyState** — `icon` (Icon name → grey disc), `title`, `message`, `action`.
- **Spinner** (`size`, `label` → centred block) · **Skeleton** (`lines`, `barClassName`) — prefer Skeleton where the content shape is known.
- **Icon** — `<Icon name="plus" size={16} />`; names in `ICON_NAMES` (search, plus, x, check, check-circle, chevron-*, arrow-*, bell, sparkles, alert, alert-circle, info, trash, edit, external, upload, download, filter, more-horizontal, calendar, clock, mail, phone, user, users, building, briefcase, refresh, star, copy, lock, sun, trending-up, inbox, flame, chat, settings). Add a glyph = one line in `ICONS`.
- **DataTable** — `columns=[{ key, label, width?, align?, className?, render? }]`, `loading`, `density` default | compact, `flush`, `minWidth`, `rowKey`, `stickyHeader`, bulk-select (`selectedIds`/`onToggleRow`/`onToggleAll`), `rowActions`, `emptyState`. Actions column only renders when `onEdit`/`onDelete`/`rowActions` are given. Card-mode below `md`.

## Migration recipe (per page, ~30–60 min)

1. `import { Alert, Button, Card, Container, Input, PageHeader, Select, … } from '../components/ui'`.
2. Replace `<main className="max-w-… py-…">` with `<Container size="wide|default|narrow">`; wrap the body in `<div className="space-y-6">`.
3. Replace the `<h2 className="text-3xl…">` + button row with `<PageHeader>`: one `primaryAction`, utilities (Import/Export/Find duplicates/…) into `secondaryActions`, filters/toggles into `actions`.
4. Error banners → `<Alert tone="danger" onDismiss>`; flashes → `tone="success"`; "module is off" → `tone="warning" icon="lock" title=…`.
5. Filter bars → `<Card padding="sm">` + `Input leadingIcon="search"` / `Select` (`wrapperClassName` for widths); toggles → `Button variant={on ? 'primary' : 'secondary'} aria-pressed`.
6. Hand-rolled `<table>` → `DataTable` (`align: 'right'` for numbers, `flush` inside a Card). Loading → `loading` prop; empty → `emptyState`.
7. `fixed inset-0` overlays → `Modal` (or `Drawer` for detail panels); form inputs inside → `Input`/`Select`/`Textarea` with `label`.
8. Ad-hoc pills → `StatusBadge` with a small `*_TONE` map; ALL-CAPS eyebrow section headers → `Card title`/`subtitle`.
9. Emoji → `<Icon>`; `bg-blue-600`/`bg-primary-600` → `bg-brand-blue`; `focus:border-blue-500` → `focus:border-brand-blue`; `border-b-2 border-blue-600` → `border-brand-blue`; `red/green/amber/yellow-*` → `danger/success/warning-*`.
10. Keep inline cell editors (tiny native `<select>` in a table row) as compact native controls — the primitives' 32px minimum would double row height.

Verify: `npx vite build && npx vitest run`, then eyeball the page at 375px and 1280px.

- **Toast** (wave 2) — the one floating bottom-right notice: `tone` info | success | warning | danger, `title`, body children, `actions` (Buttons, right-aligned), `onDismiss` (corner ×), `position` bottom-right | bottom-center. `TierLimitToast`, `DuplicateWarningToast` and `BulkActionBar`'s result toast compose it; new toasts should too.

## Migrated (wave 1)

Companies · Contacts · Tasks · Accounts · Deals (header/toolbar/modal/tabs only — Kanban untouched) · Leads · Renewals · Reports · MyDay · Team · `DataTable`.

## Migrated (wave 2)

**Pages:** Settings (8-tab rail → `Tabs`; Legal tab mounts `LegalFooter`; Workspace hub links "Pipeline stages" → `/settings/pipeline`) · Usage (BYO-key + billing copy unchanged) · Dashboard (default layout capped at 5 widgets for non-advanced orgs; MyDay-style greeting) · Activities · Calendar · Notifications · SecuritySettings · DeveloperSettings · Cases · Sequences · Segments · Playbooks · Surveys · Forecast · ReportBuilder · AccountDetail · LifecycleFunnel · Retention (+ Win-back tab; `/winback` renders `<Retention initialTab="winback" />`) · ImportWizard · Duplicates · Appreciation · Quotes · QuoteBuilder · Products · Issues · ServiceContracts · Plugins · PluginNew · PluginLibrary · PluginDetail · PluginRuns · Admin hub + AdminAccessRequests · AdminActivity · AdminAiBilling · AdminAiModel · AdminAutomation · AdminBranding · AdminFeatureFlags · AdminIntegrations · AdminPlatformIntegrations · AdminProvisionOrg · AdminSso · AdminUsers · EmailTemplates · CustomFieldsAdmin · PitchReadiness · TechHandoff.

**Shared components:** `CompanyForm` · `ContactForm` · `DealFilters` · `SavedViewsTabs` · `BulkActionBar` · `EmailComposerModal` · `EnrichModal` · `TierLimitToast` · `DuplicateWarningToast` · `DriveConnectCard` · `GmailConnectCard` · `OutlookConnectCard` · `CalendarConnectCard`.

Guard: `src/pages/pages.smoke.test.jsx` renders a sample of migrated pages and asserts one `h1` + no emoji in chrome.

Deliberate exceptions: a few tables stay hand-rolled inside `Card padding="none"` where `DataTable`'s desktop + mobile DOM would double-match existing `getByText` specs (Segments members, AdminAiBilling); inline cell editors stay compact native controls per recipe step 10.

## Still to migrate

**Owned by other agents / other waves:** `Nav.js` + `nav/*`, `Chat.js`, `App.js`, `Landing.js`, `DealPanel.js` and the panels it composes (`CommissionSection`, `CustomFieldsSection`, `CommentThread`, `DocumentList`, `IntelSummaryPanel`, `GmailIntelPanel`, `OutlookIntelPanel`, `CalendarPanel`), `Deals.js` Kanban.

**Unclaimed pages:** VendorQuotes, Submittals, ChangeOrders, Documents, SalesQuotes, Pulse, Meetings, Account360, Commission, Checklist, Team invites, Login / AcceptInvite / RequestAccess / PendingApproval (public), SsoHandoff, CustomerPortal, LeadForm / SurveyResponse (public capture), Pitch*, Legal pages (Privacy / Terms / DataDeletion / LegalDoc), NotFound.

**Shared components still hand-rolled:** `CommandPalette`, `WelcomeCard`, `HeroPreview`, `DriveFolderPicker`, `GmailThreadPicker`, `SuggestedUpdatesPanel`, `AiBillingCard`, `DemoBanner`, `CookieBanner`.
