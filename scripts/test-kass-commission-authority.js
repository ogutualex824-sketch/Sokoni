#!/usr/bin/env node
/* test-kass-commission-authority.js — KASS states commission ONLY as read from the one authority.
 *
 *   node scripts/test-kass-commission-authority.js                 # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-kass-commission-authority.js  # functions/index.js @ 4e9607b — failures ARE the defect
 *
 * Owner rule (2026-09-28): KASS must never claim a commission rate that differs from the authoritative application
 * logic, must not hard-code alternatives, and must not regress to the old "SOKONI takes 12%" (or a stale 3%)
 * statement. The authority is functions/commission-config.js (resolveRate + POS_FLAT_RATE_FRACTION). This suite never
 * hard-codes an expected rate: every expectation is DERIVED from the authority, so it stays correct when the owner's
 * schedule is applied there.
 *
 * PROVES
 *   C1  the public KASS system prompt carries NO literal commission figure (no "12%", no "88%", no "<n>%" on any
 *       commission / takes / keeps line) — the rate text is generated, never typed
 *   C2  the evaluated prompt contains the authority-rendered commission line, and still no 12% / 88% claim
 *   C3  every rate KASS states equals the authority's resolveRate / POS lane value for that transaction type
 *   C4  the rates are READ, not copied: with the authority swapped for a different schedule, KASS's line follows it
 *   C5  transaction types stay distinct (online sales, POS, event tickets, bookings are separate entries)
 *   C6  a type the authority does not price is never rendered with a fallback rate
 *   C7  the admin agent's tax tool resolves COMMISSION_CONFIG (it was referenced but never imported)
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), Module = require('module');
const X = require('./lib/xss-probe');
const ROOT = path.resolve(__dirname, '..');
const CPM = !!process.env.COUNTERPROOF;
const read = (f) => (CPM ? cp.execFileSync('git', ['show', '4e9607b:' + f], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256e6 }) : fs.readFileSync(path.join(ROOT, f), 'utf8'));
let pass = 0, fail = 0;
const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 300) : '')); } };

console.log('\nSOURCE: ' + (CPM ? 'functions/index.js @ 4e9607b (before) — failures below ARE the defect' : 'working tree (fix)'));
const IDX = read('functions/index.js');
const CC = require(path.join(ROOT, 'functions/commission-config.js'));   /* the authority, at its CURRENT version */

/* ── C1: the raw prompt template ── */
const tpl = X.tplAt(IDX, 'const systemPrompt = `You are KASS');
const rawNoHoles = tpl.replace(/\$\{[^}]*\}/g, '');
const commissionLines = rawNoHoles.split('\n').filter((l) => /commission|takes|keeps|seller keeps/i.test(l) && /\d+(\.\d+)? ?%/.test(l));
ck('C1  the public KASS prompt carries no literal commission figure', !/\b12 ?%|\b88 ?%/.test(rawNoHoles) && commissionLines.length === 0, commissionLines.map((l) => l.trim().slice(0, 100)));

/* the KASS commission module, loaded from the tree under test (absent at the baseline) */
let KC = null;
if (!CPM) { try { KC = require(path.join(ROOT, 'functions/kass-commission.js')); } catch (e) { KC = null; } }

/* ── C2: the evaluated prompt ── */
{
  let out = '';
  try { out = X.runWith('(function(){ return ' + tpl + '; })()', { _kassCommission: KC || X.STUB, userProfile: '', today: 'today', uid: null }); } catch (e) { out = 'ERR ' + e.message; }
  const hasLine = !!KC && out.includes(KC.commissionPromptLine());
  ck('C2  the evaluated prompt states commission only via the authority line (and never 12% / 88%)', hasLine && !/\b12 ?%|\b88 ?%/.test(out.replace(KC ? KC.commissionPromptLine() : '', '')), { hasLine, sample: out.slice(0, 80) });
}

/* ── C3: every stated rate equals the authority ── */
if (!KC) { ck('C3  every rate KASS states equals the authority', false, 'kass-commission.js absent — KASS has no authority reader'); }
else {
  const bad = [];
  for (const r of KC.commissionFacts().rows) {
    const t = KC.TYPES.find((x) => x.id === r.id);
    const want = t.pos ? Math.round(CC.POS_FLAT_RATE_FRACTION * 100000) / 1000 : CC.resolveRate(t.key).pct;
    if (r.pct !== want) bad.push({ id: r.id, kass: r.pct, authority: want });
  }
  const line = KC.commissionPromptLine();
  ck('C3  every rate KASS states equals the authority (resolveRate / POS lane)', bad.length === 0 && line.includes('KES ' + CC.MIN_COMMISSION_KES + ' minimum'), bad);
}

/* ── C4: the rates are READ — swap the authority, KASS follows ── */
if (!KC) { ck('C4  KASS follows the authority when it changes', false, 'no authority reader'); }
else {
  const fake = { resolveRate: (k) => ({ pct: ({ marketplace: 15, event_tickets: 4, services: 7 })[k] || 6, fixedKES: 0, matched: true }), POS_FLAT_RATE_FRACTION: 0.061, MIN_COMMISSION_KES: 11 };
  const orig = Module._load;
  const kcPath = path.join(ROOT, 'functions/kass-commission.js');
  delete require.cache[kcPath];
  Module._load = function (req, parent, isMain) { if (/commission-config$/.test(req)) return fake; return orig.apply(this, arguments); };
  let line = '';
  try { line = require(kcPath).commissionPromptLine(); } finally { Module._load = orig; delete require.cache[kcPath]; }
  ck('C4  KASS follows the authority when it changes (online 15%, tickets 4%, POS 6.1%, min KES 11)', /Online product sales 15%/.test(line) && /Event ticket sales 4%/.test(line) && /POS \/ Till \/ Quick Charge sales 6\.1%/.test(line) && /KES 11 minimum/.test(line), line.slice(0, 200));
}

/* ── C5 / C6 ── */
if (!KC) { ck('C5  transaction types stay distinct', false, 'no authority reader'); ck('C6  an unpriced type is never rendered with a fallback rate', false, 'no authority reader'); }
else {
  const ids = KC.commissionFacts().rows.map((r) => r.id);
  ck('C5  online sales, POS, event tickets and bookings are separate entries', ['online_products', 'pos', 'event_tickets', 'stays', 'services'].every((i) => ids.includes(i)), ids);
  const orig = Module._load;
  const kcPath = path.join(ROOT, 'functions/kass-commission.js');
  delete require.cache[kcPath];
  Module._load = function (req) { if (/commission-config$/.test(req)) return { resolveRate: (k) => (k === 'legal' ? { pct: 5, fixedKES: 0, category: 'default', matched: false } : { pct: 9, fixedKES: 0, matched: true }), POS_FLAT_RATE_FRACTION: 0.05, MIN_COMMISSION_KES: 10 }; return orig.apply(this, arguments); };
  let rows = [];
  try { rows = require(kcPath).commissionFacts().rows; } finally { Module._load = orig; delete require.cache[kcPath]; }
  ck('C6  a type the authority does not price (default fallback) is omitted, never stated', !rows.some((r) => r.id === 'legal'), rows.map((r) => r.id));
}

/* ── C7: the admin tax tool can resolve the authority ── */
ck('C7  index.js imports COMMISSION_CONFIG, which the admin tax tool and revenue reads use', /\bconst COMMISSION_CONFIG\s*=\s*require\(["']\.\/commission-config["']\)/.test(IDX) || !/\bCOMMISSION_CONFIG\./.test(IDX));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
