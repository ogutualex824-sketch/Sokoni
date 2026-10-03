#!/usr/bin/env node
/* Deliberate breakages of the Legal L4 booking chain; each must turn its NAMED row red in test-legal-booking-chain. */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const M = [
  ['booking flag left closed', 'legal-verification.js', 'const LEGAL_BOOKING_ENABLED = true;', 'const LEGAL_BOOKING_ENABLED = false;', 'C3'],
  ['projection opens booking regardless of eligibility', 'legal-verification.js',
    'searchable: el.bookable, isPublic: el.bookable, available: el.bookable, acceptsBookings: el.bookable,',
    'searchable: true, isPublic: true, available: true, acceptsBookings: true,', 'C1'],
  ['suspension leaves the rate card on', 'legal-verification.js',
    '{ active: el.bookable && Number((svcS.data() || {}).price) > 0, updatedAt: _ts() }',
    '{ active: Number((svcS.data() || {}).price) > 0, updatedAt: _ts() }', 'C8'],
  ['fee edit does not re-price the rate card', 'legal-hub.js',
    "if ('consultationFee' in patch && sv.exists && sv.data().createdBy === LV.PROV_BY) {", 'if (false) {', 'C7'],
  ['retired Legal booking engine restored to writing', 'legal-hub.js',
    "  requireAuth(req);\n  throw new HttpsError('failed-precondition', 'Legal consultations are booked",
    "  requireAuth(req); await db().collection('legalConsultations').doc('x').set({ ok: 1 });\n  throw new HttpsError('failed-precondition', 'Legal consultations are booked", 'C6'],
  ['any provider may tag a Legal practice area', 'provider-ops.js', "if (!ps.exists || require('./business-category').categoryOf(ps.data()) !== 'lawyer') {", 'if (false) {', 'C10'],
  ['specialist rate card without confirmation', 'provider-ops.js', "if (!ls.exists || TAX.specialistConfirmedOf(ls.data()).indexOf(id) < 0) {", 'if (false) {', 'C11'],
  ['paid receipt hook removed from the webhook hold', 'booking-payment-sweep.js', '      await BR.paid(db, bookingId, apiRef);', '', 'C12'],
  ['release receipt hook removed from PIN settlement', 'provider-ops.js', "settleOnPinRelease', { bookingId, uid, gross: m.gross, commission: m.commission, credited: out.credited });\n  if (out && out.credited !== undefined) await require('./shared/booking-receipts').released(_db(), bookingId, m);", "settleOnPinRelease', { bookingId, uid, gross: m.gross, commission: m.commission, credited: out.credited });", 'C13'],
  ['refund receipt hook removed from cancellation disbursement', 'provider-ops.js', "    await BR.refunded(_db(), ref.id, refundC, ref.id + '_refund',", "    void (_db(), ref.id, refundC, ref.id + '_refund',", 'C14'],
  ['refund receipt hook removed from the reversal after settlement', 'provider-ops.js', "  if (out && out.reversed) await require('./shared/booking-receipts').refunded(DB(), ref.id, _rcptPaidCents, ref.id + '_reversal', 'refund_after_settlement');", '', 'C15'],
  ['paid receipt queued WITHOUT a replay (cannot be retried)', 'shared/booking-receipts.js', "() => R.recordPaid(db, args, deps), { op: 'paid', args });", '() => R.recordPaid(db, args, deps));', 'C16'],
  ['release recorded without the SOKONI commission', 'shared/booking-receipts.js', 'platformFeeCents: commission, providerNetCents: settle,', 'platformFeeCents: 0, providerNetCents: settle,', 'C13'],
];
let caught = 0, missed = 0;
for (const [name, file, a, b, row] of M) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lgbs-'));
  cp.execSync('cp -r "' + path.join(ROOT, 'functions').split(path.sep).join('/') + '" "' + d.split(path.sep).join('/') + '/functions"', { shell: 'bash' });
  const f = path.join(d, 'functions', file);
  const s = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  if (s.split(a).length !== 2) { console.log('  MISSED  ' + name + ' (anchor ' + (s.split(a).length - 1) + 'x — UNPROVEN)'); missed++; continue; }
  fs.writeFileSync(f, s.replace(a, () => b));
  const o = cp.spawnSync(process.execPath, [path.join(__dirname, 'test-legal-booking-chain.js')], { env: Object.assign({}, process.env, { FN_DIR: path.join(d, 'functions') }), encoding: 'utf8' });
  const out = o.stdout || '';
  const red = new RegExp('^  FAIL ' + row + ' ', 'm').test(out) && !/CRASH/.test(out);
  console.log('  ' + (red ? 'CAUGHT' : 'MISSED') + '  ' + name + ' → ' + row);
  red ? caught++ : missed++;
}
console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught');
process.exit(missed ? 1 : 0);
