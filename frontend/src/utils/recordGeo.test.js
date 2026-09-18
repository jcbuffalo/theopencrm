// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import { describe, it, expect } from 'vitest';
import {
  extractLatLng,
  mappablePoints,
  hasMappableRecords,
  toneFromClasses,
  toneHex,
  dealPinColor,
  companyPinColor,
  TONE_HEX,
  NEUTRAL_PIN_HEX,
} from './recordGeo';

const rec = (cf) => ({ id: 1, custom_fields: cf });

describe('extractLatLng', () => {
  it('reads numeric gps_lat/gps_lng (the CMN seed convention)', () => {
    expect(extractLatLng(rec({ gps_lat: 39.74, gps_lng: -104.99 })))
      .toEqual({ lat: 39.74, lng: -104.99 });
  });

  it('coerces string coordinates', () => {
    expect(extractLatLng(rec({ gps_lat: '39.74', gps_lng: '-104.99' })))
      .toEqual({ lat: 39.74, lng: -104.99 });
  });

  it('falls back to lat/lng keys', () => {
    expect(extractLatLng(rec({ lat: 45.5, lng: -122.6 })))
      .toEqual({ lat: 45.5, lng: -122.6 });
  });

  it('prefers a complete gps_* pair over lat/lng', () => {
    expect(extractLatLng(rec({ gps_lat: 1, gps_lng: 2, lat: 3, lng: 4 })))
      .toEqual({ lat: 1, lng: 2 });
  });

  it('uses the fallback pair when the gps_* pair is incomplete', () => {
    expect(extractLatLng(rec({ gps_lat: 1, lat: 3, lng: 4 })))
      .toEqual({ lat: 3, lng: 4 });
  });

  it('accepts zero coordinates (equator / prime meridian are real places)', () => {
    expect(extractLatLng(rec({ gps_lat: 0, gps_lng: 0 }))).toEqual({ lat: 0, lng: 0 });
  });

  it('rejects records with no coordinates', () => {
    expect(extractLatLng(rec({}))).toBeNull();
    expect(extractLatLng(rec(null))).toBeNull();
    expect(extractLatLng(rec(undefined))).toBeNull();
    expect(extractLatLng({ id: 1 })).toBeNull();
    expect(extractLatLng(null)).toBeNull();
  });

  it('rejects a half pair', () => {
    expect(extractLatLng(rec({ gps_lat: 39.74 }))).toBeNull();
    expect(extractLatLng(rec({ gps_lng: -104.99 }))).toBeNull();
    expect(extractLatLng(rec({ lat: 45.5 }))).toBeNull();
  });

  it('rejects non-numeric junk', () => {
    expect(extractLatLng(rec({ gps_lat: 'abc', gps_lng: -104.99 }))).toBeNull();
    expect(extractLatLng(rec({ gps_lat: '', gps_lng: '' }))).toBeNull();
    expect(extractLatLng(rec({ gps_lat: true, gps_lng: false }))).toBeNull();
    expect(extractLatLng(rec({ gps_lat: NaN, gps_lng: 1 }))).toBeNull();
    expect(extractLatLng(rec({ gps_lat: null, gps_lng: null }))).toBeNull();
  });

  it('rejects out-of-range coordinates', () => {
    expect(extractLatLng(rec({ gps_lat: 91, gps_lng: 0 }))).toBeNull();
    expect(extractLatLng(rec({ gps_lat: -91, gps_lng: 0 }))).toBeNull();
    expect(extractLatLng(rec({ gps_lat: 0, gps_lng: 181 }))).toBeNull();
    expect(extractLatLng(rec({ gps_lat: 0, gps_lng: -181 }))).toBeNull();
  });

  it('bad gps_* range does not block the valid fallback pair', () => {
    expect(extractLatLng(rec({ gps_lat: 91, gps_lng: 0, lat: 45, lng: 45 })))
      .toEqual({ lat: 45, lng: 45 });
  });

  it('tolerates custom_fields arriving as a JSON string', () => {
    expect(extractLatLng(rec('{"gps_lat": 10, "gps_lng": 20}')))
      .toEqual({ lat: 10, lng: 20 });
    expect(extractLatLng(rec('not json'))).toBeNull();
  });

  it('rejects an array custom_fields', () => {
    expect(extractLatLng(rec([1, 2]))).toBeNull();
  });
});

