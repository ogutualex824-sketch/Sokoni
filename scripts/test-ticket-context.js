#!/usr/bin/env node
/* ================================================================
   SOKONI — support-ticket business context (Slice V2), server-side proof
   scripts/test-ticket-context.js

   Loads the REAL functions/admin-os.js with firebase-admin stubbed (the
   Module._load pattern of scripts/test-approval-primitive.js) and drives the
   real handler `_h.adminCreateSupportTicket` — the same function
   adminOsDispatch invokes — so what is proven is the server's behaviour, not
   a re-implementation of it.

   PROVEN
     A  backward compatibility: a ticket with no context is written exactly as
        before (no `context` key at all, not null)
     B  a valid context is stored verbatim, empty fields dropped, and echoed
     C  refused, before any write: a non-object, an unknown field, an id with
        an unsafe alphabet, an over-long id, an array
     D  the client contract (sokoni-support-contact.js) agrees with the server:
        same closed key set, same alphabet, same "absent when none" rule —
        so the browser refuses what the server would refuse
   Exit: 0 all passed · 1 a test failed · 2 the harness could not run
   ================================================================ */
'use strict';
const path = require('path');
const Module = require('module');
const vm = require('vm');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); } };

/* ── firebase-admin stub: records every add() ────────────────────────────── */
const WRITES = [];
const SENTINEL = { __serverTimestamp: true };
const fakeDb = {
  collection: (name) => ({
    doc: (id) => ({ get: async () => ({ exists: name === 'users', data: () => ({ email: 'u@x', displayName: 'U' }), id }) }),
    add: async (doc) => { WRITES.push({ name, doc: JSON.parse(JSON.stringify(doc)) }); return { id: 'srv_' + WRITES.length }; },
    where() { return this; }, limit() { return this; }, get: async () => ({ docs: [], size: 0, empty: true }),
  }),
};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin/firestore') return { getFirestore: () => fakeDb, FieldValue: { serverTimestamp: () => SENTINEL, increment: (n) => n }, Timestamp: { now: () => new Date() } };
  if (request === 'firebase-admin/auth') return { getAuth: () => ({}) };
  if (request === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
  return realLoad.apply(this, arguments);
};
let ADMIN;
try { ADMIN = require(path.join(ROOT, 'functions', 'admin-os.js')); }
catch (e) { console.error('HARNESS ERROR — could not load functions/admin-os.js under the stub: ' + e.message); process.exit(2); }
finally { Module._load = realLoad; }
const handler = ADMIN._h && ADMIN._h.adminCreateSupportTicket;
if (typeof handler !== 'function') { console.error('HARNESS ERROR — _h.adminCreateSupportTicket not found'); process.exit(2); }

const req = (data) => ({ auth: { uid: 'user_1', token: {} }, data });
const refused = async (data) => { try { await handler(req(data)); return null; } catch (e) { return e.message; } };

