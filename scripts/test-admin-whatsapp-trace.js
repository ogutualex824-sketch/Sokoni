#!/usr/bin/env node
/* test-admin-whatsapp-trace.js — AdminOS WhatsApp delivery trace (functions/admin-notification-trace.js), executed.
 *   A  guard: no auth / plain user refused; admin and superAdmin claims allowed
 *   F  whitelist: only named fields leave the server — a stray `params`/`code` on a record is NEVER returned
 *   Q  filters: messageId (found / not found), ref, status (bad status refused), limit capped at 200
 *   D  registered in the ONE adminOsDispatch registry (no second admin surface)
 *   Z  negative controls
 * Run: node scripts/test-admin-whatsapp-trace.js
 */
'use strict';
const path = require('path'), fs = require('fs');
const FN = path.join(__dirname, '..', 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, g) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + JSON.stringify(g) + ']')); ok ? pass++ : fail++; };
const PIN = '774102';

const DOCS = {
  'wamid.A': { template: 'otp_code', category: 'authentication', secret: true, toMasked: '25471*****78', status: 'read', ref: 'otp:u1:1', channel: 'WHATSAPP',
    acceptedAt: '2026-10-03T08:00:00.000Z', sentAt: '2026-10-03T08:00:01.000Z', deliveredAt: '2026-10-03T08:00:02.000Z', readAt: '2026-10-03T08:00:09.000Z',
    params: { code: PIN }, uid: 'u1' },                    /* params planted: must never be returned */
  'wamid.B': { template: 'order_confirmation', toMasked: '25471*****78', status: 'failed', ref: 'order_placed:u1:x', errorCode: 131026,
    acceptedAt: '2026-10-03T09:00:00.000Z', failedAt: '2026-10-03T09:00:03.000Z' },
  'wamid.C': { template: 'payment_received', toMasked: '25471*****78', status: 'delivered', ref: 'pay:u2:1',
    acceptedAt: '2026-10-03T07:00:00.000Z', deliveredAt: '2026-10-03T07:00:02.000Z' },
};
let lastLimit = null;
function fakeDb () {
  const q = (filters) => ({
    where: (f, op, v) => q(filters.concat([[f, v]])),
    orderBy: () => q(filters),
    limit: (n) => ({ get: async () => { lastLimit = n; return { docs: Object.entries(DOCS).filter(([, d]) => filters.every(([f, v]) => d[f] === v)).slice(0, n).map(([id, d]) => ({ id, data: () => d })) }; } }),
  });
  return { collection: () => Object.assign(q([]), { doc: (id) => ({ get: async () => ({ exists: !!DOCS[id], id, data: () => DOCS[id] }) }) }) };
}
const deps = { db: fakeDb() };
const H = require(path.join(FN, 'admin-notification-trace.js'))._h.adminListWhatsappSends;
const admin = { auth: { uid: 'a', token: { admin: true } } };

(async () => {
  console.log('\n── A: guard ──');
  const refused = async (req) => { try { await H(req, deps); return false; } catch (e) { return /admin required/.test(e.message); } };
  ck('A1 no auth → refused', await refused({ data: {} }));
  ck('A2 signed-in non-admin → refused', await refused({ auth: { uid: 'u', token: {} }, data: {} }));
  ck('A3 admin claim → allowed', (await H({ ...admin, data: {} }, deps)).count === 3);
  ck('A4 superAdmin claim → allowed', (await H({ auth: { uid: 's', token: { superAdmin: true } }, data: {} }, deps)).count === 3);

  console.log('\n── F: whitelist ──');
  const all = await H({ ...admin, data: {} }, deps);
  const blob = JSON.stringify(all);
  ck('F1 a planted params/PIN on a record is NEVER returned', !blob.includes(PIN) && !blob.includes('"params"'), blob.slice(0, 200));
  ck('F2 uid is not returned (masked number + notification key identify the message)', !blob.includes('"uid"'));
  const a = all.sends.find((x) => x.messageId === 'wamid.A');
  ck('F3 row carries channel, template, masked to, Meta id, status, all four timestamps', a && a.channel === 'WHATSAPP' && a.template === 'otp_code' && a.toMasked === '25471*****78' && a.status === 'read' && a.sentAt && a.deliveredAt && a.readAt && a.acceptedAt, a);
  const b = all.sends.find((x) => x.messageId === 'wamid.B');
  ck('F4 a failed message shows failedAt + Meta error code, and no deliveredAt', b && b.status === 'failed' && b.failedAt && b.errorCode === 131026 && !b.deliveredAt, b);
  ck('F5 newest first by acceptedAt', all.sends.map((x) => x.messageId).join() === 'wamid.B,wamid.A,wamid.C', all.sends.map((x) => x.messageId));

  console.log('\n── Q: filters ──');
  let r = await H({ ...admin, data: { messageId: 'wamid.C' } }, deps);
  ck('Q1 messageId → exactly that message', r.found === true && r.sends.length === 1 && r.sends[0].status === 'delivered', r);
  r = await H({ ...admin, data: { messageId: 'wamid.NOPE' } }, deps);
  ck('Q2 unknown messageId → found:false, empty (not an invented row)', r.found === false && r.sends.length === 0, r);
  r = await H({ ...admin, data: { ref: 'order_placed:u1:x' } }, deps);
  ck('Q3 ref → the message(s) that notification produced', r.count === 1 && r.sends[0].messageId === 'wamid.B', r);
  r = await H({ ...admin, data: { status: 'delivered' } }, deps);
  ck('Q4 status filter', r.count === 1 && r.sends[0].messageId === 'wamid.C', r);
  let threw = false; try { await H({ ...admin, data: { status: 'sent-ish' } }, deps); } catch (_) { threw = true; }
  ck('Q5 an unknown status is refused, not silently ignored', threw);
  await H({ ...admin, data: { limit: 99999 } }, deps);
  ck('Q6 limit capped at 200', lastLimit === 200, lastLimit);

  console.log('\n── D: one registry ──');
  const disp = fs.readFileSync(path.join(FN, 'admin-os-dispatch.js'), 'utf8');
  ck('D1 admin-os-dispatch merges admin-notification-trace._h into the ONE registry', /require\('\.\/admin-notification-trace'\)/.test(disp) && /notifyTrace\._h/.test(disp));

  console.log('\n── Z: negative controls ──');
  ck('Z1 the planted PIN IS in the raw record (F1 is not vacuous)', JSON.stringify(DOCS['wamid.A']).includes(PIN));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack)); process.exit(2); });
