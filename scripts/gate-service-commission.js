#!/usr/bin/env node
/* RELEASE GATE — the service-booking commission invariant (owner 2026-10-03, locked):
 *
 *     service amount KES 1,000  →  buyer pays 1,000  ·  SOKONI 5 % = 50  ·  provider settlement 950
 *     one rate on every plan (no 20/15/10/7/5 ladder), charged once, from ONE canonical source.
 *
 * Executes the REAL finos-utils.calculateCommission with EXACTLY the arguments the tree's settlement path builds
 * (provider-ops._settlementMath: provider-hub.commissionArgsForHub when the tree has it, else the inline
 * `subscriptionRole:'provider'` compatibility call), on an in-memory Firestore, for a Free-plan and an Enterprise-plan
 * provider. Then re-runs the same rows on deliberately broken copies of the tree; each mutation must turn a NAMED row red.
 *
 *   TREE=<git ref> node scripts/gate-service-commission.js      (default HEAD; the tree's functions/ is extracted)
 *   exit 0 = invariant holds on that tree · 1 = violated (release blocker) · 2 = crash (no verdict)
 */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process'), Module = require('module');
const ROOT = path.join(__dirname, '..');
const TREE = process.env.TREE || 'HEAD';
const NM = process.env.SOKONI_NODE_MODULES || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules';

function extract(ref) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-'));
  cp.execSync('git archive ' + ref + ' functions sokoni-commission-rates.js | tar -x -C "' + d.replace(/\\/g, '/') + '"', { cwd: ROOT, shell: 'bash' });
  return d;
}

/* evaluate one tree directory in a CHILD process (fresh module cache per tree / mutation) */
function evaluate(dir) {
  const out = cp.spawnSync(process.execPath, [__filename, '--child', dir], { env: Object.assign({}, process.env, { NODE_PATH: NM }), encoding: 'utf8' });
  const line = (out.stdout || '').split('\n').find((l) => l.startsWith('RESULT_JSON '));
  if (!line) return { crash: (out.stderr || out.stdout || '').slice(-600) };
  return JSON.parse(line.slice('RESULT_JSON '.length));
}

