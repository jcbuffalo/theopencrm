// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Drive Intel — sync orchestrator tests.
//
// We exercise driveSync at three layers:
//
//   1. diff()       — pure function, no DB / network.
//   2. sha256()     — deterministic hashing.
//   3. sync()       — orchestrator with mocked pool + drive + extractor.
//
// We avoid vi.mock factories (which hoist above our top-level requires
// in ways that interact badly with the existing module shape) and instead
// patch the real module exports — the same pattern used in
// test/notification-dispatcher.test.js + test/ai-chat.test.js.

// describe / test / expect / beforeEach / vi are global.

// Pre-stub googleapis.drive so even if drive.js is loaded for any reason
// it can't hit the network. We never actually call into it because the
// driveSync mock layer below shortcuts before getDriveClient runs, but
// belt-and-braces.
vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: class { setCredentials() {} } },
    drive: () => ({
      files: {
        list:   () => Promise.resolve({ data: { files: [] } }),
        get:    () => Promise.resolve({ data: {} }),
        export: () => Promise.resolve({ data: '' }),
      },
    }),
  },
}));

// Patch the live pool instance — same pattern as auth.test.js / ai-chat.test.js.
const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info:   vi.fn(),
  warn:   vi.fn(),
  error:  vi.fn(),
  notice: vi.fn(),
  debug:  vi.fn(),
}));

// Patch services/drive + services/driveExtract by overwriting their
// exports with vi.fn handles. driveSync imports them via require, so
// mutating the live module objects propagates to it.
const drive   = require('../services/drive');
const extract = require('../services/driveExtract');
drive.isConfigured     = vi.fn(() => true);
drive.listFolderFiles  = vi.fn();
drive.downloadFileText = vi.fn();
extract.extractText    = vi.fn();

const driveSync = require('../services/driveSync');

beforeEach(() => {
  mockPool.query.mockReset();
  drive.listFolderFiles.mockReset();
  drive.downloadFileText.mockReset();
  extract.extractText.mockReset();
});

// ============================================================================
// diff()
// ============================================================================

describe('driveSync.diff', () => {
  test('marks brand-new files as toFetch (reason=new)', () => {
    const listed = [
      { id: 'F1', mimeType: 'text/plain', size: 100, modifiedTime: '2026-05-01T00:00:00Z' },
    ];
    const existing = [];
    const out = driveSync.diff(listed, existing);
    expect(out.toFetch).toHaveLength(1);
    expect(out.toFetch[0].reason).toBe('new');
    expect(out.unchanged).toEqual([]);
  });

  test('marks unchanged when extraction_status=done and modifiedTime not advanced', () => {
    const listed = [
      { id: 'F1', mimeType: 'text/plain', size: 10, modifiedTime: '2026-05-01T00:00:00Z' },
    ];
    const existing = [
      {
        drive_file_id: 'F1',
        drive_modified_at: '2026-05-01T00:00:00Z',
        content_hash: 'abc',
        extraction_status: 'done',
      },
    ];
    const out = driveSync.diff(listed, existing);
    expect(out.toFetch).toHaveLength(0);
    expect(out.unchanged).toHaveLength(1);
  });

  test('marks modified when drive modifiedTime is newer', () => {
    const listed = [
      { id: 'F1', mimeType: 'text/plain', size: 10, modifiedTime: '2026-05-10T00:00:00Z' },
    ];
    const existing = [
      {
        drive_file_id: 'F1',
        drive_modified_at: '2026-05-01T00:00:00Z',
        content_hash: 'abc',
        extraction_status: 'done',
      },
    ];
    const out = driveSync.diff(listed, existing);
    expect(out.toFetch).toHaveLength(1);
    expect(out.toFetch[0].reason).toBe('modified');
  });

  test('retries a pending row even when timestamp matches', () => {
    const listed = [
      { id: 'F1', mimeType: 'text/plain', size: 10, modifiedTime: '2026-05-01T00:00:00Z' },
    ];
    const existing = [
      {
        drive_file_id: 'F1',
        drive_modified_at: '2026-05-01T00:00:00Z',
        content_hash: null,
        extraction_status: 'pending',
      },
    ];
    const out = driveSync.diff(listed, existing);
    expect(out.toFetch).toHaveLength(1);
    expect(out.toFetch[0].reason).toBe('retry_pending');
  });
});

// ============================================================================
// sha256()
// ============================================================================

describe('driveSync.sha256', () => {
  test('is deterministic for identical input', () => {
    const a = driveSync.sha256('hello world');
    const b = driveSync.sha256('hello world');
    expect(a).toBe(b);
    expect(a).toHaveLength(64); // hex sha256
  });
  test('differs for different inputs', () => {
    expect(driveSync.sha256('a')).not.toBe(driveSync.sha256('b'));
  });
});

// ============================================================================
// sync() — orchestrator end-to-end with mocks
// ============================================================================

