#!/usr/bin/env node
/* Artifact Registry canary push — P0-7-OBS Option 2.
 *
 * Pushes ONE uniquely-named, inert artifact into gcf-artifacts using the Docker
 * Registry v2 HTTP API directly. No docker daemon, no GCF, no Cloud Run, no
 * Cloud Build — the deployment machinery is never invoked.
 *
 * Purpose (two separate questions):
 *   A. Does DATA_WRITE audit logging actually capture a registry write?
 *   B. Does a freshly pushed artifact subsequently disappear on its own?
 *
 * A surviving canary answers A and leaves B unreproduced. That is a valid
 * result, not a failure.
 *
 * SAFETY — enforced in code below, not merely promised:
 *   - the only repository path it will touch must contain CANARY_MARK
 *   - DELETE is never issued; the verb is not reachable from any code path
 *   - no existing image, tag, manifest or repository config is read-modify-written
 *   - refuses to overwrite: aborts if the tag already exists
 *
 * Usage: node scripts/infra/ar-canary-push.js <tag>
 */
'use strict';

const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HOST = 'us-central1-docker.pkg.dev';
const PROJECT = 'sokoni-aeb26';
const REPO = 'gcf-artifacts';
const CANARY_MARK = 'sokoni-ar-forensics-canary';
const IMAGE = CANARY_MARK;
const PATH_NS = `${PROJECT}/${REPO}/${IMAGE}`;

const TAG = process.argv[2];
if (!TAG || !/^[A-Za-z0-9._-]{1,120}$/.test(TAG)) {
  console.error('usage: node ar-canary-push.js <tag>   (tag required, [A-Za-z0-9._-])');
  process.exit(2);
}

/* ---- safety interlock ---------------------------------------------------- */
if (!PATH_NS.includes(CANARY_MARK)) {
  console.error('REFUSING: target path does not carry the canary marker.');
  process.exit(2);
}
const ALLOWED_VERBS = new Set(['GET', 'HEAD', 'POST', 'PUT']);

const SDK = 'C:/Users/USER1/AppData/Local/Google/Cloud SDK/google-cloud-sdk';
const WIN = process.platform === 'win32';
function token() {
  const out = WIN
    ? execFileSync(`${SDK}/platform/bundledpython/python.exe`,
      [`${SDK}/lib/gcloud.py`, 'auth', 'print-access-token'], { encoding: 'utf8' })
    : execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' });
  return out.trim();
}
const TOK = token();
const AUTH = 'Basic ' + Buffer.from('oauth2accesstoken:' + TOK).toString('base64');

function req(method, path, { headers = {}, body = null, host = HOST } = {}) {
  if (!ALLOWED_VERBS.has(method)) throw new Error(`REFUSING verb ${method}`);
  /* Two legitimate shapes. (1) the canary image namespace. (2) Artifact
     Registry's opaque blob-upload session, which it returns in Location and
     which carries no image name. The session is scoped to this repository and
     a blob only becomes part of an image when a manifest references it — and
     every manifest write IS canary-scoped by shape (1). So an upload session
     cannot modify an existing image. Anything else is refused. */
  const uploadSession = new RegExp(
    `^/artifacts-uploads/namespaces/${PROJECT}/repositories/${REPO}/uploads/`);
  if (!path.includes(CANARY_MARK) && !uploadSession.test(path)) {
    throw new Error(`REFUSING path outside the canary namespace: ${path}`);
  }
  return new Promise((res, rej) => {
    const r = https.request({ host, path, method,
      headers: { Authorization: AUTH, ...headers } }, (s) => {
      const chunks = [];
      s.on('data', (d) => chunks.push(d));
      s.on('end', () => res({ status: s.statusCode, headers: s.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', rej);
    if (body) r.write(body);
    r.end();
  });
}

const sha = (b) => 'sha256:' + crypto.createHash('sha256').update(b).digest('hex');

async function pushBlob(buf, label) {
  const digest = sha(buf);
  const head = await req('HEAD', `/v2/${PATH_NS}/blobs/${digest}`);
  if (head.status === 200) { console.log(`  ${label}: already present ${digest}`); return digest; }

  const start = await req('POST', `/v2/${PATH_NS}/blobs/uploads/`, { headers: { 'Content-Length': '0' } });
  if (start.status !== 202) throw new Error(`${label}: upload start failed ${start.status} ${start.body.toString().slice(0, 300)}`);
  let loc = start.headers.location;
  if (!loc) throw new Error(`${label}: no Location header`);
  if (loc.startsWith('https://')) loc = loc.replace(`https://${HOST}`, '');
  const sep = loc.includes('?') ? '&' : '?';

  const put = await req('PUT', `${loc}${sep}digest=${encodeURIComponent(digest)}`, {
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) },
    body: buf,
  });
  if (put.status !== 201) throw new Error(`${label}: blob PUT failed ${put.status} ${put.body.toString().slice(0, 300)}`);
  console.log(`  ${label}: pushed ${digest} (${buf.length} bytes)`);
  return digest;
}

(async () => {
  console.log(`=== CANARY PUSH -> ${HOST}/${PATH_NS}:${TAG} ===\n`);

  /* refuse to overwrite an existing tag */
  const exists = await req('GET', `/v2/${PATH_NS}/manifests/${TAG}`, {
    headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' } });
  if (exists.status === 200) {
    console.error('REFUSING: that tag already exists. This tool never overwrites.');
    process.exit(2);
  }

  /* inert content: an empty tar (two 512-byte zero blocks), gzipped */
  const tar = Buffer.alloc(1024, 0);
  const layer = zlib.gzipSync(tar);
  const diffId = sha(tar);

  const config = Buffer.from(JSON.stringify({
    architecture: 'amd64',
    os: 'linux',
    config: {},
    rootfs: { type: 'layers', diff_ids: [diffId] },
    history: [{
      created: new Date().toISOString(),
      created_by: 'SOKONI Artifact Registry forensics canary (P0-7-OBS). Inert. Not a function image. Safe to delete.',
    }],
  }));

  console.log('pushing blobs:');
  const layerDigest = await pushBlob(layer, 'layer ');
  const configDigest = await pushBlob(config, 'config');

  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: {
      mediaType: 'application/vnd.docker.container.image.v1+json',
      size: config.length, digest: configDigest,
    },
    layers: [{
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
      size: layer.length, digest: layerDigest,
    }],
  }));

  console.log('\npushing manifest:');
  const put = await req('PUT', `/v2/${PATH_NS}/manifests/${TAG}`, {
    headers: {
      'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json',
      'Content-Length': String(manifest.length),
    },
    body: manifest,
  });
  if (put.status !== 201) {
    console.error(`  manifest PUT FAILED ${put.status}: ${put.body.toString().slice(0, 500)}`);
    process.exit(1);
  }
  console.log(`  manifest pushed, status ${put.status}`);
  console.log(`  Docker-Content-Digest: ${put.headers['docker-content-digest'] || '(not returned)'}`);
  console.log(`\nCANARY: ${HOST}/${PATH_NS}:${TAG}`);
  console.log('Nothing else was created, modified or deleted.');
})().catch((e) => { console.error('PUSH FAILED: ' + e.message); process.exit(1); });
