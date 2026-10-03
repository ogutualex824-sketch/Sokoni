#!/usr/bin/env node
/* test-takedown-hosting.js — the hosting half of takedown enforcement (2026-10-02). Static + module-level; no browser,
 * no network, no Firebase. (The browser certification is QUEUED behind the browser hold.)
 *
 *   H1 SokoniSellability (the ONE listing predicate, client + serving functions copy) refuses a held listing, even if a
 *      stray writer re-set isVisible:true; reason 'moderation'; a seller-paused listing stays not-listed; a normal one listed
 *   H2 availabilityOf / itemAvailability treat a held listing as unavailable (no buy button, no checkout)
 *   H3 product.js: a DENIED canonical read fails CLOSED in both paths (direct link + cached revalidation) to a neutral
 *      UNAVAILABLE that names no reason; the cached copy is dropped
 *   H4 merchant.html: a held listing shows "Taken down by SOKONI" with no availability switch; the toggle refuses it
 *   H5 sokoni-trust-queues.js: Restore listing is a server action (internal note ≥10) and the history names it
 *   H6 store.html: the public storefront list drops non-listed products through SokoniSellability (defence in depth)
 * Failure injection: --failure-injection mutates temp copies and requires each named row to fail.
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const FILES = ['sokoni-sellability.js', 'product.js', 'merchant.html', 'sokoni-trust-queues.js', 'store.html'];
const SAB = {
  'sellability-ignores-hold': { file: 'sokoni-sellability.js', catch: 'H1', from: '    if (p.moderationHold != null) return false;\n', to: '' },
  'product-denied-keeps-cache': { file: 'product.js', catch: 'H3', from: "if (e && e.code === 'permission-denied') {", to: 'if (false) {' },
  'merchant-toggle-on-held': { file: 'merchant.html', catch: 'H4', from: '    if (p.moderationHold != null) { if (window.SokoniNotify)', to: '    if (false) { if (window.SokoniNotify)' },
  'queue-no-restore': { file: 'sokoni-trust-queues.js', catch: 'H5', from: "    restore:         { l: 'Restore listing',", to: "    restore_x:       { l: 'Restore listing'," },
  'store-unfiltered': { file: 'store.html', catch: 'H6', from: '      fsProds = fsProds.filter(function (p) {', to: '      fsProds = fsProds.filter(function (p) { return true;' },
};
if (process.argv.includes('--failure-injection')) {
  const h = () => FILES.map((f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex')).join();
  const b = h(); let ok = true;
  for (const [n, s] of Object.entries(SAB)) {
    const r = cp.spawnSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: n }), encoding: 'utf8' });
    const caught = new RegExp('^  FAIL  ' + s.catch + ' ', 'm').test(r.stdout) && r.status === 1 && !/NOT APPLIED/.test(r.stdout);
    if (!caught) ok = false;
    console.log(`  ${caught ? 'CAUGHT' : 'MISSED'}  ${n.padEnd(28)} → ${s.catch}`);
  }
  const same = b === h(); console.log('  tree unchanged: ' + (same ? 'YES' : 'NO'));
  console.log(ok && same ? '\nFAILURE INJECTION: all caught, all restored' : '\nFAILURE INJECTION: FAILED'); process.exit(ok && same ? 0 : 1);
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tdh-'));
for (const f of FILES) {
  let t = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const s = SAB[process.env.SABOTAGE || ''];
  if (s && s.file === f) { if (t.split(s.from).length !== 2) { console.log('SABOTAGE NOT APPLIED'); process.exit(3); } t = t.replace(s.from, () => s.to); }
  fs.writeFileSync(path.join(TMP, f), t);
}
const src = (f) => fs.readFileSync(path.join(TMP, f), 'utf8');
let pass = 0, fail = 0;
const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 300) : '')); } };

const S = require(path.join(TMP, 'sokoni-sellability.js'));
const HOLD = { active: true, ref: 'r', at: 1 };
ck('H1 the listing predicate refuses a held listing (even with isVisible:true), reason "moderation"; paused not listed; normal listed',
  S.isPubliclyListed({ isVisible: false, moderationHold: HOLD }) === false && S.isPubliclyListed({ isVisible: true, moderationHold: HOLD }) === false
    && S.listingBlockReason({ isVisible: true, moderationHold: HOLD }) === 'moderation' && S.isPubliclyListed({ isVisible: false }) === false
    && S.isPubliclyListed({ name: 'x', status: 'active' }) === true);
const av = S.availabilityOf({ isVisible: true, moderationHold: HOLD, stock: 5 }), ia = S.itemAvailability({ isVisible: true, moderationHold: HOLD, stock: 5 });
ck('H2 a held listing is unavailable to buy (availabilityOf not sellable; itemAvailability refused)', av.sellable === false && ia.available === false, { av, ia });
const pj = src('product.js');
const reval = pj.slice(pj.indexOf('CANONICAL REVALIDATION'));
ck('H3 product.js fails CLOSED on a denied canonical read: neutral UNAVAILABLE, cache dropped, no reason named',
  /if \(e && e\.code === 'permission-denied'\) \{\s*\n\s*try\{ localStorage\.removeItem\('selectedProduct'\); \}catch\(_\)\{\}/.test(reval)
    && /This product isn’t available right now/.test(pj) && !/reported|taken down|moderation hold/i.test(pj.replace(/\/\*[\s\S]*?\*\//g, '')));
const mh = src('merchant.html');
ck('H4 merchant.html: a held listing shows "Taken down by SOKONI" with no switch, and the toggle refuses it',
  /if \(p\.moderationHold != null\) \{\s*\n\s*return '<div class="av-row">[\s\S]{0,300}Taken down by SOKONI/.test(mh)
    && /if \(p\.moderationHold != null\) \{ if \(window\.SokoniNotify\) SokoniNotify\.error\(/.test(mh));
const tq = require(path.join(TMP, 'sokoni-trust-queues.js'));
ck('H5 the moderation console offers "Restore listing" as a server action with an internal note; history names it',
  tq.ACTION && tq.ACTION.restore && tq.ACTION.restore.note === 'internal10' && /'listing_restored' \? 'Listing restored'/.test(src('sokoni-trust-queues.js')));
const st = src('store.html');
ck('H6 store.html drops non-listed products through SokoniSellability before rendering',
  /fsProds = fsProds\.filter\(function \(p\) \{\s*\n\s*var S = window\.SokoniSellability;\s*\n\s*if \(S && typeof S\.isPubliclyListed === 'function'\) return S\.isPubliclyListed\(p\);/.test(st));
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
