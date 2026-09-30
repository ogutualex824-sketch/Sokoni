#!/usr/bin/env node
/* test-verification-flow-e2e.js — owner gate items 3, 4, 5 (2026-10-01), against the LIVE function sources.
 *   S  legitimate applicant submission through the REAL verificationSubmit → verificationRequests (server write);
 *      eligibility still enforced server-side.
 *   D  legitimate AdminOS decision through the REAL verificationDecide → verifications/{uid}.facets (server write);
 *      a non-admin cannot decide.
 *   P  the public projection (REAL profileGetPublicProfile) shows ONLY approved, unexpired facets.
 * Rules do not govern the Admin SDK, so these prove the server-only rules leave the legitimate path intact.
 * FN_V / FN_P = unpacked live archives (verificationDecide gen 1787385889173955, profileGetPublicProfile gen
 * 1789964469538784; their verification-engine / verification-vocabulary / profile-engine are byte-identical to
 * this branch's functions/). Run under a Firestore emulator with a demo-* project.
 */
'use strict';
const path = require('path');
let pass = 0, fail = 0;
const ck = (label, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const errOf = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };

(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !/^demo-/.test(process.env.GCLOUD_PROJECT || '')) { ck('E0 emulator present', false, process.env.GCLOUD_PROJECT); process.exit(1); }
  process.env.FUNCTIONS_EMULATOR = 'true';
  const FN_V = path.resolve(process.env.FN_V), FN_P = path.resolve(process.env.FN_P);
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
  const db = admin.firestore();
  const VE = require(path.join(FN_V, 'verification-engine.js'));
  const PE = require(path.join(FN_P, 'profile-engine.js'));
  const UID = 'u1AAAAAAAAAAAAAAAAAAAAAA';
  await db.doc('users/' + UID).set({ displayName: 'Applicant One', createdAt: new Date() });

  console.log('\n── S: applicant submission through verificationSubmit ──');
  const sub = await VE.verificationSubmit.run({ auth: { uid: UID, token: {} }, data: { facet: 'identity', fields: { fullName: 'Applicant One', idNumber: '12345678' } } });
  const reqId = sub && (sub.requestId || sub.id);
  const reqDoc = reqId ? (await db.doc('verificationRequests/' + reqId).get()).data() : null;
  ck('S1  a legitimate submission PASSES and the server writes the request (applicantUid from auth, pending)', !!reqDoc && reqDoc.applicantUid === UID && reqDoc.state === 'pending', { sub, reqDoc });
  ck('S2  eligibility is still server-side: a buyer cannot request a lawyer badge', /permission-denied/.test(String(await errOf(VE.verificationSubmit.run({ auth: { uid: UID, token: {} }, data: { facet: 'lawyer' } })))));
  ck('S3  signed out → refused', /unauthenticated/.test(String(await errOf(VE.verificationSubmit.run({ auth: null, data: { facet: 'identity' } })))));

  console.log('\n── D: AdminOS decision through verificationDecide ──');
  ck('D1  a non-admin cannot decide', /permission-denied/.test(String(await errOf(VE.verificationDecide.run({ auth: { uid: UID, token: {} }, data: { requestId: reqId, decision: 'approved' } })))));
  const dec = await VE.verificationDecide.run({ auth: { uid: 'adm1', token: { admin: true, email: 'admin@sokoni.test' } }, data: { requestId: reqId, decision: 'approved', reason: 'ID checked' } });
  const ver = (await db.doc('verifications/' + UID).get()).data() || {};
  ck('D2  a legitimate AdminOS decision PASSES → verifications.facets.identity approved (server write)', dec && dec.ok !== false && ver.facets && ver.facets.identity && ver.facets.identity.state === 'approved', { dec, facets: ver.facets });

  console.log('\n── P: the public projection shows ONLY approved, unexpired facets ──');
  /* Admin-SDK seeding of the other states the projection must NOT show. */
  await db.doc('verifications/' + UID).set({ facets: {
    address: { state: 'pending' },
    bank: { state: 'rejected' },
    kra: { state: 'approved', expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 86400000) },
  } }, { merge: true });
  const { EventEmitter } = require('events');
  const res = Object.assign(new EventEmitter(), { code: 200, headers: {}, body: null, headersSent: false, statusCode: 200,
    set(k, v) { this.headers[k] = v; return this; }, header(k, v) { this.headers[k] = v; return this; }, getHeader(k) { return this.headers[k]; },
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; this.statusCode = c; return this; },
    send(b) { this.body = b; this.headersSent = true; this.emit('finish'); return this; }, json(b) { return this.send(b); },
    end(b) { if (b !== undefined) this.body = b; this.headersSent = true; this.emit('finish'); return this; } });
  const req = Object.assign(new EventEmitter(), { method: 'GET', url: '/profile/' + UID + '?format=json', path: '/profile/' + UID, query: { format: 'json' }, headers: {}, get() { return ''; }, header() { return ''; } });
  const done = new Promise((r) => res.once('finish', r));
  await PE.profileGetPublicProfile(req, res);
  await Promise.race([done, new Promise((r) => setTimeout(r, 10000))]);
  const body = typeof res.body === 'string' ? (() => { try { return JSON.parse(res.body); } catch (_) { return res.body; } })() : res.body;
  const types = (body && body.verifiedTypes) || null;
  ck('P1  the public profile answers for the applicant', res.code === 200 && body && body.found !== false, { code: res.code, body: typeof body === 'string' ? body.slice(0, 120) : body });
  ck('P2  verifiedTypes = exactly the APPROVED + unexpired facet (identity); pending, rejected and expired are absent', Array.isArray(types) && types.length === 1 && types[0] === 'identity', types);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(2); });
