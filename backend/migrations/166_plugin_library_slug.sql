-- 166: track which curated library template a plugin was cloned from.
--
-- The extension library ("app store shelf") needs to show an Installed /
-- Enabled state per template for the caller's org. source_kind='library'
-- already marks a row as a clone, but not WHICH template it came from —
-- library_slug records the template's slug at install time.
--
-- Idempotent by construction (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT
-- EXISTS + guarded backfill) per the migration-runner hard-fail policy.

ALTER TABLE plugins ADD COLUMN IF NOT EXISTS library_slug VARCHAR(120);

-- The library page asks "which templates does org X have installed?" —
-- partial index keeps it cheap and skips the (vast majority) NULL rows.
CREATE INDEX IF NOT EXISTS idx_plugins_org_library_slug
  ON plugins (org_id, library_slug)
  WHERE library_slug IS NOT NULL;

-- Backfill pre-existing library clones. Every curated template to date used
-- spec.name === slug, and the clone path only ever suffixed collisions with
-- " (Draft)" / " (Draft N)" — strip that suffix to recover the slug. Guarded:
-- only rows that are (a) library clones and (b) not yet backfilled.
UPDATE plugins
   SET library_slug = REGEXP_REPLACE(name, ' \(Draft( \d+)?\)$', '')
 WHERE source_kind = 'library'
   AND library_slug IS NULL;
