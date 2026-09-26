'use strict';
/**
 * CERTIFICATION — business scope: only an ADMIN APPROVAL can make a business "trading".
 *
 * The defect (feat/dual-business-commerce, shared/business-scope.js): a registry record with NO
 * status counted as live, and a live status alone qualified. Both are writable by the account
 * itself on its own records, so any signed-in user could grant themselves products AND services
 * scope. The repair: approval needs a live status AND protected approval evidence (approvedAt /
 * approved / adminApproved), and the seller approval writer (application-lifecycle projectSeller)
 * now stamps approvedAt/approvedBy — before it wrote only the self-writable status/active.
 *
 * Proves, against the Firestore emulator:
 *   R  the SERVED production rules (SERVED_RULES_PATH) stop an account reaching an approved end
 *      state on its own sellers/{uid} or providers/{uid} — by create AND by update — and the
 *      records it CAN write are rejected by business-scope. An allow-all counterproof ruleset
 *      accepts every attempt, so each denial is the rules' verdict.
 *   W  the REAL approval writer: projectSeller(approved) -> the seller record carries the
 *      protected marker -> business-scope accepts it; projectSeller(suspended) -> refuses again.
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Pointed at the pre-repair tree it must FAIL.
 * Refuses without FIRESTORE_EMULATOR_HOST or SERVED_RULES_PATH.
 */
