#!/usr/bin/env node
/* commission-version-extract.js — READ-ONLY. Census of the three commercial money modules
 * (commission-config.js, finos-utils.js, commission-collection.js) across every DEPLOYED
 * Cloud Functions source archive, and the commercial behaviour of each distinct version.
 * It changes nothing and calls nothing: it reads unzipped archives from disk.
 *
 *   node scripts/commission-version-extract.js <censusDir> <fn-archive.json>
 *
 * <censusDir>/<archiveId>/ — one dir per distinct serving archive, fully unzipped (one
 * commission-config version requires ./subscription-catalog, a pure sibling module).
 * <fn-archive.json> — { byArchive: { <md5>: [functionName…] } } built from
 * `gcloud functions list --v2 --format=json` (buildConfig.source.storageSource) joined with
 * `gcloud storage objects list gs://gcf-v2-sources-…/**` (name, md5_hash, generation).
 * Archive dir ids are the md5 with `/ + =` replaced by `_`.
 *
 * commission-config.js has no I/O (at most a pure sibling require), so it is `require`d and its
 * resolveRate() is probed. finos-utils.js and commission-collection.js require firebase-admin and
 * other modules, so they are NOT loaded — they are parsed (@babel/parser) and compared by AST with
 * locations and comments stripped, and scanned for the behaviour markers listed below.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse } = require(path.join(__dirname, '..', 'functions', 'node_modules', '@babel', 'parser'));

const [, , CENSUS, FNMAP] = process.argv;
const byArchive = JSON.parse(fs.readFileSync(FNMAP, 'utf8')).byArchive;
const dirId = (md5) => md5.replace(/[/+=]/g, '_');

/* git blob id — the same identity `git hash-object` / `git log --find-object` use */
const blobOf = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex').slice(0, 7);
const DROP = new Set(['start', 'end', 'loc', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens']);
const norm = (n) => JSON.stringify(n, (k, v) => (DROP.has(k) ? undefined : v));
const program = (src) => parse(src, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, errorRecovery: true }).program;
const fnAst = (src, name) => {
  const st = program(src).body.find((s) => s.type === 'FunctionDeclaration' && s.id && s.id.name === name);
  return st ? crypto.createHash('sha1').update(norm(st)).digest('hex').slice(0, 10) : null;
};
const exportNames = (src) => {
  const out = new Set();
  for (const st of program(src).body) {
    if (st.type !== 'ExpressionStatement' || st.expression.type !== 'AssignmentExpression') continue;
    const l = st.expression.left;
    if (l.type === 'MemberExpression' && l.object.name === 'exports') out.add(l.property.name);
    if (l.type === 'MemberExpression' && l.object.name === 'module' && st.expression.right.type === 'ObjectExpression') {
      st.expression.right.properties.forEach((p) => p.key && out.add(p.key.name || p.key.value));
    }
  }
  return [...out].sort();
};

/* collect: module → blob → { archives, functions, file } */
const MODULES = ['commission-config.js', 'finos-utils.js', 'commission-collection.js'];
const census = Object.fromEntries(MODULES.map((m) => [m, {}]));
for (const [md5, fns] of Object.entries(byArchive)) {
  for (const m of MODULES) {
    const file = path.join(CENSUS, dirId(md5), m);
    const blob = fs.existsSync(file) ? blobOf(fs.readFileSync(file)) : 'ABSENT';
    const e = (census[m][blob] = census[m][blob] || { archives: 0, functions: [], file: null });
    e.archives += 1; e.functions.push(...fns); e.file = e.file || (blob === 'ABSENT' ? null : file);
  }
}

const out = { census: {}, commissionConfig: {}, finosUtils: {}, commissionCollection: {} };
for (const m of MODULES) {
  out.census[m] = Object.entries(census[m])
    .sort((a, b) => b[1].functions.length - a[1].functions.length)
    .map(([blob, e]) => ({ blob, archives: e.archives, functionCount: e.functions.length, functions: e.functions.sort() }));
}

/* commission-config.js — load (pure) and probe */
const PROBES = ['marketplace', 'shopping', 'products', 'hub', 'delivery', 'pos', 'till', 'services', 'bookings', 'food',
  'legal', 'healthcare', 'digital', 'digital_products', 'creator', 'events', 'event_tickets', 'entertainment', 'ppv',
  'education', 'jobs', 'property', 'vehicles', 'car_rental', 'classifieds', 'advertising', 'subscriptions', 'saas',
  'hotel', 'default', 'unknown-xyz'];
for (const [blob, e] of Object.entries(census['commission-config.js'])) {
  if (!e.file) continue;
  const m = require(e.file);
  const resolve = {};
  for (const p of PROBES) {
    try { const r = m.resolveRate(p); resolve[p] = `${r.pct}%${r.fixedKES ? '+' + r.fixedKES + 'KES' : ''}→${r.category}${r.matched === false ? '(fallback)' : ''}`; }
    catch (err) { resolve[p] = 'THROWS ' + err.message.slice(0, 60); }
  }
  out.commissionConfig[blob] = {
    exports: Object.keys(m).sort(),
    MIN_COMMISSION_KES: m.MIN_COMMISSION_KES ?? null, PLAN_MIN_PCT: m.PLAN_MIN_PCT ?? null, PLAN_MAX_DISCOUNT: m.PLAN_MAX_DISCOUNT ?? null,
    FIXED_RATE_CATEGORIES: m.FIXED_RATE_CATEGORIES ? [...m.FIXED_RATE_CATEGORIES] : null,
    PACKAGE_RATES: m.PACKAGE_RATES || null, PACKAGE_CATEGORIES: m.PACKAGE_CATEGORIES || null,
    PENDING_PRICING: m.PENDING_PRICING ? Object.keys(m.PENDING_PRICING) : null,
    resolve,
  };
}

/* finos-utils.js — parse only; behaviour markers inside calculateCommission */
const MARKERS = {
  posFixedRateBypass: /isFixedRateCategory/,
  packageTierRates: /isPackageCategory|packageRate\(/,
  failClosedUnknownCategory: /COMMISSION_CATEGORY_UNRESOLVED/,
  pendingPricingRefusal: /COMMISSION_CATEGORY_PENDING_PRICING/,
  requiresDbArgument: /first argument must be a Firestore instance/,
  minimumFloor: /MIN_COMMISSION_KES/,
  planAdjustment: /plan_adjustments/,
};
for (const [blob, e] of Object.entries(census['finos-utils.js'])) {
  if (!e.file) continue;
  const src = fs.readFileSync(e.file, 'utf8');
  const i = src.indexOf('async function calculateCommission');
  let body = '';
  if (i >= 0) { let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) { body = src.slice(i, k + 1); break; } } }
  out.finosUtils[blob] = {
    calculateCommissionAst: fnAst(src, 'calculateCommission'),
    markers: Object.fromEntries(Object.entries(MARKERS).map(([k, re]) => [k, re.test(body)])),
    exports: exportNames(src),
  };
}

/* commission-collection.js — parse only */
for (const [blob, e] of Object.entries(census['commission-collection.js'])) {
  if (!e.file) continue;
  const src = fs.readFileSync(e.file, 'utf8');
  out.commissionCollection[blob] = {
    settleConfirmedPaymentAst: fnAst(src, 'settleConfirmedPayment'),
    computeOutstandingKESAst: fnAst(src, 'computeOutstandingKES'),
    paymentRefClaim: /collection\(SETTLEMENT\)\.doc\(ref\)/.test(src),
    penaltyMath: /penaltyPct/.test(src),
    exports: exportNames(src),
  };
}
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
