'use strict';
/**
 * scripts/audit-public-compliance-exposure.js
 *
 *   node scripts/audit-public-compliance-exposure.js
 *
 * READ-ONLY. Counts how many production documents carry seller regulatory
 * identifiers — KRA PIN, single business permit, BRS number — on collections
 * that `firestore.rules` exposes with `allow read: if true`.
 *
 * WHY
 * Shop Setup's legacy save wrote the whole of `storeData` into `sellers/{uid}`,
 * which is world-readable, so these identifiers have been public. The write path
 * is fixed (they now go to `shops/{id}/private/compliance`), but documents
 * already in the database still carry them. This measures that blast radius
 * before anyone decides what to do about it.
 *
 * IT WRITES NOTHING. No deletes, no patches, no migration. The remediation is a
 * separate, deliberate script — the point of this one is to replace a guess with
 * a number.
 *
 * VALUES ARE NEVER PRINTED. A tax identifier does not belong in a terminal
 * scrollback or a CI log any more than it belongs on a public document; only
 * counts, field names and document ids are reported.
 */

const https = require('https');
const { execSync } = require('child_process');

const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
const FS_HOST = 'firestore.googleapis.com';
const BASE = '/v1/projects/' + PROJECT + '/databases/(default)/documents';

/* Every spelling these identifiers have had across the form's revisions. */
const FIELDS = ['kraPin', 'sbpNumber', 'brsNumber', 'sbpNum', 'brsNum', 'kraPIN'];
/* Collections `firestore.rules` publishes with `allow read: if true`. */
const PUBLIC_COLLECTIONS = ['sellers', 'businesses', 'shops'];

const BUNDLED_PY = process.env.LOCALAPPDATA
  ? process.env.LOCALAPPDATA + '\\Google\\Cloud SDK\\google-cloud-sdk\\platform\\bundledpython\\python.exe'
  : null;

let _tok = null;
function token() {
  if (_tok) return _tok;
  if (process.env.GCLOUD_ACCESS_TOKEN) return (_tok = process.env.GCLOUD_ACCESS_TOKEN.trim());
  const env = Object.assign({}, process.env);
  if (BUNDLED_PY && !env.CLOUDSDK_PYTHON) env.CLOUDSDK_PYTHON = BUNDLED_PY;
  _tok = execSync('gcloud auth print-access-token',
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  return _tok;
}

function get(path) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      host: FS_HOST, path, method: 'GET',
      headers: { Authorization: 'Bearer ' + token(), 'x-goog-user-project': PROJECT },
    }, (res) => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  console.log('\n  PUBLIC COMPLIANCE EXPOSURE — read-only audit   project ' + PROJECT);
  console.log('  looking for: ' + FIELDS.join(', '));
  console.log('  in publicly-readable collections: ' + PUBLIC_COLLECTIONS.join(', ') + '\n');

  let grandTotal = 0;
  const affected = [];

  for (const coll of PUBLIC_COLLECTIONS) {
    let pageToken = '', scanned = 0, hits = 0;
    const perField = {};
    do {
      const res = await get(BASE + '/' + coll + '?pageSize=300' +
        (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''));
      if (res.status >= 400) {
        console.log('  ' + coll.padEnd(12) + ' ** could not read: HTTP ' + res.status + ' **');
        break;
      }
      const j = JSON.parse(res.body);
      for (const doc of (j.documents || [])) {
        scanned++;
        const f = doc.fields || {};
        /* A field counts as exposed when present and non-empty — an empty string
           is a leftover key, not a leaked identifier. */
        const found = FIELDS.filter(k => f[k] !== undefined &&
          !(f[k].stringValue !== undefined && f[k].stringValue === '') &&
          f[k].nullValue === undefined);
        if (found.length) {
          hits++;
          found.forEach(k => { perField[k] = (perField[k] || 0) + 1; });
          if (affected.length < 25) {
            affected.push(coll + '/' + doc.name.split('/').pop() + '  [' + found.join(', ') + ']');
          }
        }
      }
      pageToken = j.nextPageToken || '';
    } while (pageToken);

    grandTotal += hits;
    const detail = Object.keys(perField).length
      ? '   ' + Object.entries(perField).map(([k, v]) => k + '×' + v).join('  ')
      : '';
    console.log('  ' + coll.padEnd(12) + String(scanned).padStart(6) + ' scanned   ' +
      String(hits).padStart(5) + ' exposed' + detail);
  }

  console.log('\n  ── documents carrying a public regulatory identifier: ' + grandTotal + ' ──\n');
  if (affected.length) {
    console.log('  first ' + affected.length + ' (ids only — values deliberately not printed):');
    affected.forEach(a => console.log('    ' + a));
    console.log('');
  }
  if (grandTotal === 0) {
    console.log('  Nothing to remediate: no public document carries these fields.\n');
  } else {
    console.log('  Remediation is NOT performed by this script. A migration would move each\n' +
                '  value into shops/{shopId}/private/compliance and then delete the public\n' +
                '  copy — a deliberate, reviewed write against live seller data.\n');
  }
  process.exit(0);
})();
