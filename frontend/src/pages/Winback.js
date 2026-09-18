// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';
import Retention from './Retention';

// /winback — the churned-account win-back board now lives as the "Win-back"
// tab of the Retention & Expansion page. This route stays so existing links
// (nav, chat `open_page`, bookmarks) keep working; it simply preselects the tab.

export default function Winback() {
  return <Retention initialTab="winback" />;
}