describe('mappablePoints', () => {
  it('keeps only mappable records, paired with positions', () => {
    const a = { id: 1, custom_fields: { gps_lat: 1, gps_lng: 2 } };
    const b = { id: 2, custom_fields: {} };
    const c = { id: 3, custom_fields: { lat: '3', lng: '4' } };
    expect(mappablePoints([a, b, c])).toEqual([
      { record: a, lat: 1, lng: 2 },
      { record: c, lat: 3, lng: 4 },
    ]);
  });

  it('handles empty / missing input', () => {
    expect(mappablePoints([])).toEqual([]);
    expect(mappablePoints(null)).toEqual([]);
    expect(mappablePoints(undefined)).toEqual([]);
  });
});

describe('hasMappableRecords (map-toggle visibility rule)', () => {
  it('is false for empty lists and lists with no coordinates', () => {
    expect(hasMappableRecords([])).toBe(false);
    expect(hasMappableRecords(null)).toBe(false);
    expect(hasMappableRecords([rec({}), rec(null), { id: 9 }])).toBe(false);
  });

  it('is true as soon as one record has coordinates', () => {
    expect(hasMappableRecords([rec({}), rec({ gps_lat: 1, gps_lng: 1 })])).toBe(true);
  });
});

describe('pin colors', () => {
  it('toneFromClasses recovers the tone from stage-color class strings', () => {
    expect(toneFromClasses({ bg: 'bg-blue-50', header: 'bg-blue-100', border: 'border-blue-200' })).toBe('blue');
    // header wins over bg
    expect(toneFromClasses({ bg: 'bg-slate-50', header: 'bg-emerald-100' })).toBe('emerald');
    // falls back to bg when header is missing
    expect(toneFromClasses({ bg: 'bg-rose-50' })).toBe('rose');
    expect(toneFromClasses({ header: 'not-a-color' })).toBeNull();
    expect(toneFromClasses(null)).toBeNull();
  });

  it('toneHex maps tones to hex with a neutral fallback', () => {
    expect(toneHex('blue')).toBe(TONE_HEX.blue);
    expect(toneHex('nope')).toBe(NEUTRAL_PIN_HEX);
    expect(toneHex(undefined)).toBe(NEUTRAL_PIN_HEX);
  });

  it('dealPinColor resolves the stage tone through stageColors', () => {
    const stageColors = (id) => (id === 'qualified'
      ? { bg: 'bg-blue-50', header: 'bg-blue-100', border: 'border-blue-200' }
      : { bg: 'bg-gray-50', header: 'bg-gray-100', border: 'border-gray-200' });
    expect(dealPinColor({ stage: 'qualified' }, stageColors)).toBe(TONE_HEX.blue);
    expect(dealPinColor({ stage: 'other' }, stageColors)).toBe(TONE_HEX.gray);
    expect(dealPinColor({ stage: 'x' }, undefined)).toBe(NEUTRAL_PIN_HEX);
    expect(dealPinColor(null, stageColors)).toBe(NEUTRAL_PIN_HEX);
  });

  it('companyPinColor: health band beats lifecycle stage beats neutral', () => {
    expect(companyPinColor({ health_band: 'red', lifecycle_stage: 'active' })).toBe(TONE_HEX.red);
    expect(companyPinColor({ health: { band: 'green' } })).toBe(TONE_HEX.green);
    expect(companyPinColor({ lifecycle_stage: 'at_risk' })).toBe(TONE_HEX.amber);
    expect(companyPinColor({ lifecycle_stage: 'churned' })).toBe(TONE_HEX.red);
    expect(companyPinColor({ lifecycle_stage: 'prospect' })).toBe(TONE_HEX.blue);
    expect(companyPinColor({})).toBe(NEUTRAL_PIN_HEX);
    expect(companyPinColor(null)).toBe(NEUTRAL_PIN_HEX);
  });
});