if (process.argv[2] === '--child') {
  const dir = process.argv[3], FN = path.join(dir, 'functions');
  process.env.NODE_PATH = NM; Module._initPaths();
  const H = require(path.join(ROOT, 'scripts', 'lib', 'inmem-firestore.js')).install({ admins: [] });
  (async () => {
    const r = {};
    const po = fs.readFileSync(path.join(FN, 'provider-ops.js'), 'utf8');
    const hasHub = fs.existsSync(path.join(FN, 'provider-hub.js')) && /commissionArgsForHub\(/.test(po);
    /* the settlement call's args, as THIS tree builds them */
    const settleArgs = (sellerId) => hasHub
      ? Object.assign({ orderAmountCents: 100000, sellerId }, require(path.join(FN, 'provider-hub.js')).commissionArgsForHub(undefined))
      : { orderAmountCents: 100000, category: 'services', sellerId, hubId: 'provider', subscriptionRole: 'provider' };
    r.path = hasHub ? 'provider-hub.commissionArgsForHub' : "inline subscriptionRole:'provider' (plan-rate compatibility mode)";
    const { calculateCommission } = require(path.join(FN, 'finos-utils.js'));
    H.DOCS.set('providerSubscriptions/free', { uid: 'free', planId: 'free_trial', plan: 'free_trial', status: 'active' });
    H.DOCS.set('providerSubscriptions/ent', { uid: 'ent', planId: 'enterprise', plan: 'enterprise', status: 'active' });
    const run = async (uid) => { try { return await calculateCommission(H.db, settleArgs(uid)); } catch (e) { return { error: e.message }; } };
    const f = await run('free'), e = await run('ent');
    /* owner 2026-10-03: commission applies to the DISCOUNTED amount — KES 1,000 service, KES 200 offer → buyer pays 800 → 5 % = 40 */
    let dsc; try { dsc = await calculateCommission(H.db, Object.assign(settleArgs('free'), { orderAmountCents: 80000 })); } catch (er) { dsc = { error: er.message }; }
    r.disc = { commission: dsc.commissionCents, error: dsc.error || null };
    r.free = { commission: f.commissionCents, rate: f.effectiveRate, error: f.error || null };
    r.ent = { commission: e.commissionCents, rate: e.effectiveRate, error: e.error || null };
    const CC = require(path.join(FN, 'commission-config.js'));
    r.configServices = CC.RATES && CC.RATES.services && CC.RATES.services.pct;
    r.configHome = CC.RATES && CC.RATES.home_services ? CC.RATES.home_services.pct : null;
    let snap = null;
    try {
      const vm = require('vm'); const w = {}; const c = { window: w, console }; c.globalThis = c; vm.createContext(c);
      vm.runInContext(fs.readFileSync(path.join(dir, 'sokoni-commission-rates.js'), 'utf8'), c);
      snap = { services: w.SokoniCommission.pct('services'), home: w.SokoniCommission.pct('home_services'),
        ladderExported: !!(w.SokoniCommission.PROVIDER_PLAN_PCT || w.SokoniCommission.providerPct) };
    } catch (_) { snap = null; }
    r.snapshot = snap;
    console.log('RESULT_JSON ' + JSON.stringify(r));
  })().catch((e) => { console.error(e && e.stack || e); process.exit(2); });
  return;
}

let pass = 0, fail = 0;
const rows = (x) => ({
  'C1 Free-plan provider: KES 1,000 booking → commission KES 50': !!x.free && x.free.commission === 5000,
  'C2 Enterprise-plan provider pays EXACTLY what a Free-plan provider pays (KES 50) — no plan ladder': !!x.ent && !!x.free && x.ent.commission === 5000 && x.free.commission === x.ent.commission,
  'C3 provider settlement KES 950 (net = gross − commission, charged once)': !!x.free && x.free.commission === 5000 && 100000 - x.free.commission === 95000,
  'C4 ONE source: commission-config services = home_services = generated snapshot = 5': x.configServices === 5 && (x.configHome === null || x.configHome === 5)
    && !!x.snapshot && x.snapshot.services === 5 && x.snapshot.home === 5,
  'C5 the generated snapshot publishes no provider plan ladder': !!x.snapshot && x.snapshot.ladderExported === false,
  'C6 discounted booking (owner 10-03): KES 1,000 less a KES 200 offer → commission KES 40 on the KES 800 paid, provider KES 760': !!x.disc && x.disc.commission === 4000 && 80000 - x.disc.commission === 76000,
});
const ck = (id, ok, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + (ok ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };

console.log('\nService commission gate   TREE=' + TREE + '\n');
const base = extract(TREE);
const x = evaluate(base);
if (x.crash) { console.log('CRASH (no verdict): ' + x.crash); process.exit(2); }
console.log('  settlement path: ' + x.path + '\n');
const R = rows(x);
for (const [k, v] of Object.entries(R)) ck(k, v, x);

/* deliberate commercial mutations — counted only when a NAMED row that passed on the clean tree turns red */
const MUT = [
  ['services 14 %', 'functions/commission-config.js', (s) => s.replace(/(services:\s*\{\s*pct:\s*)5(\s*,)/, '$114$2'), 'C1'],
  ['plan ladder back (subscriptionRole on the settlement)', 'functions/provider-hub.js', (s) => s.replace("return { category: 'services', hubId: 'provider', skipMinimum: true };", "return { category: 'services', hubId: 'provider', subscriptionRole: 'provider' };"), 'C2'],
  ['home_services 14 % in config', 'functions/commission-config.js', (s) => s.replace(/(home_services:\s*\{\s*pct:\s*)5(\s*,)/, '$114$2'), 'C4'],
  ['ladder republished in the snapshot', 'sokoni-commission-rates.js', (s) => s.replace('window.SokoniCommission = {', 'window.SokoniCommission = { PROVIDER_PLAN_PCT: { provider_free: 20 },'), 'C5'],
  ['commission charged on the pre-discount list price', 'functions/finos-utils.js', (s) => s.replace(/async function calculateCommission\(([^,]+),\s*(\w+)\)\s*\{/, (m, a, b) => m + ' if (' + b + ' && ' + b + '.orderAmountCents === 80000) ' + b + ' = Object.assign({}, ' + b + ', { orderAmountCents: 100000 });'), 'C6'],
];
if (Object.values(R).every(Boolean)) {
  console.log('\n  [mutations]');
  for (const [name, file, fn, row] of MUT) {
    const d = extract(TREE);
    const p = path.join(d, file);
    const src = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    const bad = src === null ? null : fn(src);
    if (!bad || bad === src) { console.log('  MISSED  ' + name + ' (anchor not found)'); fail++; continue; }
    fs.writeFileSync(p, bad);
    const y = evaluate(d);
    const key = Object.keys(R).find((k) => k.startsWith(row + ' '));
    const red = !y.crash && rows(y)[key] === false;
    console.log('  ' + (red ? 'CAUGHT' : 'MISSED') + '  ' + name + ' → ' + row + (y.crash ? ' (crash)' : ''));
    if (!red) fail++;
  }
} else {
  console.log('\n  [mutations] skipped — the invariant does not hold on this tree, so there is nothing to protect yet.');
}
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
console.log('Not covered here: buyer total / intent amount (bookingCreateService + createPaymentIntent, sokoni-5b) and providerServices.fee being ignored.');
console.log('C6 proves the engine on the discounted base. Settlement reads booking.price, so 4J (shopOffers, sokoni-5b) MUST store the post-discount payable as booking.price; that binding row lands with 4J.');
process.exit(fail ? 1 : 0);
