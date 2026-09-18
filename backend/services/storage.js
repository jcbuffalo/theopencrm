// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Google Cloud Storage adapter for document attachments.
//
// Lazy-initialised so local/dev runs without GCS credentials still boot. The
// first call to upload/download triggers bucket access. The bucket is named
// per-project; if it does not exist we create it on first use.

const { Storage } = require('@google-cloud/storage');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ID = process.env.GCP_PROJECT_ID || 'xfte-platform';
const BUCKET_NAME = process.env.GCS_DOCUMENTS_BUCKET || `${PROJECT_ID}-zangflow-docs`;
const REGION = process.env.GCP_STORAGE_LOCATION || 'us-central1';

let storage = null;
let bucketReady = null; // Promise — caches the bucket-exists check

function getStorage() {
  if (!storage) {
    storage = new Storage({ projectId: PROJECT_ID });
  }
  return storage;
}

async function ensureBucket() {
  if (bucketReady) return bucketReady;
  bucketReady = (async () => {
    const s = getStorage();
    const bucket = s.bucket(BUCKET_NAME);
    const [exists] = await bucket.exists();
    if (!exists) {
      console.log(`Creating GCS bucket ${BUCKET_NAME} in ${REGION}…`);
      await s.createBucket(BUCKET_NAME, {
        location: REGION,
        storageClass: 'STANDARD',
        uniformBucketLevelAccess: true,
      });
      console.log(`✓ Bucket ${BUCKET_NAME} ready`);
    }
    return bucket;
  })().catch(err => {
    bucketReady = null; // allow retry on next call
    throw err;
  });
  return bucketReady;
}

function isConfigured() {
  // GCS works automatically when running on Cloud Run via the service account.
  // Locally it requires GOOGLE_APPLICATION_CREDENTIALS or `gcloud auth application-default login`.
  return true;
}

/**
 * Build a stable per-org object path:  org/<orgId>/<related>/<id>/<random>-<filename>
 */
function buildObjectPath({ orgId, relatedType, relatedId, filename }) {
  const safe = (s) => String(s || 'na').replace(/[^a-zA-Z0-9._-]/g, '_');
  const rand = crypto.randomBytes(6).toString('hex');
  const cleanName = path.basename(filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  return `org/${safe(orgId)}/${safe(relatedType)}/${safe(relatedId)}/${rand}-${cleanName}`;
}

async function uploadBuffer({ orgId, relatedType, relatedId, filename, buffer, mimeType }) {
  const bucket = await ensureBucket();
  const objectPath = buildObjectPath({ orgId, relatedType, relatedId, filename });
  const file = bucket.file(objectPath);
  await file.save(buffer, {
    contentType: mimeType || 'application/octet-stream',
    resumable: false,
    metadata: {
      cacheControl: 'private, max-age=0',
      metadata: {
        originalFilename: filename,
        relatedType: String(relatedType || ''),
        relatedId: String(relatedId || ''),
      },
    },
  });
  return { objectPath, bucket: BUCKET_NAME };
}

async function getSignedDownloadUrl(objectPath, { expiresInSeconds = 900, filename } = {}) {
  const bucket = await ensureBucket();
  const file = bucket.file(objectPath);
  const opts = {
    version: 'v4',
    action: 'read',
    expires: Date.now() + expiresInSeconds * 1000,
  };
  if (filename) {
    opts.responseDisposition = `attachment; filename="${filename.replace(/"/g, '')}"`;
  }
  const [url] = await file.getSignedUrl(opts);
  return url;
}

async function deleteObject(objectPath) {
  if (!objectPath) return;
  const bucket = await ensureBucket();
  await bucket.file(objectPath).delete({ ignoreNotFound: true });
}

async function downloadBuffer(objectPath) {
  const bucket = await ensureBucket();
  const [buffer] = await bucket.file(objectPath).download();
  return buffer;
}

module.exports = {
  isConfigured,
  uploadBuffer,
  getSignedDownloadUrl,
  deleteObject,
  downloadBuffer,
  BUCKET_NAME,
};
