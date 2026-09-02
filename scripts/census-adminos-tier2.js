#!/usr/bin/env node
/* TIER 2 CENSUS — READ-ONLY. No writes, no deploys, no production mutation.
 *
 * TIER 1 was decidable from outside: a 404 from production proved the control could
 * never work, so the fix needed no judgement about the backend. TIER 2's targets all
 * EXIST, so the question changes to: is the claimed fact the backend's to establish,
 * and would an operator act differently on a false success?
 *
 * This gathers FACTS only. Severity is a judgement recorded separately.
 *
 * TWO PROBE ERRORS THIS FILE EXISTS TO NOT REPEAT
 *  1. `_toast\([^)]*"success"` stops at the first ')', so it MISSED claims built by
 *     concatenation, e.g. _toast((enabled?"Enabled":"Disabled") + " " + key, "success").
 *     That undercounted the site total.
 *  2. Handlers are registered INLINE as the onCall argument —
 *       exports.NAME = onCall({...}, exports._h.NAME = async (req) => { ... });
 *     so a handler body runs from its registration LINE to the NEXT registration LINE.
 *     Splitting on a text marker bled collections across unrelated handlers.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const AOS = R('sokoni-aos.js');
const ADMINOS = R('functions/admin-os.js');
const IDX = R('functions/index.js');
const L = AOS.split('\n');
const AL = ADMINOS.split('\n');

const setSrc = AOS.match(/_ADMIN_OS_OPS = new Set\(\[([\s\S]*?)\]\)/);
const OPS = new Set(setSrc ? (setSrc[1].match(/'[a-zA-Z0-9_]+'/g) || []).map((s) => s.slice(1, -1)) : []);

/* ── handler registration lines, in file order ─────────────────────────────── */
const REG = [];
AL.forEach((l, i) => {
  const m = l.match(/exports\._h\.([a-zA-Z0-9_]+)\s*=/);
  if (m) REG.push({ name: m[1], line: i });
});
const HANDLERS = new Set(REG.map((r) => r.name));

/* ── the swallow-then-succeed sites, and the exact claim each makes ────────── */
const sites = [];
L.forEach((l, i) => {
  if (!/\.catch\(\s*(?:e|err)?\s*=>\s*_toast/.test(l)) return;
  let j = i + 1, seen = 0, claim = null;
  while (j < L.length && seen < 2) {
    const t = L[j].trim(); j++;
    if (!t) continue;
    seen++;
    const m = t.match(/_toast\(\s*(.+),\s*"success"\s*\)/);
    if (m) { claim = m[1].trim(); break; }
  }
  if (!claim) return;
  let fn = null;
  for (let k = i; k > i - 6 && k >= 0; k--) {
    const mm = L[k].match(/_call\(\s*["']([a-zA-Z0-9_]+)["']/);
    if (mm) { fn = mm[1]; break; }
  }
  let owner = '?';
  for (let k = i; k >= 0; k--) {
    const om = L[k].match(/^\s{2}(?:async )?function ([a-zA-Z0-9_]+)\s*\(/);
    if (om) { owner = om[1]; break; }
  }
  sites.push({ line: i + 1, fn: fn || '(direct-db)', claim, owner });
});

/* ── what each handler actually does, bounded correctly ────────────────────── */
function handlerFacts(name) {
  const idx = REG.findIndex((r) => r.name === name);
  if (idx < 0) return null;
  const start = REG[idx].line;
  const end = idx + 1 < REG.length ? REG[idx + 1].line : AL.length;
  const body = AL.slice(start, end).join('\n');
  const collections = Array.from(new Set(
    (body.match(/collection\(['"][a-zA-Z0-9_]+['"]/g) || [])
      .map((c) => c.replace(/collection\(['"]/, '').replace(/['"]$/, ''))
  ));
  const ret = body.match(/return\s*\{[^}]{0,110}/);
  return {
    lines: end - start,
    writes: /\.(set|update|add|delete|create)\(/.test(body),
    setsClaims: /setCustomUserClaims/.test(body),
    audits: /adminAudit|adminLog/.test(body),
    throws: (body.match(/HttpsError\(/g) || []).length,
    collections,
    returns: ret ? ret[0].replace(/\s+/g, ' ').slice(0, 66) : '—',
    alsoDirect: ADMINOS.indexOf('exports.' + name + ' = onCall') > -1,
  };
}

console.log('');
console.log('  TIER 2 CENSUS — AdminOS swallow-then-succeed (READ-ONLY)');
console.log('');

/* ══ CONTROLS FIRST ═══════════════════════════════════════════════════════ */
let controlsOk = true;
{
  const c1 = HANDLERS.has('adminGetOrders') && !HANDLERS.has('__nope__');
  console.log('  CONTROL  handler table: ' + HANDLERS.size + ' registered, ' +
              'adminGetOrders=' + HANDLERS.has('adminGetOrders') +
              ' __nope__=' + HANDLERS.has('__nope__') + '  -> ' + (c1 ? 'PASS' : 'FAIL'));
  if (!c1) controlsOk = false;

  /* boundaries must not bleed: adminDeleteBanner must NOT touch posDevices */
  const hb = handlerFacts('adminDeleteBanner');
  const c2 = hb && hb.collections.indexOf('posDevices') < 0 && hb.lines < 200;
  console.log('  CONTROL  handler boundaries do not bleed: adminDeleteBanner=' +
              (hb ? hb.lines + ' lines [' + hb.collections.join(',') + ']' : 'MISSING') +
              '  -> ' + (c2 ? 'PASS' : 'FAIL'));
  if (!c2) controlsOk = false;

  /* the claim regex must catch a concatenated claim */
  const probe = '    _toast((enabled?"Enabled":"Disabled") + " " + key, "success");';
  const c3 = /_toast\(\s*(.+),\s*"success"\s*\)/.test(probe);
  console.log('  CONTROL  claim regex catches a concatenated claim  -> ' + (c3 ? 'PASS' : 'FAIL'));
  if (!c3) controlsOk = false;

  const c4 = IDX.indexOf('exports.adminProcessPayout') > -1;
  console.log('  CONTROL  index.js export detector works  -> ' + (c4 ? 'PASS' : 'FAIL'));
  if (!c4) controlsOk = false;
}
console.log('');
if (!controlsOk) {
  console.log('  BLOCKED — a control failed. The census below would be unreliable.');
  process.exit(1);
}

const byFn = {};
sites.forEach((s) => { (byFn[s.fn] = byFn[s.fn] || []).push(s); });
console.log('  sites: ' + sites.length + '   distinct targets: ' + Object.keys(byFn).length);
console.log('');

Object.keys(byFn).sort().forEach((fn) => {
  const g = byFn[fn];
  const h = handlerFacts(fn);
  console.log('  ── ' + fn + '   [' + (OPS.has(fn) ? 'dispatch' : 'direct') + ']');
  g.forEach((s) => console.log('       ' + s.owner + '() L' + s.line + '  claims: ' + s.claim));
  if (h) {
    console.log('       backend: ' + h.lines + 'L  writes=' + h.writes + '  setsClaims=' + h.setsClaims +
                '  audit=' + h.audits + '  HttpsError=' + h.throws + '  alsoDirectCallable=' + h.alsoDirect);
    console.log('       touches: ' + (h.collections.join(', ') || '—'));
    console.log('       returns: ' + h.returns);
  } else {
    console.log('       backend: not in admin-os.js (defined elsewhere — read separately)');
  }
  console.log('');
});
