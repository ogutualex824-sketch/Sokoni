#!/usr/bin/env node
/* test-agreement-acknowledge.js — the re-acknowledgement surface's pure logic (sokoni-agreement-acknowledge.js).
 *
 * PROVES
 *   payload      buildAcknowledgement writes EXACTLY the three intake fields + the surface marker; acceptedAt is the
 *                clock passed in (now), never the application's own date; refuses without a version / with a bad clock
 *   eligibility  Kasindi shape (approved by "reindex", no acknowledgement) → eligible/never; an old version →
 *                eligible/outdated_version; current version → current; healthcare / advocate / event organizer →
 *                versioned_elsewhere (legalAccept); rejected → closed; no version → closed
 *   one version  the version the page will use is sokoni-merchant-application.js's AGREEMENT_VERSION — the same
 *                string hub-register.js carries (no third copy)
 *   page wiring  agreement-acknowledge.html loads shared-header.js (self-updates), firebase.js, the version module
 *                before the surface module, and passes a test seam only for I/O
 *
 *   node scripts/test-agreement-acknowledge.js
 */
'use strict';
const fs = require('fs'); const Path = require('path'); const ROOT = Path.resolve(__dirname, '..');
const A = require(Path.join(ROOT, 'sokoni-agreement-acknowledge.js'));
const M = require(Path.join(ROOT, 'sokoni-merchant-application.js'));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 200) + ']' : '')); ok ? pass++ : fail++; };
const V = M.AGREEMENT_VERSION;
const KAS = { id: 'PRVMS7IACKG', uid: 'kasindi', name: 'Kasindi holdings limited', type: 'Cleaning Company / Housekeeper', role: 'provider', hub: 'service', status: 'approved', statusCanonical: 'approved', decidedBy: 'reindex', decidedAt: '2026-07-30T15:11:12.000Z', createdAt: '2026-07-30T12:44:56.000Z' };

console.log('\n── one version ──');
ck('sokoni-merchant-application.js exports AGREEMENT_VERSION', typeof V === 'string' && V.length > 8, V);
const hub = fs.readFileSync(Path.join(ROOT, 'hub-register.js'), 'utf8');
const hubLit = (hub.match(/AGREEMENT_VERSION = '([^']+)'/) || [])[1] || null;
ck('hub-register.js: if it carries a version literal it is the SAME string (one acknowledgement, one version); on the live line it carries none', hubLit === null || hubLit === V, hubLit || 'no literal on this line');
ck('the surface module carries NO version literal of its own', !/\d{4}-\d{2}-\d{2}-lanes/.test(fs.readFileSync(Path.join(ROOT, 'sokoni-agreement-acknowledge.js'), 'utf8')));

console.log('\n── payload ──');
const now = new Date('2026-09-29T20:30:00.000Z');
const p = A.buildAcknowledgement(V, now);
ck('exactly {agreementAccepted:true, agreementVersion, agreementAcceptedAt, agreementAcknowledgedSurface}', Object.keys(p).sort().join(',') === 'agreementAccepted,agreementAcceptedAt,agreementAcknowledgedSurface,agreementVersion' && p.agreementAccepted === true && p.agreementVersion === V && p.agreementAcknowledgedSurface === 'agreement-acknowledge', p);
ck('agreementAcceptedAt = the clock (now), NOT the application date (never backdated)', p.agreementAcceptedAt === now.toISOString() && p.agreementAcceptedAt !== KAS.createdAt && p.agreementAcceptedAt !== KAS.decidedAt);
ck('no decision / status / verification key can appear in the payload', !['status', 'decidedBy', 'decidedAt', 'agreementVerifiedAt', 'agreementVerifiedVersion', 'priorDecisions'].some((k) => k in p));
ck('every payload key is outside the intake FORBIDDEN list', !Object.keys(p).some((k) => (M.FORBIDDEN || []).includes(k)) || M.FORBIDDEN === undefined);
let threw = false; try { A.buildAcknowledgement('', now); } catch (e) { threw = true; } ck('refuses without a version', threw);
threw = false; try { A.buildAcknowledgement(V, new Date('nope')); } catch (e) { threw = true; } ck('refuses an invalid clock', threw);

console.log('\n── eligibility ──');
ck('Kasindi shape (approved by "reindex", never acknowledged) → eligible / never', JSON.stringify(A.eligible(KAS, V)) === JSON.stringify({ state: 'eligible', reason: 'never', previousVersion: null }), A.eligible(KAS, V));
ck('acknowledged against an OLD version → eligible / outdated_version', A.eligible(Object.assign({}, KAS, { agreementAccepted: true, agreementVersion: '2026-05-01-flat-5pct' }), V).reason === 'outdated_version');
ck('acknowledged against the CURRENT version → current (nothing to do)', A.eligible(Object.assign({}, KAS, { agreementAccepted: true, agreementVersion: V, agreementAcceptedAt: now.toISOString() }), V).state === 'current');
ck('a pending application → eligible', A.eligible(Object.assign({}, KAS, { status: 'pending', statusCanonical: 'pending', decidedBy: undefined }), V).state === 'eligible');
ck('healthcare / advocate / event organizer → versioned_elsewhere (legalAccept, not this surface)', ['health', 'legal', 'event_organizer'].every((r) => A.eligible(Object.assign({}, KAS, { role: r }), V).state === 'versioned_elsewhere') && A.eligible(Object.assign({}, KAS, { role: 'provider', hub: 'healthcare' }), V).state === 'versioned_elsewhere');
ck('rejected → closed', A.eligible(Object.assign({}, KAS, { status: 'rejected', statusCanonical: 'rejected' }), V).state === 'closed');
ck('no version → closed (never acknowledge "something")', A.eligible(KAS, null).state === 'closed');

console.log('\n── page wiring ──');
const html = fs.readFileSync(Path.join(ROOT, 'agreement-acknowledge.html'), 'utf8');
ck('loads shared-header.js (service-worker registration → the page self-updates)', /shared-header\.js/.test(html));
ck('loads firebase.js (module) and sokoni-merchant-application.js BEFORE sokoni-agreement-acknowledge.js', html.indexOf('firebase.js') > 0 && html.indexOf('sokoni-merchant-application.js') < html.indexOf('sokoni-agreement-acknowledge.js'));
ck('writes through updateDoc on applications/{id} (the applicant\'s own document); no setDoc / addDoc (never creates an application)', /updateDoc\(fs\.doc\(window\.firebaseDB, 'applications', id\), patch\)/.test(html) && !/setDoc|addDoc/.test(html));
ck('lists ONLY the signed-in uid\'s applications (where uid == uid)', /where\('uid', '==', uid\)/.test(html));
ck('noindex (an account surface, not a public page)', /noindex/.test(html));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
