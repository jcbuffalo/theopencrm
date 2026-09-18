// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Pure geo helpers for the record map view (CMN_REQUIREMENTS 1.6).
//
// Geo convention: a record is "mappable" when its `custom_fields` JSONB
// carries a numeric `gps_lat` + `gps_lng` pair (the convention the CMN tenant
// seed uses for construction sites). `lat`/`lng` are accepted as fallback
// keys so orgs that named their fields the obvious way work too.
//
// Everything in this file is deliberately leaflet-free so it can be unit
// tested in jsdom without loading the map library (which is lazy-loaded and
// stays out of the main bundle).

// Coerce a candidate coordinate to a finite number, or NaN. Empty strings and
// booleans are rejected explicitly — Number('') === 0 and Number(true) === 1
// would otherwise fabricate a coordinate out of junk data.
function toCoord(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function validPair(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/**
 * Extract a { lat, lng } position from a record's custom_fields, or null when
 * the record isn't mappable. Prefers the `gps_lat`/`gps_lng` pair; falls back
 * to `lat`/`lng` only when the gps_* pair isn't a complete valid pair.
 * Tolerates custom_fields arriving as a JSON string (defensive — the API
 * serves JSONB as an object).
 */
export function extractLatLng(record) {
  if (!record) return null;
  let cf = record.custom_fields;
  if (typeof cf === 'string') {
    try { cf = JSON.parse(cf); } catch { return null; }
  }
  if (!cf || typeof cf !== 'object' || Array.isArray(cf)) return null;

  const gpsLat = toCoord(cf.gps_lat);
  const gpsLng = toCoord(cf.gps_lng);
  if (validPair(gpsLat, gpsLng)) return { lat: gpsLat, lng: gpsLng };

  const lat = toCoord(cf.lat);
  const lng = toCoord(cf.lng);
  if (validPair(lat, lng)) return { lat, lng };

  return null;
}

/**
 * Filter a record list down to the mappable ones, each paired with its
 * extracted position: [{ record, lat, lng }].
 */
export function mappablePoints(records) {
  const out = [];
  (records || []).forEach((record) => {
    const pos = extractLatLng(record);
    if (pos) out.push({ record, lat: pos.lat, lng: pos.lng });
  });
  return out;
}

/**
 * Toggle-visibility rule: the "Map" view toggle only appears when at least
 * one record in the current list carries coordinates.
 */
export function hasMappableRecords(records) {
  return (records || []).some((r) => extractLatLng(r) !== null);
}

// ---------------------------------------------------------------------------
// Pin colors. Stage configs expose Tailwind class strings (bg-blue-100 …),
// not raw colors — divIcon pins need actual CSS colors, so we parse the tone
// name back out of the classes and map it to the Tailwind 500 hex.
// Keep TONE_HEX aligned with the TONES palette in src/stages.js.
// ---------------------------------------------------------------------------

export const TONE_HEX = {
  slate: '#64748b', gray: '#6b7280', stone: '#78716c',
  red: '#ef4444', orange: '#f97316', amber: '#f59e0b', yellow: '#eab308',
  emerald: '#10b981', green: '#22c55e', cyan: '#06b6d4', blue: '#3b82f6',
  indigo: '#6366f1', violet: '#8b5cf6', purple: '#a855f7', rose: '#f43f5e',
};

export const NEUTRAL_PIN_HEX = TONE_HEX.gray;

/**
 * Recover the tone name ('blue', 'amber', …) from a stage-colors object as
 * returned by getStageConfig().stageColors(id) / toneClasses(tone) — e.g.
 * { bg: 'bg-blue-50', header: 'bg-blue-100', border: 'border-blue-200' }.
 * Returns null when nothing parseable is present.
 */
export function toneFromClasses(classes) {
  if (!classes || typeof classes !== 'object') return null;
  for (const key of ['header', 'bg', 'swatch']) {
    const m = /(?:^|\s)bg-([a-z]+)-\d+/.exec(classes[key] || '');
    if (m && TONE_HEX[m[1]]) return m[1];
  }
  return null;
}

/** Hex color for a tone name, falling back to neutral gray. */
export function toneHex(tone) {
  return TONE_HEX[tone] || NEUTRAL_PIN_HEX;
}

/**
 * Pin color for a deal: its stage tone, resolved through the org pipeline
 * config (`stageColors` from getStageConfig — works for both hardcoded
 * profile sets and custom per-org pipelines, which share the class shape).
 */
export function dealPinColor(deal, stageColors) {
  if (deal && typeof stageColors === 'function') {
    const tone = toneFromClasses(stageColors(deal.stage));
    if (tone) return toneHex(tone);
  }
  return NEUTRAL_PIN_HEX;
}

// Company pin colors: account-health band wins when present (it's the most
// operational signal), then lifecycle stage, else neutral.
const HEALTH_HEX = { green: TONE_HEX.green, yellow: TONE_HEX.yellow, red: TONE_HEX.red };
const LIFECYCLE_TONE = {
  prospect: 'blue', onboarding: 'cyan', active: 'green',
  at_risk: 'amber', renewed: 'emerald', churned: 'red',
};

export function companyPinColor(company) {
  if (!company) return NEUTRAL_PIN_HEX;
  const band = company.health_band || (company.health && company.health.band) || null;
  if (band && HEALTH_HEX[band]) return HEALTH_HEX[band];
  const tone = LIFECYCLE_TONE[company.lifecycle_stage];
  if (tone) return toneHex(tone);
  return NEUTRAL_PIN_HEX;
}
