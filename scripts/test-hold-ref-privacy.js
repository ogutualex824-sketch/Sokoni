#!/usr/bin/env node
/* test-hold-ref-privacy.js — the take-down hold reference is UNLINKABLE to the reporter (privacy fix 2026-10-03).
 *
 *   node scripts/test-hold-ref-privacy.js                       # working tree — must PASS
 *   SABOTAGE=<name> node scripts/test-hold-ref-privacy.js       # one fault, injected into a TEMP COPY (never the tree)
 *   node scripts/test-hold-ref-privacy.js --failure-injection   # every fault: each must fail its NAMED row; the tree's
 *                                                               # file is hashed before and after
 *
 * THE DEFECT. products/{id} is world-readable. The hold carried ref = sha256(reportId)[:16] and reportId is
 * `{reporterUid}_product_{productId}`. Reporter uids are public elsewhere (authorUid on approved reviews), so anyone could
 * hash candidate uids against the hold and name the reporter. The seller's scope:'mine' rows carried the same hash.
 *
 * THE FIX. The hold ref is RANDOM (crypto.randomBytes(12) base64url), generated at take-down, stored on the REPORT
 * (server-only) as holdRef. Every lookup reads report.holdRef — nothing recomputes a hash of a report id. A seller's row
 * carries the report's random publicRef. Restore keeps DELETING moderationHold (FieldValue.delete), never {active:false}.
 * A legacy hold (sha16 ref / reportId, no report stores its ref) is refused with LEGACY_HOLD_NO_HOLDREF — never guessed.
 *
 * REAL functions/trust-safety.js on the transactional fake Firestore (scripts/lib/fake-firestore-txn.js, strict read
 * order). NO PRODUCTION, NO NETWORK, NO EMULATOR. TRIPWIRES (incident 2026-10-01): `firebase-admin` and `./notify` THROW
 * on require; row Z1 asserts neither was loaded and both are unloadable.
 *
 * ROWS
 *   Z1 tripwires held
 *   H1 take-down: hold.ref is 16-char base64url, === report.holdRef, !== sha16(reportId)
 *   H2 unlinkable: knowing reportId + the reporter's uid (and every candidate uid) gives NO match under any hash shape;
 *      a second take-down of the SAME report (reopen → uphold) gets a DIFFERENT ref — the ref is not a function of the id
 *   H3 the seller's scope:'mine' ref is the report's random publicRef, never sha16(reportId)
 *   H4 restore finds the hold via report.holdRef; moderationHold is DELETED (key absent, not {active:false}); release
 *      record + audit row carry only the random ref; the promotion paused by that ref resumes
 *   H5 a report whose holdRef does not match the hold is refused (HELD_BY_OTHER_REPORT); the listing is untouched
 *   H6 a LEGACY hold (sha16 ref, report without holdRef; and a pre-10-02 reportId hold) is refused with
 *      LEGACY_HOLD_NO_HOLDREF — the listing is untouched; the case view marks it legacy and offers no restore
 *   H7 the case view resolves the owning report through holdRef and never returns the raw ref
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), Module = require('module'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const TARGET = 'trust-safety.js';

const SABOTAGES = {
  'ref-is-sha16':          { catch: 'H1', from: 'holdRef = _newRef();      /*', to: 'holdRef = _opaqueRef(reportId);      /*' },
  'restore-writes-inactive': { catch: 'H4', from: '      tx.set(pref, { isVisible: prior, moderationHold: FieldValue.delete(),',
    to: '      tx.set(pref, { isVisible: prior, moderationHold: { active: false },' },
  'lookup-recomputes-sha16': { catch: 'H6', from: "if (c && c.id && typeof c.holdRef === 'string' && c.holdRef && c.holdRef === hold.ref) return c.id;",
    to: 'if (c && c.id && ((c.holdRef && c.holdRef === hold.ref) || hold.ref === _opaqueRef(c.id))) return c.id;' },
  'seller-ref-sha16':      { catch: 'H3', from: '      ref: r.publicRef || null,\n      entityType: r.entityType || null,',
    to: '      ref: _opaqueRef(d.id),\n      entityType: r.entityType || null,' },
  'holdref-not-stored':    { catch: 'H1', from: "if (primary && enforcement === 'listing_hidden' && holdRef) patch.holdRef = holdRef;", to: '' },
};

if (process.argv.includes('--failure-injection')) {
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(FN, TARGET))).digest('hex');
  const before = hash(); let ok = true;
  for (const [name, s] of Object.entries(SABOTAGES)) {
    const r = cp.spawnSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: name }), encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    const caught = new RegExp('FAIL  ' + s.catch + ' ').test(out);
    console.log(`  ${caught ? 'CAUGHT' : 'MISSED'}  ${name} → ${s.catch}${caught ? '' : '\n' + out.slice(-800)}`);
    if (!caught) ok = false;
  }
  const same = hash() === before;
  console.log(`\nfailure injection: ${ok ? 'every fault caught by its named row' : 'A FAULT WAS MISSED'}; tree file unchanged: ${same}`);
  process.exit(ok && same ? 0 : 1);
}

/* ── tripwires ── */
let tripped = { admin: 0, notify: 0 };
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin') { tripped.admin++; throw new Error('TRIPWIRE: firebase-admin required from a test'); }
  if (id === './notify' || /[\\/]notify(\.js)?$/.test(id)) { tripped.notify++; throw new Error('TRIPWIRE: notify.js required from a test'); }
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  return origReq.apply(this, arguments);
};

