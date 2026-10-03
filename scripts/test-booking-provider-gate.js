#!/usr/bin/env node
/* LEGAL HUB PHASE 28 — provider activation gate at booking creation, executed (shared provider infrastructure).
 *
 * The brief cites an audit saying bookingCreateService does not check provider status. On this lineage it does, TWICE:
 *   1. booking-service.js — providers/{uid}.status must be active|approved and acceptsBookings !== false;
 *   2. ent-availability.loadCalendar → bookable (SUSPENDED / NOT_APPROVED / NOT_ACCEPTING, plus the Legal
 *      Verification Authority's bookingGate).
 * This suite PROVES it on the real handler across categories (generic provider, it_services, legal) and shows
 * the two layers are independent: removing one leaves the other refusing; removing both turns G2 red.
 *
 *   node scripts/test-booking-provider-gate.js        BASE=<ref> node scripts/test-booking-provider-gate.js */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');

/* ── child: run the rows against one functions/ directory ── */
if (process.argv[2] === '--child') {
  const FN = process.argv[3];
  const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
  const { call } = require('./lib/inmem-firestore');
  const { DOCS } = H;
  const tomorrow = () => new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const provider = (uid, category, extra) => {
    DOCS.set('providers/' + uid, Object.assign({ status: 'active', approvedAt: '2026-09-01T00:00:00.000Z', searchable: true, name: uid,
      business: { category, source: 'application' } }, extra || {}));
    DOCS.set('users/' + uid, { role: 'provider', displayName: uid });
    DOCS.set('applications/' + uid + '--a', { uid, category, role: 'provider', status: 'approved', decidedBy: 'admin1' });
    DOCS.set('providerAvailability/' + uid, { modes: ['open_24_7'], appt: {} });
    DOCS.set('providerServices/svc_' + uid, { providerId: uid, name: 'Consultation', priceType: 'fixed', price: 100000, active: true, durationMins: 60 });
  };
  const book = (uid, time, who) => call(require(path.join(FN, 'booking-service.js'))._h.bookingCreateService, who || 'cust',
    { providerId: uid, serviceId: 'svc_' + uid, date: tomorrow(), startTime: time || '10:00', idempotencyKey: 'k-' + uid + '-' + (time || '10:00') + '-' + Math.random() });
  const bookings = (uid) => [...DOCS.keys()].filter((k) => k.startsWith('providerBookings/') && DOCS.get(k).providerId === uid).length;
  const refused = (r) => r.ok === undefined && r.code === 'failed-precondition';
  (async () => {
    const out = {};
    H.reset(); DOCS.set('users/cust', { displayName: 'cust' });
    provider('gen', 'cleaning'); provider('tech', 'it_services');
    provider('susp', 'cleaning', { status: 'suspended', suspendedAt: '2026-10-01T00:00:00.000Z' });
    provider('pend', 'cleaning', { status: 'pending' });
    provider('noacc', 'cleaning', { acceptsBookings: false });
    provider('lawyer', 'legal', { category: 'legal' });
    let r;
    r = await book('gen');  out.G1 = { ok: r.ok !== undefined, err: r.msg, n: bookings('gen') };
    r = await book('tech'); out.G1b = { ok: r.ok !== undefined, err: r.msg, n: bookings('tech') };
    r = await book('susp'); out.G2 = { refused: refused(r), n: bookings('susp'), err: r.msg, code: (r.det && r.det.code) || r.code };
    r = await book('ghost'); out.G3 = { refused: r.ok === undefined, n: bookings('ghost') };
    r = await book('noacc'); out.G4 = { refused: refused(r), n: bookings('noacc') };
    r = await book('pend'); out.G6 = { refused: refused(r), n: bookings('pend') };
    r = await book('lawyer'); out.G7 = { refused: refused(r), n: bookings('lawyer'), err: r.msg, code: (r.det && r.det.code) || r.code };
    const sp = DOCS.get('providers/susp'); DOCS.set('providers/susp', Object.assign({}, sp, { status: 'active', suspendedAt: null }));
    r = await book('susp', '11:00'); out.G5 = { ok: r.ok !== undefined, err: r.msg, n: bookings('susp') };
    /* AV — availability is server-authoritative (owner 10-03): the booking transaction re-checks it */
    const AVm = require(path.join(FN, 'availability.js'))._h;
    const day = tomorrow();
    const ov = await call(AVm.addAvailabilityOverride, 'gen', { date: day, closed: true, label: 'Court day', providerId: 'tech' });
    r = await book('gen', '15:00');
    out.AV1 = { ovOk: ov.ok !== undefined, refused: r.ok === undefined, n: bookings('gen'), ownWritten: DOCS.has('providerAvailability/gen/overrides/' + day), otherUntouched: !DOCS.has('providerAvailability/tech/overrides/' + day) };
    DOCS.set('users/cust2', { displayName: 'cust2' });
    const t1 = await book('tech', '13:00');
    const t2 = await book('tech', '13:00', 'cust2');
    const at13 = [...DOCS.keys()].filter((k) => k.startsWith('providerBookings/') && DOCS.get(k).providerId === 'tech' && DOCS.get(k).startTime === '13:00').length;
    out.AV2 = { first: t1.ok !== undefined, second: t2.ok === undefined, code: t2.code, at13 };
    const sa = await call(AVm.setProviderAvailability, 'gen', { providerId: 'tech', modes: ['open_24_7'], schedule: {}, appt: { durationMins: 45 } });
    const techAv = DOCS.get('providerAvailability/tech') || {};
    out.AV3 = { ok: sa.ok !== undefined, techUntouched: !(techAv.appt && techAv.appt.durationMins === 45), genSet: !!((DOCS.get('providerAvailability/gen') || {}).appt && DOCS.get('providerAvailability/gen').appt.durationMins === 45) };
    console.log('RESULT_JSON ' + JSON.stringify(out));
  })().catch((e) => { console.error(e && e.stack || e); process.exit(2); });
  return;
}

