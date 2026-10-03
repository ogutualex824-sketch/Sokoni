#!/usr/bin/env node
'use strict';
/* businessWorkspace ownerState / editable (e3 + f3 P0-F, 2026-10-03) — pure derivation, mirrors f3's rule 1896712. */
const Path = require('path');
const FN = Path.join(__dirname, '..', 'functions');
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin', { apps: [1], initializeApp() {}, firestore: Object.assign(() => ({}), { FieldValue: {} }), auth: () => ({}) });
stub('firebase-admin/auth', { getAuth: () => ({ getUser: async (uid) => ({ uid, customClaims: {} }) }) });
const BW = require(Path.join(FN, 'business-workspace.js'));
let pass = 0, fail = 0;
const ck = (id, ok, msg, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + msg + (ok ? '' : '  got=' + JSON.stringify(got))); ok ? pass++ : fail++; };
const o = (p, s, f) => BW.ownerStateOf(p, s, f);
const eq = (r, st, ed) => r.ownerState === st && r.editable === ed;

ck('O-1', eq(o({ status: 'active' }, { isVisible: true }, null), 'active', true), 'CONTROL: an active provider + shop is editable', o({ status: 'active' }));
ck('O-2', eq(o(null, null, null), 'active', true), 'CONTROL: no provider / shop / freeze → active, editable (a buyer editing their own profile)', o(null, null, null));
for (const st of BW.EDITABLE_STATUSES) ck('O-3 ' + st, eq(o({ status: st }), 'active', true), 'P0-F allow-listed status "' + st + '" is editable', o({ status: st }));
ck('O-4', eq(o({ status: 'active' }, null, { active: true, by: 'admin' }), 'frozen', false), 'an ADMIN freeze → frozen, read-only', o({ status: 'active' }, null, { active: true, by: 'admin' }));
ck('O-5', eq(o({ status: 'active' }, null, { active: true, by: 'self' }), 'deactivated', false), 'a self deactivation → deactivated, read-only', o({}, null, { active: true, by: 'self' }));
ck('O-6', eq(o({ status: 'deactivated' }), 'deactivated', false) && eq(o({ status: 'active', deactivated: true }), 'deactivated', false) && eq(o(null, { deactivated: true }), 'deactivated', false),
  'provider status / flag or shop flag deactivated → read-only', [o({ status: 'deactivated' }), o(null, { deactivated: true })]);
ck('O-7', ['suspended', 'banned', 'revoked'].every((st) => eq(o({ status: st }), 'suspended', false)) && eq(o({ status: 'active', suspended: true }), 'suspended', false)
  && eq(o(null, { banned: true }), 'suspended', false) && eq(o(null, { suspended: true }), 'suspended', false), 'suspended / banned / revoked (status or flags, provider or shop) → suspended, read-only', null);
ck('O-8', eq(o({}), 'active', false) && eq(o({ status: 'weird' }), 'active', false) && eq(o({ status: 'rejected' }), 'active', false),
  'a MISSING or unknown provider status is read-only (P0-F fails closed)', [o({}), o({ status: 'weird' })]);
ck('O-9', eq(o({ status: 'suspended' }, null, { active: true, by: 'admin' }), 'frozen', false), 'precedence: an admin freeze wins over suspension', o({ status: 'suspended' }, null, { active: true, by: 'admin' }));
ck('O-10', eq(o({ status: 'active' }, null, { active: false, by: 'admin' }), 'active', true), 'a LIFTED freeze no longer blocks', o({ status: 'active' }, null, { active: false, by: 'admin' }));
ck('O-11', JSON.stringify(BW.EDITABLE_STATUSES) === JSON.stringify(['active', 'approved', 'pending', 'pending_approval', 'pending_review', 'info_requested', 'draft']),
  'the editable statuses are EXACTLY f3 P0-F 1896712\'s allow-list', BW.EDITABLE_STATUSES);
/* O-12 / O-13: the businessWorkspace ANSWER carries it (real workspaceFor on a minimal in-memory store) */
(async () => {
  const mk = (docs, failOn) => { const d = (c, id) => ({ get: async () => { if (failOn && failOn === c) throw new Error('unavailable'); const k = c + '/' + id; return { exists: k in docs, id, data: () => docs[k] }; } });
    const q = () => ({ where: q, limit: q, orderBy: q, get: async () => ({ docs: [], empty: true, size: 0 }) });
    return { collection: (c) => Object.assign({ doc: (id) => d(c, id) }, q()), doc: (p) => { const [c, id] = p.split('/'); return d(c, id); } }; };
  let w = await BW.workspaceFor(mk({ 'providers/u1': { status: 'active' }, 'accountFreezes/u1': { active: true, by: 'admin' } }), 'u1');
  ck('O-12', w.ownerState === 'frozen' && w.editable === false, 'the businessWorkspace answer carries ownerState + editable', [w.ownerState, w.editable]);
  w = await BW.workspaceFor(mk({ 'providers/u2': { status: 'active' } }, 'accountFreezes'), 'u2');
  ck('O-13', w.ownerState === 'unknown' && w.editable === false, 'unreadable owner evidence → ownerState unknown, read-only (fail closed)', [w.ownerState, w.editable]);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