(async () => {
  console.log('SUPPORT TICKET CONTEXT — server handler under stub\n');
  console.log('  [A — backward compatibility]');
  WRITES.length = 0;
  const r0 = await handler(req({ subject: 'S', message: 'M', category: 'other', priority: 'medium' }));
  ok('A1  a ticket with no context is created and returns the server id', r0 && r0.ticketId === 'srv_1', r0);
  ok('A2  …and the stored document carries NO context key at all (not null)', WRITES.length === 1 && !('context' in WRITES[0].doc), WRITES[0] && Object.keys(WRITES[0].doc));
  ok('A3  …with every pre-V2 field unchanged', WRITES[0] && WRITES[0].doc.status === 'open' && WRITES[0].doc.subject === 'S' && WRITES[0].doc.uid === 'user_1' && WRITES[0].doc.createdAt && WRITES[0].doc.createdAt.__serverTimestamp, WRITES[0] && WRITES[0].doc);

  console.log('\n  [B — a valid context]');
  WRITES.length = 0;
  const r1 = await handler(req({ subject: 'Verification REF-9', message: 'Docs unclear', category: 'verification', priority: 'high', context: { requestId: 'req_ABC-9', applicationId: '', verificationId: null } }));
  ok('B1  stored verbatim with empty fields dropped', WRITES[0] && JSON.stringify(WRITES[0].doc.context) === JSON.stringify({ requestId: 'req_ABC-9' }), WRITES[0] && WRITES[0].doc.context);
  ok('B2  …and echoed in the response', r1 && JSON.stringify(r1.context) === JSON.stringify({ requestId: 'req_ABC-9' }), r1);
  WRITES.length = 0;
  const r2 = await handler(req({ subject: 'S', message: 'M', context: { applicationId: 'app_1', verificationId: 'ver_2' } }));
  ok('B3  several keys are kept together', WRITES[0] && WRITES[0].doc.context.applicationId === 'app_1' && WRITES[0].doc.context.verificationId === 'ver_2' && r2.ticketId, WRITES[0] && WRITES[0].doc.context);
  WRITES.length = 0;
  await handler(req({ subject: 'S', message: 'M', context: { requestId: '' } }));
  ok('B4  a context with only empty fields is treated as none (no key stored)', WRITES[0] && !('context' in WRITES[0].doc), WRITES[0] && Object.keys(WRITES[0].doc));

  console.log('\n  [C — refused before any write]');
  for (const [label, ctx] of [
    ['a string', 'req_1'], ['an array', ['req_1']], ['an unknown field', { orderId: 'o1' }],
    ['an unsafe alphabet (path characters)', { requestId: '../users/x' }], ['an unsafe alphabet (spaces)', { requestId: 'a b' }],
    ['an over-long id', { requestId: 'x'.repeat(129) }], ['a non-string id', { applicationId: 42 }],
  ]) {
    WRITES.length = 0;
    const why = await refused({ subject: 'S', message: 'M', context: ctx });
    ok(`C   refuses ${label}: "${why}"`, !!why && /context/.test(why) && WRITES.length === 0, { why, writes: WRITES.length });
  }

  console.log('\n  [D — the client contract agrees with the server]');
  const src = fs.readFileSync(path.join(ROOT, 'sokoni-support-contact.js'), 'utf8');
  const sandbox = { window: {}, localStorage: { setItem() {} } }; sandbox.globalThis = sandbox.window;
  vm.runInNewContext(src, sandbox);
  const C = sandbox.window.SokoniSupportContact;
  ok('D1  the client exposes the same closed key set', C && JSON.stringify(C.CONTEXT_KEYS) === JSON.stringify(ADMIN.TICKET_CONTEXT_KEYS), C && C.CONTEXT_KEYS);
  const sameVerdict = (ctx) => {
    let server; try { server = ADMIN._ticketContext(ctx); } catch (_) { server = 'REFUSED'; }
    const client = C.contextFor(ctx); return (server === 'REFUSED') === (client === false) && (server === null) === (client === null);
  };
  ok('D2  client and server give the same verdict on the same inputs',
     [{ requestId: 'r1' }, { orderId: 'x' }, 'str', ['a'], { requestId: '../x' }, { requestId: '' }, null, undefined, { applicationId: 'x'.repeat(129) }].every(sameVerdict));
  const p = C.payloadFor({ subject: 'S', message: 'M', context: { requestId: 'r1', applicationId: '' } });
  ok('D3  payloadFor carries context only when present, absent otherwise', JSON.stringify(p.context) === JSON.stringify({ requestId: 'r1' }) && !('context' in C.payloadFor({ subject: 'S', message: 'M' })), p);
  ok('D4  validate refuses a malformed context before anything leaves the browser', C.validate({ subject: 'S', message: 'M', context: { orderId: 'x' } }).reason === 'invalid_context' && C.validate({ subject: 'S', message: 'M', context: { requestId: 'r1' } }).ok === true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR — ' + e.message); process.exit(2); });
