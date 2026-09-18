// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Database migration runner
// Handles SQL comment stripping and multi-statement files
// Based on tested patterns from pantryqueen

const fs = require('fs');
const path = require('path');
const pool = require('../db');

async function runMigrations() {
  try {
    // Create migrations table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Get list of migration files
    const migrationsDir = __dirname;
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.match(/^\d+[a-z]*_.*\.sql$/))
      .sort();

    console.log(`Found ${files.length} migration(s)`);

    // Run each migration
    for (const file of files) {
      const name = file;

      // Check if already executed
      const result = await pool.query(
        'SELECT * FROM migrations WHERE name = $1',
        [name]
      );

      if (result.rows.length > 0) {
        console.log(`✓ Already executed: ${name}`);
        continue;
      }

      console.log(`→ Running: ${name}`);

      try {
        // Send the whole file as one query (matches the production startup
        // runner in index.js). Naively stripping comments and splitting on
        // `;` mangles dollar-quoted PL/pgSQL bodies ($$ ... $$) that legitimately
        // contain semicolons, breaking any migration that defines a function
        // or trigger.
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await pool.query(sql);

        // Record migration as executed
        await pool.query(
          'INSERT INTO migrations (name) VALUES ($1)',
          [name]
        );

        console.log(`✓ Completed: ${name}`);
      } catch (error) {
        console.error(`✗ Failed: ${name}`);
        console.error(error.message);
        throw error;
      }
    }

    console.log('\n✓ All migrations completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

runMigrations();
