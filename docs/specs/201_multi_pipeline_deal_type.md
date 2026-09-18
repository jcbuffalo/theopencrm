# Spec 201 — Multiple Pipelines per Org via `deal_type`

**Status:** SPEC (2026-09-14) · **Driven by:** `CMN_REQUIREMENTS.md` §1.1 + `RIN_REQUIREMENTS.md` §1.2–1.3
**Effort:** ~4 days · **Depends on:** migration 155 (per-org pipelines), `services/pipelines.js`, `utils/dealStages.js`

## Problem

An org can have exactly one effective pipeline (its edited `pipelines` row with
`is_default = TRUE`, else the profile default). Real orgs run more than one motion:
CMN needs a supply/site-acquisition pipeline and an advertiser sales pipeline; RIN needs
dealer-account and inspector-candidate pipelines. Today the only workarounds are one
merged stage list or two orgs — both bad.

## Design

A deal carries a `deal_type` (default `'default'`). Each deal type may have its own
pipeline row; types without one fall back to the org default pipeline, which falls back
to the profile default. Nothing changes for existing orgs/deals: every existing deal is
`'default'`, every existing pipeline row stays the default pipeline.

### Migration `156_deal_type_pipelines.sql` (idempotent, per playbook)

```sql
ALTER TABLE deals ADD COLUMN IF NOT EXISTS deal_type VARCHAR(40) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_deals_org_deal_type ON deals(org_id, deal_type);

ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS deal_type VARCHAR(40); -- NULL = org default pipeline
-- one pipeline per (org, type); the partial unique index tolerates the NULL default row
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipelines_org_deal_type
  ON pipelines(org_id, deal_type) WHERE deal_type IS NOT NULL;

COMMENT ON COLUMN deals.deal_type IS
  'Pipeline category. ''default'' = the org''s main pipeline. Tenant-extensible (application-validated): e.g. supply, candidate, partner.';
```

`deal_type` slug rules: same `SLUG_RE` as stage ids, lowercased, max 40. Reserved value:
`default`.

### `services/pipelines.js`

- `getEffectivePipeline(orgId, profile, { dealType })` — when `dealType` is set and not
  `'default'`, look up `pipelines WHERE org_id=$1 AND deal_type=$2` first; miss → the
  existing default-row → profile-default chain. Cache key becomes `orgId:dealType`
  (`bustCache(orgId)` clears all keys for the org — switch cache to a nested Map or
  prefix scan).
- `savePipeline(orgId, rawStages, userId, { moveDealsTo, name, dealType })` — upserts the
  `(org, dealType)` row; `dealCountsByStage` and `applyMoves` gain
  `AND deal_type = $type` (default row moves only `'default'` deals — **this is the
  behavior change to get right**: today's queries sweep all org deals).
- `resetPipeline(..., { dealType })` — deletes the type row (type deals fall back to the
  org default/profile pipeline; strays still resolved via `moveDealsTo`).
- New `listPipelines(orgId)` → `[{ deal_type: 'default', name, is_custom, stage_count }, ...]`.
- New `deleteDealType` guard: refuse to delete a type pipeline while deals of that type
  exist unless `moveDealsTo` (and optionally `retype_to`) provided.

### Routes

- `GET /api/pipelines` → unchanged shape for the default, plus `pipelines: [...]` list.
  `GET/PUT/POST-reset /api/pipelines?deal_type=supply` operate on that type. PUT with a
  NEW `deal_type` creates it (owner/admin only, same as today's editor perms).
- `routes/dealRoutes.js` — create/import/stage-PATCH resolve the pipeline with the deal's
  `deal_type` (from body on create, from the row on update) before
  `assertStage`/`resolveStageId`; `GET /api/deals?deal_type=` filter; `deal_type`
  changeable only together with a valid target stage (`PATCH { deal_type, stage }`).
- `routes/importRoutes.js` deals import: optional `deal_type` column, validated per-row
  against known org types (else 400 listing valid types).

### Frontend

- `stages.js`: `setCurrentOrgPipeline` holds a map keyed by deal_type
  (`/auth/me` → `org_pipelines: { default: {...}, supply: {...} }`; keep `org_pipeline`
  as the default for back-compat one release). `getStageConfig(profile, { dealType })`.
- Deals page: when >1 pipeline, a tab/switcher above the Kanban (persist last choice per
  user in localStorage); board, stage dropdowns, and bulk actions all resolve the active
  type's config. Deal create modal: type selector (hidden when only one type).
- `/settings/pipeline`: pipeline selector + "New pipeline" (name + deal_type slug +
  start-from template) + delete-with-retype flow.
- Dashboards/reports/forecast: default to `deal_type='default'` (existing numbers stay
  stable) with a filter param — audit `metrics`, `forecast`, `commission`, `retention`
  queries; anything computing win-rate/funnel must not mix types.

### Chat tools

- `propose_update_pipeline` + apply branch: optional `deal_type` (default `'default'`).
- `list_deals`/`propose_create_deal`/CSV-adjacent tools: accept + surface `deal_type`.
- `list_modules`/`how_do_i` copy updated.

### Tests (Vitest)

1. Effective-pipeline fallback chain (type row → default row → profile default).
2. savePipeline with dealType only moves that type's deals; default-row save doesn't
   touch typed deals.
3. Stage validation: a supply-stage id is rejected on a default-type deal and vice versa
   (custom pipelines on both).
4. deal create with unknown deal_type → 400; import row with bad type → row error.
5. Back-compat: org with only the pre-156 default row behaves byte-for-byte as today.

## Rollout

Ship dark: no UI change until an org creates a second pipeline. CMN org is the pilot
tenant; RIN seeds follow. Update `API.md`, `CHAT_TOOLS_REFERENCE.md`, CLAUDE.md pipeline
paragraph on merge.
