#!/usr/bin/env node
'use strict';

/**
 * verify-entitlement-consistency.js — does every source agree about one merchant?
 *
 *   node scripts/verify-entitlement-consistency.js <uid>
 *   node scripts/verify-entitlement-consistency.js <uid> --json
 *
 * WHY THIS EXISTS (incident, 2026-07-24)
 * A paid STARTER merchant was shown a 10-product limit while the upload engine
 * accepted 13. Nothing was broken in isolation: the payment path wrote
 * subscriptions/{uid} and the UI read users/{uid}.subscription.seller, a document
 * that path never wrote. Two authorities, each internally consistent, silently
 * disagreeing.
 *
 * A "is the limit correct?" check could not have caught that, because BOTH
 * numbers were correct for the system that produced them. Only comparing the
 * sources against each other exposes it. That is what this does.
 *
 * SOURCES COMPARED
 *   1. subscriptions/{uid}            the authoritative subscription record
 *   2. subscription-catalog           what the canonical catalogue says that
 *                                     subscription is worth (pure function —
 *                                     the reference answer)
 *   3. entitlements/{uid}             the materialised record new consumers read
 *   4. users/{uid}.subscription.seller the transitional mirror the legacy client
 *                                     reads (expected to disappear — see
 *                                     docs/ENTITLEMENT_MIGRATION.md)
 *   5. productCounters/{uid}          the ceiling the upload guard enforces
 *
 * The dashboard's rendered number is NOT checked here — it needs a browser. If
 * all five below agree and the screen still disagrees, the divergence is in the
 * client, and SokoniAuthority is the only thing it should be reading.
 *
 * Read-only. Exits 1 on any disagreement.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = process.env.SOKONI_PROJECT || 'sokoni-aeb26';
const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const UID = argv.find((a) => !a.startsWith('--'));

if (!UID) {
  console.error('usage: node scripts/verify-entitlement-consistency.js <uid> [--json]');
  process.exit(2);
}

const catalog = require(path.join(ROOT, 'functions', 'subscription-catalog'));

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

const getDoc = (at, p) => new Promise((res) => {
  https.get({ host: 'firestore.googleapis.com', path: p, headers: { Authorization: 'Bearer ' + at } }, (r) => {
    let b = ''; r.on('data', (d) => b += d);
    r.on('end', () => { try { res({ status: r.statusCode, json: JSON.parse(b) }); } catch (_) { res({ status: r.statusCode, json: null }); } });
  }).on('error', () => res({ status: 0, json: null }));
});

/* Firestore REST returns typed values ({stringValue}, {integerValue}, …).
   Flatten them so a comparison is against the value, not the wire format. */
function plain(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v.stringValue !== undefined) out[k] = v.stringValue;
    else if (v.integerValue !== undefined) out[k] = Number(v.integerValue);
    else if (v.doubleValue !== undefined) out[k] = Number(v.doubleValue);
    else if (v.booleanValue !== undefined) out[k] = v.booleanValue;
    else if (v.timestampValue !== undefined) out[k] = v.timestampValue;
    else if (v.nullValue !== undefined) out[k] = null;
    else if (v.mapValue !== undefined) out[k] = plain(v.mapValue.fields);
    else out[k] = v;
  }
  return out;
}

