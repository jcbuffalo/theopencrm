# Migrations Playbook — The Open CRM

**Audience:** the next engineer (human or LLM) writing a database migration for this codebase.
**Source of truth:** `backend/index.js` (the runner) and the migration files themselves in `backend/migrations/`.
**Related:** `DATA_MODEL.md` (table-level reference), `THREAT_MODEL.md` §6 (residual risks the schema layer carries).

This codebase currently has ~63 SQL migrations from `001_create_users.sql` through `078_backfill_email_verified.sql` (with a few numbered gaps reflecting deleted/reserved slots). Patterns vary across the history of the project — this doc captures the patterns we **keep**, and the patterns we **avoid**.

---

## 1. The auto-migration runner

Migrations execute on startup in `runMigrationsOnStartup()` at `backend/index.js:608-664`. The runner:

1. **Creates the `migrations` ledger table if missing** (`backend/index.js:614-621`) with columns `id`, `name UNIQUE`, `executed_at`.
2. **Reads `backend/migrations/`** and filters to files matching `/^\d+_.*\.sql$/`, sorted lexicographically (`backend/index.js:624-627`).
3. **For each file:** checks `migrations.name`. If present, skip. If absent, read the whole file, execute as a single `pool.query(sql)`, then insert the ledger row.
4. **Sends the file as one query** (`backend/index.js:649`). The `pg` driver handles multi-statement files; this is deliberate so `$$ … $$`-quoted PL/pgSQL function bodies and triggers survive (a naive split-on-`;` would mangle them).
5. **On failure**, logs the failure and **continues to the next migration** (`backend/index.js:655-657`). The ledger row is NOT inserted for the failed migration; it will be retried on the next process start.
6. **Only runs in production** — gated by `NODE_ENV === 'production'` (`backend/index.js:681`). In dev you run migrations manually (or your test harness does).

**Two consequences of the runner's design that you must remember:**

- **Order is by filename.** Use 3-digit zero-padded sequence numbers so `010` sorts before `100`.
- **Failures are partial-applied.** If your migration is N statements and statement 4 fails, statements 1–3 are committed *unless* you wrapped them in a `BEGIN; … COMMIT;` block. **Always wrap multi-statement migrations in a transaction** — see §4.

---

## 2. File naming and numbering

Format: `NNN_<short_name>.sql` where `NNN` is a 3-digit zero-padded integer.

```
037_zang_deal_lifecycle_fields.sql
068_saved_views_and_owners.sql
074_task_overdue_notified_at.sql
```

Rules:

- **Three digits, zero-padded.** Lexicographic sort = numeric sort.
- **Sequential, never reused.** If migration `077` exists in any deployed environment, do not write a new `077` even if a slot opens — that breaks the `migrations.name` ledger.
- **Numbered gaps are acceptable.** This repo has gaps (e.g. no `076` between `075` and `077`); they cause no harm.
- **`migrate.js` is a sibling file** in the same directory but is filtered out by the regex (`/^\d+_.*\.sql$/`). Don't rename it to start with digits.
- **Short, descriptive name.** Snake_case. Describes what changes, not why.

---

## 3. Idempotency is mandatory

Every migration **must be safe to re-run** even though the ledger should prevent that. Two reasons:

1. The ledger is not infallible — if an operator restores from a backup that predates the ledger insert, the migration runs again.
2. Half-failed migrations (statements committed before the failure point) get retried on the next process start, and the already-applied statements must no-op.

The patterns you will see throughout this codebase, in order of frequency:

- **`ADD COLUMN IF NOT EXISTS`** — see e.g. `backend/migrations/033_add_org_id_to_users_and_data.sql:1-9`, `backend/migrations/074_task_overdue_notified_at.sql:18-19`.
- **`CREATE TABLE IF NOT EXISTS`** — see `backend/migrations/068_saved_views_and_owners.sql:23` and almost every `create_*` migration.
- **`CREATE INDEX IF NOT EXISTS`** — uniformly used after migration ~030. See `backend/migrations/074_task_overdue_notified_at.sql:24-26`.
- **`INSERT … WHERE NOT EXISTS`** — for one-time backfills. See `backend/migrations/073_saved_views_sharing_and_legacy_backfill.sql:62-81`.
- **`DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT`** — for widening `CHECK` constraints. See `backend/migrations/069_plugin_runs_logs.sql:38-52`, `backend/migrations/075_plugin_runs_new_statuses.sql:22-44`, `backend/migrations/077_plugin_runs_task_budget_status.sql:18-41`.
- **`CREATE OR REPLACE FUNCTION`** for pg functions and triggers — see `backend/migrations/048_audit_log_immutability.sql:12-16`.
- **`DROP TRIGGER IF EXISTS` then `CREATE TRIGGER`** — see `backend/migrations/048_audit_log_immutability.sql:18-26`.