const path = require('path');
const fs = require('fs');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
if (!process.env.SERVED_RULES_PATH) { console.error('REFUSED: SERVED_RULES_PATH is not set — the served ruleset is the subject.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
const PROJECT = 'demo-bizscope';
process.env.GCLOUD_PROJECT = PROJECT;
const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');

const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
const BS = require(path.join(FN, 'shared', 'business-scope.js'));
let LC = null;
try { LC = require(path.join(FN, 'application-lifecycle.js'))._internal; } catch (e) { LC = { __err: e.message }; }
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
const adb = admin.firestore();

let pass = 0, fail = 0;
const ok = (c, id, m) => { if (c) { pass++; console.log('  PASS', id, m); } else { fail++; console.log('  FAIL', id, m); } };
const scope = (seller, provider) => BS.resolveBusinessScope({ seller, provider });

async function attempt(db, fn) { try { await fn(db); return 'ALLOWED'; } catch (e) { return 'DENIED'; } }

(async () => {
  const served = fs.readFileSync(process.env.SERVED_RULES_PATH, 'utf8');
  const allowAll = "rules_version = '2';\nservice cloud.firestore { match /databases/{d}/documents { match /{p=**} { allow read, write: if true; } } }";
  console.log(`\nBusiness scope — only an admin approval makes a business trading   (tree: ${ROOT})\n`);

  for (const [label, rules] of [['SERVED', served], ['ALLOW-ALL', allowAll]]) {
    const env = await initializeTestEnvironment({ projectId: PROJECT + '-' + label.toLowerCase().replace(/[^a-z]/g, ''),
      firestore: { rules, host, port: Number(port) } });
    await env.clearFirestore();
    const U = 'self-user';
    const db = env.authenticatedContext(U).firestore();
    const read = async (col) => { let d = null; await env.withSecurityRulesDisabled(async (c) => {
      const s = await c.firestore().collection(col).doc(U).get(); d = s.exists ? s.data() : null; }); return d; };
    const r = {};

    /* ── sellers/{uid} ── */
    r.sellerSelfActive = await attempt(db, (d) => d.collection('sellers').doc(U).set({ uid: U, status: 'active', active: true, shopName: 'Mine' }));
    const selfSeller = await read('sellers');
    for (const f of ['approvedAt', 'approvedBy', 'approved', 'adminApproved']) {
      const v = f === 'approved' || f === 'adminApproved' ? true : 'forged';
      r['sellerUpdate_' + f] = await attempt(db, (d) => d.collection('sellers').doc(U).set({ [f]: v }, { merge: true }));
    }
    await env.withSecurityRulesDisabled(async (c) => { await c.firestore().collection('sellers').doc(U).delete(); });
    r.sellerCreateWithMarker = await attempt(db, (d) => d.collection('sellers').doc(U).set({ uid: U, status: 'active', approvedAt: 'forged' }));

    /* ── providers/{uid} ── */
    r.providerCreateActive = await attempt(db, (d) => d.collection('providers').doc(U).set({ uid: U, status: 'active' }));
    r.providerCreateNoStatus = await attempt(db, (d) => d.collection('providers').doc(U).set({ uid: U, name: 'Me' }));
    const selfProvider = await read('providers');
    r.providerUpdateStatusActive = await attempt(db, (d) => d.collection('providers').doc(U).set({ status: 'active' }, { merge: true }));
    r.providerUpdateApprovedAt = await attempt(db, (d) => d.collection('providers').doc(U).set({ approvedAt: 'forged', adminApproved: true }, { merge: true }));
    const selfProviderAfter = await read('providers');
    await env.cleanup();

    if (label === 'SERVED') {
      console.log('[R] served production rules');
      ok(r.sellerSelfActive === 'ALLOWED', 'R1', `an account may write its own seller {status:'active', active:true} (${r.sellerSelfActive}) — the fields the old resolver trusted`);
      const s1 = scope(selfSeller, null);
      ok(!!selfSeller && !s1.sellsProducts && s1.reasons.products === 'not_approved', 'R2',
        `…and business-scope REJECTS that self-written record (products=${s1.sellsProducts}, reason=${s1.reasons.products})`);
      ok(['approvedAt', 'approvedBy', 'approved', 'adminApproved'].every((f) => r['sellerUpdate_' + f] === 'DENIED'), 'R3',
        'the account cannot ADD any protected approval field to its own seller record: ' +
        ['approvedAt', 'approvedBy', 'approved', 'adminApproved'].map((f) => f + ' ' + r['sellerUpdate_' + f]).join(', '));
      ok(r.sellerCreateWithMarker === 'DENIED', 'R4', `…nor CREATE one carrying approvedAt (${r.sellerCreateWithMarker})`);
      ok(r.providerCreateActive === 'DENIED', 'R5', `an account cannot create its own provider as status 'active' (${r.providerCreateActive})`);
      ok(r.providerCreateNoStatus === 'ALLOWED' && !!selfProvider && !scope(null, selfProvider).providesServices, 'R6',
        `it CAN create one with no status (${r.providerCreateNoStatus}) — and business-scope grants no services for it (the old resolver did)`);
      ok(r.providerUpdateStatusActive === 'DENIED', 'R7', `…and cannot update that record to status 'active' (${r.providerUpdateStatusActive})`);
      /* The provider owner-update rule does NOT withhold approvedAt/adminApproved (it blocks only
         status/verified/suspended/approved). Recorded, not hidden: whatever it adds, the record
         stays status-less, so the approved END STATE is still unreachable. */
      const sp = scope(null, selfProviderAfter);
      ok(!sp.providesServices, 'R8',
        `even after trying to add approvedAt/adminApproved (${r.providerUpdateApprovedAt} by the served rules), the self-made provider grants NO services — the status gate holds`);
      ok(!scope(selfSeller, selfProviderAfter).isTrading, 'R9', 'a fully self-made "dual business" trades NOTHING');
    } else {
      console.log('\n[R-CP] counterproof: allow-all ruleset accepts every attempt (so the denials above are rules verdicts)');
      const all = Object.entries(r).filter(([, v]) => v !== 'ALLOWED').map(([k]) => k);
      ok(all.length === 0, 'R-CP', all.length ? 'not allowed under allow-all: ' + all.join(', ') : 'every attempt ALLOWED');
    }
  }

  /* ── W: the real approval writer ── */
  console.log('\n[W] the approval writer -> protected marker -> business-scope');
  if (!LC || LC.__err || typeof LC.projectSeller !== 'function') {
    ok(false, 'W0', 'application-lifecycle.projectSeller could not be loaded: ' + (LC && LC.__err));
  } else {
    const uid = 'approved-merchant';
    await adb.collection('sellers').doc(uid).delete().catch(() => {});
    await adb.collection('shops').doc(uid).delete().catch(() => {});
    const app = { applicationId: 'app-w1', uid, name: 'Kass Cyber', decidedBy: 'admin-uid-1', status: 'approved' };
    await LC.projectSeller(adb, app, uid, true);
    const sel = (await adb.collection('sellers').doc(uid).get()).data() || {};
    ok(sel.approvedAt != null && sel.approvedBy === 'admin-uid-1', 'W1',
      `approval writes the protected marker on the seller record (approvedAt=${sel.approvedAt ? 'set' : 'MISSING'}, approvedBy=${sel.approvedBy})`);
    const s = scope(sel, null);
    ok(s.sellsProducts && s.reasons.products === 'approved', 'W2', `…and business-scope ACCEPTS the approved seller (products=${s.sellsProducts})`);
    const browser = { uid: 'browser-merchant', status: 'active', active: true, shopName: 'Mine' };
    ok(!scope(browser, null).sellsProducts, 'W3', "a browser-created {status:'active', active:true} with no marker is REJECTED");
    await LC.projectSeller(adb, app, uid, false);
    const sus = (await adb.collection('sellers').doc(uid).get()).data() || {};
    ok(!scope(sus, null).sellsProducts, 'W4', `a later suspension revokes it despite the marker (status=${sus.status}, active=${sus.active})`);
  }

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(2); });