describe('driveSync.sync — orchestrator', () => {
  function scriptQueries(responses) {
    mockPool.query.mockImplementation(() => {
      const next = responses.shift();
      if (!next) return Promise.resolve({ rows: [], rowCount: 0 });
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    });
  }

  test('throws FOLDER_LINK_NOT_FOUND when the link is missing', async () => {
    scriptQueries([{ rows: [] }]);
    await expect(
      driveSync.sync({ orgId: 1, dealId: 10, folderLinkId: 99 })
    ).rejects.toMatchObject({ code: 'FOLDER_LINK_NOT_FOUND' });
  });

  test('downloads + extracts a new file and upserts it', async () => {
    scriptQueries([
      // 1) link row
      { rows: [{ id: 99, org_id: 1, deal_id: 10, drive_folder_id: 'FLD', folder_name: 'F' }] },
      // 2) mark in_progress
      { rows: [] },
      // 3) existing drive_files
      { rows: [] },
      // 4) upsert insert
      { rows: [] },
      // 5) count done
      { rows: [{ c: 1 }] },
      // 6) stamp last_sync_*
      { rows: [] },
    ]);

    drive.listFolderFiles.mockResolvedValue([
      { id: 'F1', name: 'a.txt', mimeType: 'text/plain', size: 10, modifiedTime: '2026-05-01T00:00:00Z' },
    ]);
    drive.downloadFileText.mockResolvedValue({
      mimeType: 'text/plain', sizeBytes: 10, buffer: Buffer.from('hello'), isGoogleExport: false,
    });
    extract.extractText.mockResolvedValue({ status: 'done', text: 'hello', error: null });

    const out = await driveSync.sync({ orgId: 1, dealId: 10, folderLinkId: 99 });
    expect(out.synced).toBe(1);
    expect(out.skipped).toBe(0);
    expect(out.errors).toEqual([]);
    expect(extract.extractText).toHaveBeenCalled();
  });

  test('skips files larger than the size cap without downloading', async () => {
    // Bigger than default 10MB.
    const huge = 20 * 1024 * 1024;
    scriptQueries([
      { rows: [{ id: 99, org_id: 1, deal_id: 10, drive_folder_id: 'FLD', folder_name: 'F' }] },
      { rows: [] },
      { rows: [] },
      { rows: [] }, // upsert skipped row
      { rows: [{ c: 0 }] },
      { rows: [] },
    ]);

    drive.listFolderFiles.mockResolvedValue([
      { id: 'F1', name: 'huge.bin', mimeType: 'application/octet-stream', size: huge, modifiedTime: '2026-05-01T00:00:00Z' },
    ]);

    const out = await driveSync.sync({ orgId: 1, dealId: 10, folderLinkId: 99 });
    expect(out.synced).toBe(0);
    expect(out.skipped).toBe(1);
    expect(drive.downloadFileText).not.toHaveBeenCalled();
  });

  test('records a row as failed when extraction throws', async () => {
    scriptQueries([
      { rows: [{ id: 99, org_id: 1, deal_id: 10, drive_folder_id: 'FLD', folder_name: 'F' }] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [{ c: 0 }] },
      { rows: [] },
    ]);
    drive.listFolderFiles.mockResolvedValue([
      { id: 'F1', name: 'corrupt.pdf', mimeType: 'application/pdf', size: 100, modifiedTime: '2026-05-01T00:00:00Z' },
    ]);
    drive.downloadFileText.mockResolvedValue({
      mimeType: 'application/pdf', sizeBytes: 100, buffer: Buffer.alloc(100), isGoogleExport: false,
    });
    extract.extractText.mockResolvedValue({ status: 'failed', text: null, error: 'bad pdf' });

    const out = await driveSync.sync({ orgId: 1, dealId: 10, folderLinkId: 99 });
    expect(out.synced).toBe(0);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({ drive_file_id: 'F1', error: 'bad pdf' });
  });

  test('is idempotent — unchanged file is not re-extracted', async () => {
    scriptQueries([
      { rows: [{ id: 99, org_id: 1, deal_id: 10, drive_folder_id: 'FLD', folder_name: 'F' }] },
      { rows: [] },
      // existing rows: same modified time, status done
      { rows: [{
        drive_file_id: 'F1',
        drive_modified_at: '2026-05-01T00:00:00Z',
        content_hash: 'old-hash',
        extraction_status: 'done',
      }] },
      { rows: [{ c: 1 }] },
      { rows: [] },
    ]);
    drive.listFolderFiles.mockResolvedValue([
      { id: 'F1', name: 'a.txt', mimeType: 'text/plain', size: 10, modifiedTime: '2026-05-01T00:00:00Z' },
    ]);

    const out = await driveSync.sync({ orgId: 1, dealId: 10, folderLinkId: 99 });
    expect(out.synced).toBe(0);
    expect(out.skipped).toBe(0);
    expect(out.errors).toHaveLength(0);
    expect(drive.downloadFileText).not.toHaveBeenCalled();
    expect(extract.extractText).not.toHaveBeenCalled();
  });
});