**Counter-example.** The earliest migrations (`001` through `030` roughly) used bare `CREATE INDEX` without `IF NOT EXISTS` — e.g. `backend/migrations/020_create_companies.sql:17-18` and `backend/migrations/010_create_contacts.sql:19-21`. Those work today only because the corresponding `CREATE TABLE IF NOT EXISTS` short-circuits when the table is already present and Postgres never reaches the `CREATE INDEX`. **Do not write new migrations this way.** Always use `IF NOT EXISTS`.

---

## 4. Wrapping in transactions

```sql
BEGIN;

ALTER TABLE foo ADD COLUMN IF NOT EXISTS bar TEXT;
CREATE INDEX IF NOT EXISTS idx_foo_bar ON foo(bar);

COMMIT;
```

Wrap **every multi-step migration** in `BEGIN; … COMMIT;`. See `069`, `070`, `073`, `074`, `075`, `077` for the pattern.

Single-statement migrations don't strictly need it but the convention is consistent.

**Testing for partial-apply safety:** comment out the `COMMIT` on a local copy and verify the SQL runs to the last statement without erroring; then run it again with the `COMMIT` restored against the same database. If the second run completes cleanly, your idempotency guards are correct.

**Note:** Postgres DDL is transactional (unlike MySQL), so wrapping `ALTER TABLE` in `BEGIN; … COMMIT;` is real protection — a failure at statement 4 of 6 reverts statements 1–3.

---

## 5. Common patterns (copy-pasteable)

### 5.1 Add a column

```sql
BEGIN;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS new_field VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_deals_new_field
  ON deals(new_field)
  WHERE new_field IS NOT NULL;  -- partial index if most rows will be NULL

COMMIT;
```

See `backend/migrations/074_task_overdue_notified_at.sql` for a clean exemplar.

### 5.2 Add a JSONB column with a defaulted shape + backfill existing rows

```sql
BEGIN;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS extras JSONB NOT NULL DEFAULT '{}'::jsonb;

-- GIN index for containment / key-existence queries.
CREATE INDEX IF NOT EXISTS idx_deals_extras_gin
  ON deals USING GIN (extras);

-- Backfill: if older rows somehow have NULL despite the DEFAULT (possible if
-- you set the DEFAULT after the column existed), heal them. WHERE clause
-- limits the write set; the no-op case is cheap.
UPDATE deals SET extras = '{}'::jsonb WHERE extras IS NULL;

COMMIT;
```

See `backend/migrations/070_org_field_definitions.sql:51-62` for the canonical "JSONB extension column + GIN index" pattern across companies/contacts/deals/tasks.

### 5.3 Widen a CHECK constraint

`ALTER TYPE … ADD VALUE` only works for enum types — the status columns in this codebase are `VARCHAR` with a `CHECK` constraint, so we drop and re-add:

```sql
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'plugin_runs_status_check'
  ) THEN
    ALTER TABLE plugin_runs DROP CONSTRAINT plugin_runs_status_check;
  END IF;
  ALTER TABLE plugin_runs
    ADD CONSTRAINT plugin_runs_status_check
    CHECK (status IN (
      'running', 'success', 'ok', 'error', 'timeout',
      'memory_exceeded', 'killed', 'quota_exceeded', 'rejected',
      'query_budget_exceeded', 'concurrent_limit_exceeded',
      'task_budget_exceeded'
    ));
END $$;

COMMIT;
```

The `DO` block guards the drop in case the constraint name has drifted across environments. Pattern is used in `backend/migrations/069_plugin_runs_logs.sql:38-52`, `backend/migrations/075_plugin_runs_new_statuses.sql:22-44`, and `backend/migrations/077_plugin_runs_task_budget_status.sql:18-41`.

**Important:** when you widen a CHECK, the application code that writes the new value usually ships in the same release. Deploy the migration first (auto-runs on startup), then the new app code can write the new value safely. If the app code ships first and the constraint hasn't been widened, the write fails with a CHECK violation.

### 5.4 Add a FK with cascade behavior

```sql
BEGIN;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_deals_owner_id ON deals(owner_id);

COMMIT;
```

Cascade choice:
- `ON DELETE CASCADE` for child rows the parent owns wholly (e.g. `org_id` references — when an org is deleted, its data is deleted; see `backend/migrations/033_add_org_id_to_users_and_data.sql:4-9`).
- `ON DELETE SET NULL` for soft ownership (a user leaves but their deals stay; see the `owner_id` columns added in `backend/migrations/068_saved_views_and_owners.sql:42-44`).

### 5.5 Add a GIN index for JSONB containment queries

```sql
CREATE INDEX IF NOT EXISTS idx_deals_custom_fields_gin
  ON deals USING GIN (custom_fields);
```

