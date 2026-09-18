// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// RecordMap — reusable map view for any record list carrying coordinates in
// custom_fields (gps_lat/gps_lng, with lat/lng as fallback — see
// utils/recordGeo.js). CMN_REQUIREMENTS 1.6: pins colored by stage/status,
// popup per pin, auto-fit bounds. OpenStreetMap tiles — no API key.
//
// ⚠️ This module imports leaflet + react-leaflet and their CSS. It must ONLY
// be imported via React.lazy (lazyWithRetry) so the map library stays out of
// the main bundle. Colored divIcon pins are used instead of leaflet's default
// marker PNGs — that both gives us per-stage colors and sidesteps the
// well-known bundler default-icon-path breakage entirely.

import React, { useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { mappablePoints, NEUTRAL_PIN_HEX } from '../utils/recordGeo';

// Teardrop pin as a divIcon — a rotated rounded square with a white ring.
// Cached per color so re-renders don't mint new icon objects.
const iconCache = new Map();
function pinIcon(color) {
  const c = color || NEUTRAL_PIN_HEX;
  if (!iconCache.has(c)) {
    iconCache.set(c, L.divIcon({
      className: '', // suppress leaflet's default white-box styling
      html:
        `<div style="width:22px;height:22px;background:${c};` +
        'border:2px solid #fff;border-radius:50% 50% 50% 0;' +
        'transform:rotate(-45deg);box-shadow:0 1px 4px rgba(0,0,0,.45);"></div>',
      iconSize: [22, 22],
      iconAnchor: [11, 22],
      popupAnchor: [0, -22],
    }));
  }
  return iconCache.get(c);
}

// Fit the viewport to the pins. Runs on mount and again whenever the SET of
// plotted records changes (filtering), not on every render — so a user who
// panned away isn't yanked back by an unrelated re-render. A single pin gets
// a sensible fixed zoom instead of leaflet's maxed-in fitBounds default.
function FitBounds({ points }) {
  const map = useMap();
  const key = useMemo(
    () => points.map(p => `${p.record?.id ?? ''}:${p.lat},${p.lng}`).sort().join('|'),
    [points]
  );
  const lastKey = useRef(null);
  useEffect(() => {
    if (!points.length || key === lastKey.current) return;
    lastKey.current = key;
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 13);
    } else {
      map.fitBounds(points.map(p => [p.lat, p.lng]), { padding: [40, 40], maxZoom: 15 });
    }
  }, [map, key, points]);
  return null;
}

/**
 * Props:
 *   records     — array of records (deals or companies); non-mappable ones
 *                 are filtered out here.
 *   config      — {
 *     getColor(record)     → CSS color for the pin (default: neutral gray),
 *     renderPopup(record)  → React node for the pin's popup,
 *   }
 *   className   — wrapper classes (defaults fill the parent).
 *
 * The wrapper creates its own stacking context (relative z-0) so leaflet's
 * internal z-indexes (up to ~700) can't float above the app's nav/modals.
 */
export default function RecordMap({ records, config = {}, className = '' }) {
  const { getColor, renderPopup } = config;
  const points = useMemo(() => mappablePoints(records), [records]);

  if (!points.length) {
    return (
      <div className={`flex items-center justify-center rounded-lg border border-dashed border-gray-300 bg-white text-sm text-gray-500 p-8 ${className}`}>
        No records with coordinates match the current filters.
      </div>
    );
  }

  const first = points[0];
  return (
    <div className={`relative z-0 rounded-lg overflow-hidden border border-gray-200 ${className}`}>
      <MapContainer
        center={[first.lat, first.lng]}
        zoom={13}
        scrollWheelZoom
        style={{ height: '100%', width: '100%', minHeight: '420px' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds points={points} />
        {points.map(({ record, lat, lng }) => (
          <Marker
            key={record.id ?? `${lat},${lng}`}
            position={[lat, lng]}
            icon={pinIcon(getColor ? getColor(record) : NEUTRAL_PIN_HEX)}
          >
            <Popup>
              {renderPopup ? renderPopup(record) : (
                <span className="font-medium">{record.title || record.name || `#${record.id}`}</span>
              )}
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
