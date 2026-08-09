#!/usr/bin/env node
'use strict';

/**
 * fix-callable-invokers.js — grant `allUsers` the `roles/run.invoker` binding on a
 * v2 callable's backing Cloud Run service, so the browser can REACH it.
 *
 *   node scripts/fix-callable-invokers.js adminprocesspayout refundtowallet
 *
 * The COMPANION to audit-callable-invokers.js. The audit finds callables that
 * return an HTML 403 (Cloud Run IAM rejecting the request before the container) —
 * a bare "internal" in the browser. This applies the exact binding every working
 * callable already has. `firebase deploy` does NOT reconcile this on an update, and
 * the `invoker:'public'` option was not honoured either, so it must be set directly.
 *
 * Security note: allUsers invoker is NOT a security relaxation — the callable's real
 * boundary is `request.auth` + App Check, enforced INSIDE the function. This only
 * lets the request reach that check, identical to adminOsDispatch/createCheckoutSession.
 *
 * Auth: mints a token from the Firebase CLI credential (same as the audit script).
 * Read-modify-write with the policy etag so other bindings are preserved.
 *
 * Service names are the LOWERCASE Cloud Run service names (camelCase silently
 * targets nothing — audit-callable-invokers.js prints the correct ones).
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT = 'sokoni-aeb26';
const REGION = 'us-central1';
const TARGETS = process.argv.slice(2).filter((a) => !a.startsWith('--'));

if (!TARGETS.length) {
  console.error('usage: node scripts/fix-callable-invokers.js <service> [<service>...]  (lowercase Cloud Run service names)');
  process.exit(1);
}

function token() {
  const cfg = path.join(process.env.USERPROFILE || process.env.HOME, '.config', 'configstore', 'firebase-tools.json');
  const rt = JSON.parse(fs.readFileSync(cfg, 'utf8')).tokens.refresh_token;
  const body = new URLSearchParams({
    client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
    client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    refresh_token: rt, grant_type: 'refresh_token',
  }).toString();
  const at = JSON.parse(execSync(`curl -s -X POST -d "${body}" https://oauth2.googleapis.com/token`, { encoding: 'utf8' })).access_token;
  if (!at) throw new Error('could not mint access token — run: npx firebase-tools login');
  return at;
}

function api(method, p, at, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: 'run.googleapis.com', path: p, method,
      headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (r) => {
      let b = ''; r.on('data', (d) => b += d);
      r.on('end', () => { try { resolve({ status: r.statusCode, json: JSON.parse(b || '{}') }); } catch (_) { resolve({ status: r.statusCode, raw: b }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const at = token();
  let failed = 0;
  for (const svc of TARGETS) {
    const base = `/v2/projects/${PROJECT}/locations/${REGION}/services/${svc}`;
    const pol = await api('GET', `${base}:getIamPolicy`, at);
    if (pol.status !== 200) { console.log(`  ${svc}: getIamPolicy FAILED (${pol.status}) ${JSON.stringify(pol.json || pol.raw).slice(0, 160)}`); failed++; continue; }

    const bindings = (pol.json.bindings || []).map((b) => ({ ...b, members: [...(b.members || [])] }));
    let inv = bindings.find((b) => b.role === 'roles/run.invoker');
    if (inv && inv.members.includes('allUsers')) { console.log(`  ${svc}: already has allUsers invoker — no change`); continue; }
    if (inv) inv.members = Array.from(new Set([...inv.members, 'allUsers']));
    else bindings.push({ role: 'roles/run.invoker', members: ['allUsers'] });

    const setRes = await api('POST', `${base}:setIamPolicy`, at, { policy: { bindings, etag: pol.json.etag } });
    if (setRes.status === 200) console.log(`  ${svc}: ✅ granted allUsers roles/run.invoker`);
    else { console.log(`  ${svc}: ❌ setIamPolicy FAILED (${setRes.status}) ${JSON.stringify(setRes.json || setRes.raw).slice(0, 220)}`); failed++; }
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
