// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Database connection pool setup
// Handles both local development and Cloud Run with Cloud SQL Unix socket

const { Pool } = require('pg');
require('dotenv').config();

console.log('🗄️  Initializing PostgreSQL connection...');
console.log(`   User: ${process.env.DB_USER}`);
console.log(`   Database: ${process.env.DB_NAME}`);
console.log(`   Password: ${process.env.DB_PASSWORD ? '***set***' : '(none)'}`);

const dbConfig = {
  user: process.env.DB_USER || 'postgres',
  database: process.env.DB_NAME || 'lightweight_crm',
  max: 20,
  idleTimeoutMillis: 30000,
  // 15s, not 5s: the 2026-09-22 review found every background worker
  // logging "Connection terminated due to connection timeout" in bursts
  // right after each cold start (a dozen workers' first ticks racing the
  // Cloud SQL socket in the first minute) and during idle CPU throttling.
  // A request that has to wait a few extra seconds for a pool slot beats
  // a worker tick that silently does nothing. statement_timeout below
  // still bounds the query itself.
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 15000,
  // Kill any single query that runs longer than 30s. Without this, one
  // pathological query (missing index, runaway join) holds a pool slot
  // indefinitely and starves the rest of the app.
  statement_timeout: 30000,
};

// Use password for all connections (Cloud SQL requires it even with Unix socket)
if (process.env.DB_PASSWORD) {
  dbConfig.password = process.env.DB_PASSWORD;
}

// Connection method depends on environment and INSTANCE_CONNECTION_NAME
if (process.env.INSTANCE_CONNECTION_NAME) {
  // Cloud SQL Unix socket (Cloud Run with Cloud SQL connector)
  // Format: /cloudsql/PROJECT:REGION:INSTANCE
  dbConfig.host = `/cloudsql/${process.env.INSTANCE_CONNECTION_NAME}`;
  console.log(`   Using Cloud SQL socket: ${dbConfig.host}`);
} else {
  // Local development via TCP
  dbConfig.host = process.env.DB_HOST || 'localhost';
  dbConfig.port = parseInt(process.env.DB_PORT) || 5432;
  console.log(`   Using TCP connection: ${dbConfig.host}:${dbConfig.port}`);
}

const pool = new Pool(dbConfig);

// Test connection immediately. Skipped under NODE_ENV=test so the unit-test
// suite doesn't attempt a real DB round-trip at require time.
if (process.env.NODE_ENV !== 'test') {
  pool.query('SELECT NOW()', (err, res) => {
    if (err) {
      console.error('❌ Database connection failed:', err.message);
    } else {
      console.log('✅ Database connection successful');
    }
  });
}

// Handle pool errors
pool.on('error', (err) => {
  console.error('❌ Database error:', err.message);
});

// Graceful shutdown
process.on('SIGINT', () => {
  pool.end(() => {
    console.log('Pool has ended');
    process.exit(0);
  });
});

module.exports = pool;