let srcFile = path.join(FN, TARGET), TMP = null;
if (process.env.SABOTAGE) {
  const s = SABOTAGES[process.env.SABOTAGE];
  if (!s) { console.error('unknown SABOTAGE'); process.exit(2); }
  let src = fs.readFileSync(srcFile, 'utf8');
  const crlf = src.includes('\r\n'); if (crlf) src = src.replace(/\r\n/g, '\n');
  if (!src.includes(s.from)) { console.log('  FAIL  ' + s.catch + ' (sabotage anchor not found — the test is stale)'); process.exit(1); }
  src = src.replace(s.from, s.to);
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'holdref-'));
  srcFile = path.join(TMP, TARGET); fs.writeFileSync(srcFile, src);
}

let pass = 0, fail = 0;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const rows = [];
const ck = (n, ok, d) => { rows.push({ n, ok: !!ok }); if (ok) { pass++; say('  PASS  ' + n); } else { fail++; say('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 400) : '')); } };
const tryv = async (p) => { try { return await p; } catch (e) { return { error: e.code || e.message, reason: e.details && e.details.reason }; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const as = (uid, data, token) => ({ auth: uid ? { uid, token: token || {} } : null, data });
const ADMIN = { admin: true }, SUPER = { admin: true, superAdmin: true };
const sha16 = (x) => crypto.createHash('sha256').update(String(x)).digest('hex').slice(0, 16);
const B64 = /^[A-Za-z0-9_-]{16}$/;
/* every deterministic shape an attacker would try from (reportId) — none may equal the hold ref */
const shapes = (id) => {
  const h = (alg, enc) => crypto.createHash(alg).update(String(id)).digest(enc);
  return [h('sha256', 'hex'), h('sha256', 'hex').slice(0, 16), h('sha256', 'base64url'), h('sha256', 'base64url').slice(0, 16),
    crypto.createHash('sha256').update(String(id)).digest().subarray(0, 12).toString('base64url'),
    h('sha1', 'hex').slice(0, 16), h('md5', 'hex').slice(0, 16), String(id)];
};

(async () => {
  say('\nSOURCE: ' + (process.env.SABOTAGE ? 'SABOTAGE=' + process.env.SABOTAGE + ' (temp copy)' : 'working tree'));
  const TS = require(srcFile);
  const sent = [];
  TS._setNotifier(async (uid, msg, key) => { sent.push({ uid, key }); return { status: 'recorded' }; });

  const SELLER = 'sellerA', BUY = 'buyer1', P = 'pH';
  await db.doc('products/' + P).set({ name: 'Kanga', sellerUid: SELLER, shopId: 'shopA', price: 700, status: 'active', isVisible: true });
  await db.doc('users/' + SELLER).set({ status: 'active' });
  await db.doc('shops/shopA').set({ name: 'A', status: 'active' });
  await db.doc('featuredListings/f1').set({ itemId: P, itemType: 'product', status: 'active' });
  /* public uids an attacker can list (e.g. authorUid on approved reviews) — the reporter is among them */
  const publicUids = ['u1', 'u2', BUY, 'u3', SELLER];

  const rep = await tryv(TS.tsReportContent(as(BUY, { entityType: 'product', entityId: P, reasonCode: 'counterfeit', detail: 'fake logo' })));
  const reportId = rep.reportId;
  const up = await tryv(TS.tsReviewReport(as('adm1', { reportId, action: 'approve', hideProduct: true, resolution: 'Counterfeit confirmed' }, ADMIN)));
  const held = await get('products/' + P);
  const r1 = await get('reports/' + reportId);
  const ref1 = held && held.moderationHold && held.moderationHold.ref;
  ck('H1 take-down: hold.ref is a 16-char base64url random id, === report.holdRef (stored server-side), !== sha16(reportId)',
    up.enforcement === 'listing_hidden' && B64.test(String(ref1)) && r1.holdRef === ref1 && ref1 !== sha16(reportId), { up, hold: held && held.moderationHold, holdRef: r1 && r1.holdRef });

  const guesses = publicUids.flatMap((u) => shapes(`${u}_product_${P}`).concat(shapes(`${u}_listing_${P}`), shapes(u)));
  const pausedByRef = (await get('featuredListings/f1')).pausedByRef;
  ck('H2a unlinkable: reportId + every candidate uid (reporter included) under every hash shape gives NO match with the hold ref',
    !!ref1 && reportId === `${BUY}_product_${P}` && !guesses.includes(ref1) && pausedByRef === ref1 && !guesses.includes(pausedByRef), { ref1, n: guesses.length });

  const mine = await tryv(TS.tsGetReports(as(SELLER, { scope: 'mine' })));
  const row = mine && Array.isArray(mine.reports) ? mine.reports[0] : null;
  ck('H3 the seller\'s scope:\'mine\' ref is the report\'s random publicRef — never sha16(reportId), never derivable',
    !!row && B64.test(String(row.ref)) && row.ref === r1.publicRef && row.ref !== sha16(reportId) && !guesses.includes(row.ref)
      && !JSON.stringify(mine).includes(BUY), { row, publicRef: r1 && r1.publicRef });

  const caseV = await tryv(TS.tsGetReportCase(as('adm1', { reportId }, ADMIN)));
  ck('H7 the case view resolves the owning report through report.holdRef, offers restore, and never returns the raw ref',
    caseV.listingHeldByThisReport === true && caseV.product.moderationHold.reportId === reportId && caseV.product.moderationHold.ref === undefined
      && caseV.product.moderationHold.legacy === false && caseV.actions.includes('restore'), { actions: caseV.actions, hold: caseV.product && caseV.product.moderationHold });

  /* H5: a report whose holdRef is NOT the hold's → refused, listing untouched */
  await db.doc('reports/' + reportId).update({ holdRef: crypto.randomBytes(12).toString('base64url') });
  const mism = await tryv(TS.tsReviewReport(as('sup1', { reportId, action: 'restore', internalNote: 'seller proved authenticity' }, SUPER)));
  const afterMism = await get('products/' + P);
  ck('H5 mismatched ref: the report\'s holdRef is not the hold\'s → restore refused (HELD_BY_OTHER_REPORT); hold and visibility untouched',
    mism.error === 'failed-precondition' && mism.reason === 'HELD_BY_OTHER_REPORT' && afterMism.isVisible === false && afterMism.moderationHold && afterMism.moderationHold.ref === ref1, { mism });
  await db.doc('reports/' + reportId).update({ holdRef: ref1 });

  const restored = await tryv(TS.tsReviewReport(as('sup1', { reportId, action: 'restore', internalNote: 'seller proved authenticity' }, SUPER)));
  const pR = await get('products/' + P);
  const aud = (await db.collection('trustSafetyAudit').get()).docs.map((d) => d.data()).filter((a) => a.reportId === reportId);
  const hideAud = aud.find((a) => a.enforcement === 'listing_hidden'), relAud = aud.find((a) => a.enforcement === 'listing_restored');
  const promo = await get('featuredListings/f1');
  ck('H4 restore finds the hold via report.holdRef; moderationHold DELETED (key absent — never {active:false}); release record + audit rows carry only the random ref; its promotion resumes',
    restored.enforcement === 'listing_restored' && pR.isVisible === true && !('moderationHold' in pR)
      && pR.moderationReleased && pR.moderationReleased.ref === ref1 && hideAud && hideAud.holdRef === ref1 && relAud && relAud.holdRef === ref1
      && !aud.some((a) => a.holdRef === sha16(reportId)) && promo.status === 'active' && promo.pausedByRef === undefined, { restored, pR, hideAud: hideAud && hideAud.holdRef, relAud: relAud && relAud.holdRef, promo });

  /* H2b: the SAME report takes the listing down again (reopen → uphold) → a DIFFERENT ref: not a function of the id */
  const reo = await tryv(TS.tsReviewReport(as('sup1', { reportId, action: 'reopen', internalNote: 'new evidence from buyer' }, SUPER)));
  const up2 = await tryv(TS.tsReviewReport(as('adm1', { reportId, action: 'approve', hideProduct: true, resolution: 'Counterfeit confirmed again' }, ADMIN)));
  const held2 = await get('products/' + P);
  const ref2 = held2 && held2.moderationHold && held2.moderationHold.ref;
  ck('H2b a second take-down by the SAME report gets a DIFFERENT random ref (stored as the new holdRef) — the ref is not derivable from the report id',
    !reo.error && up2.enforcement === 'listing_hidden' && B64.test(String(ref2)) && ref2 !== ref1 && (await get('reports/' + reportId)).holdRef === ref2, { reo, up2, ref1, ref2 });

  /* H6: LEGACY holds — refused with a clear reason, never matched by recomputing */
  const L = 'pL', LB = 'buyer9', lid = `${LB}_product_${L}`;
  await db.doc('products/' + L).set({ name: 'Old', sellerUid: SELLER, shopId: 'shopA', status: 'active', isVisible: false,
    moderationHold: { active: true, ref: sha16(lid), at: new Date(), previousIsVisible: true } });
  await db.doc('reports/' + lid).set({ entityId: L, entityType: 'product', reportedBy: LB, status: 'actioned', productHidden: true, revision: 1, reason: 'x', reasonCode: 'counterfeit' });
  const leg = await tryv(TS.tsReviewReport(as('sup1', { reportId: lid, action: 'restore', internalNote: 'legacy hold restore try' }, SUPER)));
  const pL = await get('products/' + L);
  const L2 = 'pL2', lid2 = `${LB}_product_${L2}`;
  await db.doc('products/' + L2).set({ name: 'Older', sellerUid: SELLER, shopId: 'shopA', status: 'active', isVisible: false,
    moderationHold: { active: true, reportId: lid2, previousIsVisible: true } });
  await db.doc('reports/' + lid2).set({ entityId: L2, entityType: 'product', reportedBy: LB, status: 'pending', productHidden: true, revision: 1, reason: 'x', reasonCode: 'counterfeit' });
  const leg2 = await tryv(TS.tsReviewReport(as('sup1', { reportId: lid2, action: 'dismiss', restoreListing: true, resolution: 'not counterfeit' }, SUPER)));
  const pL2 = await get('products/' + L2);
  const legCase = await tryv(TS.tsGetReportCase(as('adm1', { reportId: lid }, ADMIN)));
  ck('H6 a LEGACY hold (sha16 ref, or pre-10-02 reportId; no report stores its ref) is refused with LEGACY_HOLD_NO_HOLDREF, listing untouched; the case view marks it legacy, offers no restore',
    leg.error === 'failed-precondition' && leg.reason === 'LEGACY_HOLD_NO_HOLDREF' && pL.isVisible === false && !!pL.moderationHold
      && leg2.error === 'failed-precondition' && leg2.reason === 'LEGACY_HOLD_NO_HOLDREF' && pL2.isVisible === false && !!pL2.moderationHold
      && (await get('reports/' + lid2)).status === 'pending'
      && legCase.product.moderationHold.legacy === true && legCase.product.moderationHold.reportId === null && !legCase.actions.includes('restore'),
    { leg, leg2, legCase: legCase.product && legCase.product.moderationHold, actions: legCase.actions });

  /* Z1 tripwires */
  let adminBlocked = false, notifyBlocked = false;
  try { require('firebase-admin'); } catch (e) { adminBlocked = /TRIPWIRE/.test(e.message); }
  try { require(path.join(FN, 'notify')); } catch (e) { notifyBlocked = /TRIPWIRE/.test(e.message); }
  const realLoaded = Object.keys(require.cache).filter((k) => /node_modules[\\/]firebase-admin[\\/]/.test(k) || /[\\/]notify\.js$/.test(k));
  ck('Z1 TRIPWIRES held: firebase-admin and notify.js are unloadable (throw on require), neither is in require.cache, the code under test never tried (notifier seam used)',
    adminBlocked && notifyBlocked && realLoaded.length === 0 && tripped.admin === 1 && tripped.notify === 1 && sent.length > 0, { tripped, realLoaded, sent: sent.length });

  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('  FAIL  harness crashed: ' + (e && e.stack || e)); process.exit(1); });