Default `jsonb_ops` supports `?`, `?|`, `?&`, `@>`. Switch to `jsonb_path_ops` (`USING GIN (col jsonb_path_ops)`) if you only query containment (`@>`) and want a smaller, faster index. See `backend/migrations/070_org_field_definitions.sql:56-62`.

### 5.6 Build-table-then-backfill-then-drop-legacy (dual-table coexistence)

When refactoring from `old_table` → `new_table`, do it across **three** migrations:

1. **Create the new table** with its full schema. Leave `old_table` untouched.
2. **Backfill** from `old_table` into `new_table` with an `INSERT … WHERE NOT EXISTS` guard so re-runs are no-ops, and update the app to read/write the new table. Leave `old_table` in place for a release as a safety net.
3. **Drop `old_table`** in a separate migration after prod confirms no clients read from it.

The canonical example in this repo is `saved_filters` → `saved_views`:

- `backend/migrations/068_saved_views_and_owners.sql:23-34` creates `saved_views`.
- `backend/migrations/073_saved_views_sharing_and_legacy_backfill.sql:62-81` backfills from `saved_filters` into `saved_views` using `NOT EXISTS` against `(user_id, resource='deals', name)` to avoid duplicates on re-runs.
- The legacy `saved_filters` table is **still not dropped** — the `-- TODO: drop saved_filters after verification` comment at `backend/migrations/073_saved_views_sharing_and_legacy_backfill.sql:83-86` flags the follow-up. (See §7 — this is one of our open footguns.)

### 5.7 Partial index pattern

```sql
CREATE INDEX IF NOT EXISTS idx_tasks_last_overdue_notified_at
  ON tasks(last_overdue_notified_at)
  WHERE last_overdue_notified_at IS NOT NULL;
```

Use partial indexes when **most rows have NULL** in the indexed column and your queries always filter on the non-NULL case. Index size scales with the number of indexed rows, not the table size — a `WHERE … IS NOT NULL` predicate is the most common one. Example: `backend/migrations/074_task_overdue_notified_at.sql:24-26`.

---

## 6. Anti-patterns

### 6.1 Don't `DROP COLUMN` in the same migration that reads from it elsewhere

If route code or another table still references the column at the moment the migration runs (startup), the SELECTs error during the gap between "migration ran" and "new app revision is live". **Separate into two releases:** release A removes all reads, release B's migration drops the column.

### 6.2 Don't `ALTER` an in-use enum type without `IF NOT EXISTS`

Postgres enum types have their own constraints. Adding a value:

```sql
-- Run OUTSIDE a transaction; ALTER TYPE … ADD VALUE doesn't work inside one
-- on older Postgres versions, and the value must be quoted.
ALTER TYPE my_enum ADD VALUE IF NOT EXISTS 'new_value';
```

This codebase **avoids enum types** and uses `VARCHAR` with `CHECK` constraints instead — see §5.3 — because the drop-and-recreate pattern is more flexible. If you find yourself reaching for `CREATE TYPE … AS ENUM`, reconsider.

### 6.3 Don't backfill millions of rows in a single transaction

A single `UPDATE deals SET … WHERE …` over 5M rows takes a long autovacuum-blocking lock and may exceed the Cloud SQL Auth Proxy migration timeout. Chunk it:

```sql
-- Chunked backfill: 10k rows per pass. Loop on the app side or run multiple
-- migrations in sequence.
UPDATE deals
   SET phase = 'pre_sale'
 WHERE phase IS NULL
   AND id BETWEEN 1 AND 10000;
```

For large tables, prefer a one-shot app-side script that pages by `id BETWEEN` ranges, *not* a migration. Migrations are for schema + light data; large backfills are app jobs.

### 6.4 Don't rely on column ordering

`SELECT *` plus column ordering is fragile across migrations that re-create tables. Always list columns explicitly in INSERT/SELECT.

### 6.5 Don't write a migration that fails idempotently with a "table already exists" error

If you write `CREATE TABLE foo (...)` without `IF NOT EXISTS` and the table exists, the migration errors, the runner skips inserting the ledger row, and the SAME migration retries on every subsequent startup, **failing every time**. Real migrations have shipped to prod with this footgun. Always `IF NOT EXISTS`.

---

## 7. Schema-change review checklist

Run through this 8-item gate **before opening a PR** that adds a migration:

