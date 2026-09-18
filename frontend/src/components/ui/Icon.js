// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';

// Icon — a tiny inline-SVG set so chrome never needs an emoji glyph.
//
//   <Icon name="plus" size={16} />
//   <Icon name="alert" size={20} className="text-warning-600" />
//
// Every glyph is a 24x24 stroke path in `currentColor`, so it takes its
// colour from the surrounding text. Decorative by default (aria-hidden);
// pass `title` to make it announce. No external deps — adding a glyph is
// one line in ICONS below (Lucide-style path data).

export const ICONS = {
  search:            ['circle:11,11,7', 'M21 21l-4.35-4.35'],
  plus:              ['M12 5v14', 'M5 12h14'],
  minus:             ['M5 12h14'],
  x:                 ['M18 6L6 18', 'M6 6l12 12'],
  check:             ['M20 6L9 17l-5-5'],
  'check-circle':    ['M22 11.1V12a10 10 0 1 1-5.9-9.1', 'M22 4L12 14l-3-3'],
  'chevron-down':    ['M6 9l6 6 6-6'],
  'chevron-up':      ['M18 15l-6-6-6 6'],
  'chevron-right':   ['M9 6l6 6-6 6'],
  'chevron-left':    ['M15 6l-6 6 6 6'],
  'arrow-right':     ['M5 12h14', 'M12 5l7 7-7 7'],
  'arrow-left':      ['M19 12H5', 'M12 19l-7-7 7-7'],
  bell:              ['M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.7 21a2 2 0 0 1-3.4 0'],
  sparkles:          ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z', 'M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z', 'M5 2l.6 1.4L7 4l-1.4.6L5 6l-.6-1.4L3 4l1.4-.6z'],
  alert:             ['M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
  'alert-circle':    ['circle:12,12,10', 'M12 8v4', 'M12 16h.01'],
  info:              ['circle:12,12,10', 'M12 16v-4', 'M12 8h.01'],
  trash:             ['M3 6h18', 'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2', 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6', 'M10 11v6', 'M14 11v6'],
  edit:              ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  external:          ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14L21 3'],
  upload:            ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
  download:          ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  filter:            ['M22 3H2l8 9.5V19l4 2v-8.5z'],
  'more-horizontal': ['dot:5,12', 'dot:12,12', 'dot:19,12'],
  'more-vertical':   ['dot:12,5', 'dot:12,12', 'dot:12,19'],
  calendar:          ['rect:3,4,18,18', 'M16 2v4', 'M8 2v4', 'M3 10h18'],
  clock:             ['circle:12,12,10', 'M12 6v6l4 2'],
  mail:              ['rect:2,4,20,16', 'M22 6l-10 7L2 6'],
  phone:             ['M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.6a2 2 0 0 1-.5 2.1L8.1 9.7a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.8.3 1.7.6 2.6.7A2 2 0 0 1 22 16.9z'],
  user:              ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'circle:12,7,4'],
  users:             ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'circle:9,7,4', 'M23 21v-2a4 4 0 0 0-3-3.9', 'M16 3.1a4 4 0 0 1 0 7.8'],
  building:          ['rect:4,2,16,20', 'M9 22v-4h6v4', 'M8 6h.01', 'M16 6h.01', 'M8 10h.01', 'M16 10h.01', 'M8 14h.01', 'M16 14h.01'],
  briefcase:         ['rect:2,7,20,14', 'M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16'],
  refresh:           ['M21 12a9 9 0 1 1-2.6-6.4', 'M21 3v6h-6'],
  star:              ['M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z'],
  copy:              ['rect:9,9,13,13', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  lock:              ['rect:3,11,18,11', 'M7 11V7a5 5 0 0 1 10 0v4'],
  sun:               ['circle:12,12,4', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
  'trending-up':     ['M23 6l-9.5 9.5-5-5L1 18', 'M17 6h6v6'],
  inbox:             ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z'],
  flame:             ['M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-5 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.5-2.3 1-3a2.5 2.5 0 0 0 2.5 2.5z'],
  chat:              ['M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z'],
  settings:          ['circle:12,12,3', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
};

export const ICON_NAMES = Object.keys(ICONS);

function Shape({ d }) {
  if (d.startsWith('circle:')) {
    const [cx, cy, r] = d.slice(7).split(',').map(Number);
    return <circle cx={cx} cy={cy} r={r} />;
  }
  if (d.startsWith('dot:')) {
    const [cx, cy] = d.slice(4).split(',').map(Number);
    return <circle cx={cx} cy={cy} r={1.2} fill="currentColor" stroke="none" />;
  }
  if (d.startsWith('rect:')) {
    const [x, y, w, h] = d.slice(5).split(',').map(Number);
    return <rect x={x} y={y} width={w} height={h} rx={2} />;
  }
  return <path d={d} />;
}

export default function Icon({ name, size = 16, strokeWidth = 2, className = '', title, ...rest }) {
  const shapes = ICONS[name];
  if (!shapes) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`inline-block flex-shrink-0 ${className}`}
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
      focusable="false"
      data-icon={name}
      {...rest}
    >
      {title && <title>{title}</title>}
      {shapes.map((d, i) => <Shape key={i} d={d} />)}
    </svg>
  );
}