const NM = process.env.SOKONI_NODE_MODULES || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules';
function tree(ref) {
  if (!ref) return path.join(ROOT, 'functions');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bpg-'));
  cp.execSync('git archive ' + ref + ' functions | tar -x -C "' + d.replace(/\\/g, '/') + '"', { cwd: ROOT, shell: 'bash' });
  return path.join(d, 'functions');
}
function copyTree(src) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bpgm-'));
  cp.execSync('cp -r "' + src.replace(/\\/g, '/') + '" "' + d.replace(/\\/g, '/') + '/functions"', { shell: 'bash' });
  return path.join(d, 'functions');
}
function evaluate(FN) {
  const o = cp.spawnSync(process.execPath, [__filename, '--child', FN], { env: Object.assign({}, process.env, { NODE_PATH: NM }), encoding: 'utf8' });
  const line = (o.stdout || '').split('\n').find((l) => l.startsWith('RESULT_JSON '));
  return line ? JSON.parse(line.slice(12)) : { crash: (o.stderr || o.stdout || '').slice(-700) };
}
const rows = (x) => ({
  'G1 active generic provider: booking created (positive control)': !!x.G1 && x.G1.ok && x.G1.n === 1,
  'G1b active it_services provider: booking created (cross-category)': !!x.G1b && x.G1b.ok && x.G1b.n === 1,
  'G2 suspended provider: refused, no booking written': !!x.G2 && x.G2.refused && x.G2.n === 0,
  'G3 provider with no registry doc (never published): refused': !!x.G3 && x.G3.refused && x.G3.n === 0,
  'G4 acceptsBookings:false: refused': !!x.G4 && x.G4.refused && x.G4.n === 0,
  'G5 reinstated provider (status active again): bookable again': !!x.G5 && x.G5.ok && x.G5.n === 1,
  'G6 pending (unapproved) provider: refused': !!x.G6 && x.G6.refused && x.G6.n === 0,
  'G7 legal provider without LSK + admin verification (and booking flag closed): refused': !!x.G7 && x.G7.refused && x.G7.n === 0,
  'AV1 a date closed through the server override refuses a booking; the override lands ONLY on the caller (a providerId in the request is ignored)': !!x.AV1 && x.AV1.ovOk && x.AV1.refused && x.AV1.ownWritten && x.AV1.otherUntouched,
  'AV2 the booking transaction re-checks availability: a second booking on the same slot is refused': !!x.AV2 && x.AV2.first && x.AV2.second && x.AV2.at13 === 1,
  'AV3 a non-admin cannot configure another provider\'s availability (writes its own)': !!x.AV3 && x.AV3.ok && x.AV3.techUntouched && x.AV3.genSet,
});
let pass = 0, fail = 0;
const ck = (id, ok, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + (ok ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };

console.log('\nProvider activation gate at booking creation   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const FN = tree(process.env.BASE);
const x = evaluate(FN);
if (x.crash) { console.log('CRASH (no verdict, fail closed): ' + x.crash); process.exit(2); }
const R = rows(x);
for (const [k, v] of Object.entries(R)) ck(k, v, x);

if (Object.values(R).every(Boolean)) {
  const G1 = 'booking-service.js', G1A = "if (!prov || !ACTIVE_PROVIDER_STATES.includes(prov.status) || prov.acceptsBookings === false) {", G1B = 'if (!prov) {';
  const G2F = 'ent-availability.js', G2A = "if (!p || !['active', 'approved'].includes(p.status)) code = p && p.status === 'suspended' ? 'SUSPENDED' : 'NOT_APPROVED';", G2B = 'if (!p) code = \'NOT_APPROVED\';';
  const G2C = "else if (p.acceptsBookings === false) code = 'NOT_ACCEPTING';", G2D = '';
  const mutate = (edits) => {
    const d = copyTree(FN);
    for (const [f, a, b] of edits) { const p = path.join(d, f), s = fs.readFileSync(p, 'utf8'); if (s.split(a).length !== 2) return null; fs.writeFileSync(p, s.replace(a, () => b)); }
    return evaluate(d);
  };
  console.log('\n  [layer independence — not catches]');
  const one = mutate([[G1, G1A, G1B]]);
  const held = one && !one.crash && rows(one)[Object.keys(R).find((k) => k.startsWith('G2 '))];
  console.log('  ' + (held ? 'HOLDS ' : 'BROKE ') + ' booking-service status gate removed → availability authority still refuses the suspended provider');
  if (!held) fail++;
  console.log('\n  [mutations]');
  const both = mutate([[G1, G1A, G1B], [G2F, G2A, G2B]]);
  const k2 = Object.keys(R).find((k) => k.startsWith('G2 '));
  const c1 = !!both && !both.crash && rows(both)[k2] === false;
  console.log('  ' + (both === null ? 'MISSED (anchor 0x — UNPROVEN)' : c1 ? 'CAUGHT' : 'MISSED') + '  both status layers removed → G2'); if (!c1) fail++;
  const acc = mutate([[G1, G1A, G1B], [G2F, G2C, G2D]]);
  const k4 = Object.keys(R).find((k) => k.startsWith('G4 '));
  const c2 = !!acc && !acc.crash && rows(acc)[k4] === false;
  console.log('  ' + (acc === null ? 'MISSED (anchor 0x — UNPROVEN)' : c2 ? 'CAUGHT' : 'MISSED') + '  acceptsBookings ignored in both layers → G4'); if (!c2) fail++;
  const kA = Object.keys(R).find((k) => k.startsWith('AV2 '));
  const l1 = mutate([['booking-service.js', '    if (lock.exists) {', '    if (false) {']]);
  const h1 = !!l1 && !l1.crash && rows(l1)[kA] === true;
  console.log('  ' + (h1 ? 'HOLDS ' : 'BROKE ') + ' slot-lock check removed → the availability authority claim still refuses the overlap'); if (!h1) fail++;
  const l2 = mutate([['booking-service.js', '    if (lock.exists) {', '    if (false) {'], ['booking-service.js', "    if (!claimed.ok) { outcome = { conflict: 'avail', code: claimed.code }; return; }", ''], ['booking-service.js', "    if (overlapCount >= maxConcurrent) { outcome = { conflict: 'already-exists' }; return; }", '']]);
  const c3 = !!l2 && !l2.crash && rows(l2)[kA] === false;
  console.log('  ' + (l2 === null ? 'MISSED (anchor 0x — UNPROVEN)' : c3 ? 'CAUGHT' : 'MISSED') + '  all three overlap layers removed (slot lock + concurrency count + availability claim) → AV2'); if (!c3) fail++;
} else console.log('\n  [mutations] skipped — invariant does not hold on this tree.');
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
