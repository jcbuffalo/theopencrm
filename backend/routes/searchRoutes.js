// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ companies: [], contacts: [], deals: [] });

  const [sf, sv] = qs(req);
  const like = `%${q}%`;

  try {
    const [companies, contacts, deals] = await Promise.all([
      pool.query(
        `SELECT id, name, type, industry FROM companies
         WHERE ${sf} = $1 AND (name ILIKE $2 OR industry ILIKE $2 OR website ILIKE $2)
         ORDER BY name LIMIT 8`,
        [sv, like]
      ),
      pool.query(
        `SELECT id, first_name, last_name, email, job_title FROM contacts
         WHERE ${sf} = $1 AND (first_name ILIKE $2 OR last_name ILIKE $2 OR email ILIKE $2)
         ORDER BY last_name LIMIT 8`,
        [sv, like]
      ),
      pool.query(
        `SELECT d.id, d.title, d.stage, d.amount, co.name AS company_name
         FROM deals d
         LEFT JOIN companies co ON d.company_id = co.id
         WHERE d.${sf} = $1 AND (d.title ILIKE $2 OR d.notes ILIKE $2)
         ORDER BY d.created_at DESC LIMIT 8`,
        [sv, like]
      ),
    ]);

    res.json({
      companies: companies.rows,
      contacts: contacts.rows,
      deals: deals.rows,
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;