1. **Does it run twice cleanly?** Apply it to a fresh database, then apply it again — the second pass must complete with zero errors and zero changes.
2. **Does it work with both an empty and a populated DB?** Backfills and `UPDATE … WHERE` clauses must produce sane results in both cases.
3. **Are downstream queries updated in the same PR?** Route handlers, list/get/update/delete code, and any explicit `SELECT col1, col2, …` lists.
4. **Is the column allowlist updated?** `routes/_bulkOps.js`, plugin SDK `READ_COLUMN_ALLOWLISTS` / `UPDATE_ALLOWLISTS` / `FILTER_ALLOWLISTS` (`backend/services/pluginSdk.js:80-127`), saved-views filter spec — every layer that exposes columns to user input must learn about the new column.
5. **Is `DATA_MODEL.md` updated in the same commit?** The data model doc is the human-readable schema reference; keep it in sync.
6. **Is there a follow-up `-- TODO: drop X after verification` comment** if you are doing a backwards-compatible refactor that leaves a legacy table or column in place? Example: `backend/migrations/073_saved_views_sharing_and_legacy_backfill.sql:83-86`.
7. **Will Cloud SQL Auth Proxy timeout this migration?** Long-running `UPDATE`s or `CREATE INDEX` on large tables can exceed the proxy's connection timeout. Use `CREATE INDEX CONCURRENTLY` for large tables (note: cannot be inside a transaction; runs outside `BEGIN; COMMIT;`).
8. **Does it need a new index for production query patterns?** Every `WHERE col = ?` that is added to a route handler needs a supporting index unless the column is already part of an existing index's prefix.

---

## 8. Specific footguns in this codebase

These are real warts that have caused or are likely to cause confusion. Read them before you write your migration.

### The 010↔021 duplicate `contacts` table

`backend/migrations/010_create_contacts.sql` and `backend/migrations/021_create_contacts.sql` both `CREATE TABLE IF NOT EXISTS contacts`. They define **different schemas**:

- `010` uses a plain `company VARCHAR(255)` text field and unique `(user_id, email)`.
- `021` introduces the `company_id INTEGER REFERENCES companies(id)` FK and AI fields (`ai_summary`, `ai_next_action`).

On a fresh DB, `010` runs first and creates the table; `021` finds the table already exists, the `IF NOT EXISTS` short-circuits, and the AI/FK columns are **never added**. Subsequent ALTER TABLE migrations (`033`, `035`, `068`, `070`) patch the table up to the current shape, but the implicit dependency on those later migrations is invisible from reading `021` alone.

**Lesson for new migrations:** if you need a *modified* shape of an existing table, write `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, not a second `CREATE TABLE`.

### `audit_log` is unpartitioned

The append-only `audit_log` table (immutability trigger in `backend/migrations/048_audit_log_immutability.sql`) grows linearly with platform activity and is never partitioned or archived. At current write rates the table is small; at scale this becomes a maintenance problem (vacuum cost, index bloat, query latency on `org_id`-filtered reads). The remediation is a partitioning migration by `created_at` or `org_id`. It is not on the immediate roadmap.

### `saved_filters` retired (resolved 2026-05-15 in migration 079)

Migration `068` introduced `saved_views`, migration `073` backfilled the legacy `saved_filters` rows into it and rewired `filterRoutes.js`, and migration `079` dropped the legacy table once verification (grep + tests + production observation) confirmed no remaining reads or writes. Use this build → backfill+rewire → verify → drop sequence as the canonical template for any future table replacement.

### Legacy EAV `custom_fields` table superseded by per-entity JSONB

Two systems share the name `custom_fields`:

- The **EAV table** created in `backend/migrations/022_create_custom_fields.sql` — one row per (object_type, object_id, field_name) tuple.
- The **per-entity JSONB columns** added in `backend/migrations/070_org_field_definitions.sql:51-54` to `companies`, `contacts`, `deals`, `tasks`.

The JSONB columns are the supported surface (and what the plugin SDK reads/writes). The EAV table is legacy and is not being maintained. New code must use the JSONB columns; new migrations that touch "custom fields" must update the JSONB columns and the `org_field_definitions` registry (`backend/migrations/070_org_field_definitions.sql:27-41`). The EAV table is not dropped because the prod data has never been verified to be migrated; treat it as cold storage.

### Plugin `status` CHECK constraint history

`plugin_runs.status` is a `VARCHAR` with a CHECK constraint that has been widened three times (migrations `069`, `075`, `077`) as new terminal states were added by `pluginRunner.js`. Every new terminal state needs a new widening migration. Skipping the migration causes the runner's `finalizeRun` to fail with a CHECK violation, leaving the run row stuck in `'running'`.

The current allowed set is documented in `backend/migrations/077_plugin_runs_task_budget_status.sql:26-40`. If you add a new status to `pluginRunner.js` (e.g. by extending the classifier at `backend/services/pluginRunner.js:575-603`), open a new migration that drops and re-adds `plugin_runs_status_check` including your new value.

### Migrations only run automatically in production

`backend/index.js:681` gates the auto-runner on `NODE_ENV === 'production'`. In local dev you must run migrations yourself (via `migrate.js` or a manual `psql -f`), or your tests must explicitly bootstrap the schema. Pushing a migration to main without testing it against the production-shape DB is a real risk — the production deploy is the *first* place the migration ever runs.