(async () => {
  const at = token();
  const base = `/v1/projects/${PROJECT}/databases/(default)/documents`;

  const [subR, entR, usrR, cntR] = await Promise.all([
    getDoc(at, `${base}/subscriptions/${UID}`),
    getDoc(at, `${base}/entitlements/${UID}`),
    getDoc(at, `${base}/users/${UID}`),
    getDoc(at, `${base}/productCounters/${UID}`),
  ]);

  const sub = subR.status === 200 ? plain(subR.json.fields) : null;
  const ent = entR.status === 200 ? plain(entR.json.fields) : null;
  const usr = usrR.status === 200 ? plain(usrR.json.fields) : null;
  const cnt = cntR.status === 200 ? plain(cntR.json.fields) : null;

  /* The reference answer: what the canonical catalogue says this subscription
     is worth. Everything else is compared against THIS, not against each other,
     so a report names the odd one out rather than just "they differ". */
  const reference = catalog.entitlementFor(sub || {});
  const mirror = usr && usr.subscription ? usr.subscription.seller : null;

  const rows = [
    { source: 'subscriptions/{uid}',        present: !!sub, plan: sub ? (sub.plan || sub.planId) : null,  limit: null,                    note: sub ? `status=${sub.status}` : 'MISSING' },
    { source: 'subscription-catalog',       present: true,  plan: reference.plan,                          limit: reference.listingLimit,  note: `status=${reference.subscriptionStatus} (reference)` },
    { source: 'entitlements/{uid}',         present: !!ent, plan: ent ? ent.plan : null,                   limit: ent ? ent.uploadLimit : null, note: ent ? `used=${ent.uploadsUsed}` : 'MISSING — never materialised' },
    { source: 'users/.subscription.seller', present: !!mirror, plan: mirror ? mirror.planId : null,        limit: mirror && mirror.features ? mirror.features.listings_limit : null, note: mirror ? `status=${mirror.status}` : 'MISSING — legacy client sees FREE_DEFAULTS' },
    { source: 'productCounters/{uid}',      present: !!cnt, plan: null,                                    limit: cnt ? cnt.maxProducts : null, note: cnt ? `count=${cnt.count}` : 'MISSING — guard falls back' },
  ];

  /* Only compare sources that actually carry a value. A missing document is
     reported separately: "absent" and "disagrees" are different failures and
     conflating them hides which one you have. */
  const limits = rows.filter((r) => typeof r.limit === 'number').map((r) => ({ s: r.source, v: r.limit }));
  const plans  = rows.filter((r) => r.plan).map((r) => ({ s: r.source, v: String(r.plan).toUpperCase() }));

  const limitVals = [...new Set(limits.map((x) => x.v))];
  const planVals  = [...new Set(plans.map((x) => x.v))];
  const missing   = rows.filter((r) => !r.present).map((r) => r.source);

  const agree = limitVals.length <= 1 && planVals.length <= 1;

  if (AS_JSON) {
    console.log(JSON.stringify({ uid: UID, agree, limitVals, planVals, missing, rows }, null, 2));
  } else {
    console.log(`\nEntitlement consistency — ${UID}\n`);
    console.log('  ' + 'SOURCE'.padEnd(32) + 'PLAN'.padEnd(12) + 'LIMIT'.padEnd(8) + 'NOTE');
    rows.forEach((r) => console.log('  ' + r.source.padEnd(32)
      + String(r.plan ?? '—').padEnd(12)
      + String(r.limit ?? '—').padEnd(8) + r.note));
    console.log('');
    if (missing.length) {
      console.log('  ABSENT (not a disagreement — nothing has written these):');
      missing.forEach((m) => console.log('    · ' + m));
      console.log('');
    }
    if (!agree) {
      console.log('  SPLIT AUTHORITY — sources disagree:');
      if (planVals.length > 1)  console.log('    plans:  ' + plans.map((x) => `${x.s}=${x.v}`).join('  '));
      if (limitVals.length > 1) console.log('    limits: ' + limits.map((x) => `${x.s}=${x.v}`).join('  '));
      console.log('\n  This is the incident condition. Every consumer must derive from');
      console.log('  functions/subscription-authority.js. See docs/ENTITLEMENT_MIGRATION.md\n');
    } else {
      console.log('  All present sources agree'
        + (limitVals.length ? ` — plan ${planVals[0] || '?'}, limit ${limitVals[0]}` : '') + '\n');
      if (missing.length) {
        console.log('  Agreement among the sources that EXIST is not full coverage:');
        console.log('  a document nothing has written cannot disagree with anything.\n');
      }
    }
  }

  process.exit(agree ? 0 : 1);
})().catch((e) => { console.error('consistency check failed:', e.message); process.exit(2); });
