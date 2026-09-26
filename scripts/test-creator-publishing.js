/* test-creator-publishing.js — publication, catalogue contract, availability,
 * playback decisions and the watermark, proven pure.
 *
 * WHAT THESE PROVE
 *   - no client path reaches PUBLISHED without an admin APPROVED step
 *   - server-owned fields (creatorUid, pubState, streamingUrl, media…) are REFUSED
 *   - price is integer whole-KES cents; a non-KES currency is refused (no FX settle)
 *   - posters/trailers must live under the creator's own storage prefix
 *   - country restriction fails CLOSED when the viewer's country is unknown
 *   - playback: unpaid / foreign / revoked / expired / wrong-title / over-limit denied
 *   - watermark: masked identifiers only, deterministic moving schedule, session-bound
 *   - the hosting copies of both UMD modules are byte-identical to functions/shared
 *
 *   node scripts/test-creator-publishing.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const P = require(path.join(__dirname, '..', 'functions', 'shared', 'creator-publishing'));
const W = require(path.join(__dirname, '..', 'functions', 'shared', 'creator-watermark'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 90) + ']' : '')); ok ? pass++ : fail++; };
const code = (fn) => { try { fn(); return null; } catch (e) { return e.code || e.message; } };

const UID = 'creatorA';
const POSTER = 'https://firebasestorage.googleapis.com/v0/b/sokoni-aeb26.appspot.com/o/creator-public%2FcreatorA%2Fposter.jpg?alt=media';
const BASE = { title: 'Nairobi Nights', subcategory: 'movies', priceCents: 30000, currency: 'KES', accessType: 'purchase', posterUrl: POSTER };

console.log('\n── publication state machine ──');
{
  ck('creator DRAFT → SUBMITTED', P.assertFilmTransition('creator', 'DRAFT', 'SUBMITTED'));
  ck('creator DRAFT → PUBLISHED refused', code(() => P.assertFilmTransition('creator', 'DRAFT', 'PUBLISHED')) === 'transition_refused');
  ck('creator SUBMITTED → APPROVED refused (self-approval)', code(() => P.assertFilmTransition('creator', 'SUBMITTED', 'APPROVED')) === 'transition_refused');
  ck('creator UNDER_REVIEW → PUBLISHED refused', code(() => P.assertFilmTransition('creator', 'UNDER_REVIEW', 'PUBLISHED')) === 'transition_refused');
  ck('creator APPROVED → PUBLISHED allowed', P.assertFilmTransition('creator', 'APPROVED', 'PUBLISHED'));
  ck('creator SUSPENDED → PUBLISHED refused (only admin reinstates)', code(() => P.assertFilmTransition('creator', 'SUSPENDED', 'PUBLISHED')) === 'transition_refused');
  ck('admin SUBMITTED → UNDER_REVIEW', P.assertFilmTransition('admin', 'SUBMITTED', 'UNDER_REVIEW'));
  ck('admin UNDER_REVIEW → APPROVED', P.assertFilmTransition('admin', 'UNDER_REVIEW', 'APPROVED'));
  ck('admin DRAFT → PUBLISHED refused (no bypass of submission)', code(() => P.assertFilmTransition('admin', 'DRAFT', 'PUBLISHED')) === 'transition_refused');
  ck('admin PUBLISHED → SUSPENDED', P.assertFilmTransition('admin', 'PUBLISHED', 'SUSPENDED'));
  ck('unknown actor refused', code(() => P.assertFilmTransition('buyer', 'DRAFT', 'SUBMITTED')) === 'actor_invalid');
  // exhaustive: no creator path reaches PUBLISHED from anything but APPROVED
  const creatorToPublished = Object.entries(P.FILM_TRANSITIONS.creator).filter(([, to]) => to.includes('PUBLISHED')).map(([f]) => f);
  ck('ONLY APPROVED → PUBLISHED for creators (exhaustive)', JSON.stringify(creatorToPublished) === '["APPROVED"]');
  const creatorToApproved = Object.values(P.FILM_TRANSITIONS.creator).some((to) => to.includes('APPROVED'));
  ck('no creator transition INTO APPROVED (exhaustive)', !creatorToApproved);
  ck('creator PENDING → ACTIVE (admin approval)', P.assertCreatorTransition('PENDING', 'ACTIVE'));
  ck('creator SUSPENDED → PENDING refused', code(() => P.assertCreatorTransition('SUSPENDED', 'PENDING')) === 'transition_refused');
}

console.log('\n── verification state machine & contract ──');
{
  const VT = P.VERIFICATION_TRANSITIONS;
  ck('creator NOT_APPLIED → DRAFT → SUBMITTED', P.assertVerificationTransition('creator', 'NOT_APPLIED', 'DRAFT') && P.assertVerificationTransition('creator', 'DRAFT', 'SUBMITTED'));
  ck('no creator transition INTO APPROVED / UNDER_REVIEW / SUSPENDED (exhaustive)', !Object.values(VT.creator).some((to) => to.some((x) => ['APPROVED', 'UNDER_REVIEW', 'SUSPENDED'].includes(x))));
  ck('creator cannot leave SUSPENDED', !VT.creator.SUSPENDED);
  ck('admin cannot approve without review (SUBMITTED ↛ APPROVED)', code(() => P.assertVerificationTransition('admin', 'SUBMITTED', 'APPROVED')) === 'transition_refused');
  ck('admin UNDER_REVIEW → APPROVED | REJECTED | MORE_INFORMATION_REQUIRED', ['APPROVED', 'REJECTED', 'MORE_INFORMATION_REQUIRED'].every((t) => P.assertVerificationTransition('admin', 'UNDER_REVIEW', t)));
  ck('all 8 states defined', Object.keys(P.VERIFICATION_STATE).length === 8);
  ck('negative actions require a reason', ['request_info', 'reject', 'suspend', 'reinstate'].every((a) => P.VERIFICATION_ACTIONS[a].reason) && !P.VERIFICATION_ACTIONS.approve.reason);
  for (const k of ['status', 'verified', 'reviewer', 'creatorId', 'documents', 'version']) {
    ck(`verification: server-owned "${k}" refused`, code(() => P.sanitizeVerificationInput({ [k]: 'x' })) === 'field_server_owned');
  }
  ck('full ID number refused', code(() => P.sanitizeVerificationInput({ identity: { documentType: 'passport', documentNumber: 'A1234567' } })) === 'pii_refused');
  ck('last-4 accepted and upper-cased', P.sanitizeVerificationInput({ identity: { documentType: 'passport', documentLast4: 'ab12' } }).identity.documentLast4 === 'AB12');
  ck('5-char "last4" refused', code(() => P.sanitizeVerificationInput({ identity: { documentType: 'passport', documentLast4: '12345' } })) === 'identity_invalid');
  ck('document name: cv- prefix + safe extension only', P.VERIFICATION_DOC_NAME.test('cv-id.pdf') && !P.VERIFICATION_DOC_NAME.test('../cv-id.pdf') && !P.VERIFICATION_DOC_NAME.test('cv-id.html') && !P.VERIFICATION_DOC_NAME.test('id.pdf'));
  const r = P.verificationReadiness({});
  ck('readiness lists every missing item', ['legalName', 'creatorType', 'identity', 'ownershipAttested', 'documents'].every((m) => r.missing.includes(m)));
}

console.log('\n── field contract ──');
{
  const ok = P.sanitizeFilmInput(BASE, { uid: UID });
  ck('valid draft accepted (POSITIVE CONTROL)', ok.title === 'Nairobi Nights' && ok.priceCents === 30000);
  for (const k of ['creatorUid', 'pubState', 'status', 'streamingUrl', 'media', 'agreementVersion', 'price', 'purchaseCount']) {
    ck(`server-owned "${k}" refused`, code(() => P.sanitizeFilmInput({ ...BASE, [k]: 'x' }, { uid: UID })) === 'field_server_owned');
  }
  ck('non-KES currency refused (no convert-and-settle)', code(() => P.sanitizeFilmInput({ ...BASE, currency: 'USD' }, { uid: UID })) === 'currency_unsupported');
  ck('fractional price refused', code(() => P.sanitizeFilmInput({ ...BASE, priceCents: 30000.5 }, { uid: UID })) === 'price_invalid');
  ck('sub-shilling price refused (rail settles whole KES)', code(() => P.sanitizeFilmInput({ ...BASE, priceCents: 30050 }, { uid: UID })) === 'price_invalid');
  ck('price below KES 1 refused', code(() => P.sanitizeFilmInput({ ...BASE, priceCents: 0 }, { uid: UID })) === 'price_invalid');
  ck('price above KES 150,000 refused', code(() => P.sanitizeFilmInput({ ...BASE, priceCents: 15000100 }, { uid: UID })) === 'price_invalid');
  ck('string price refused', code(() => P.sanitizeFilmInput({ ...BASE, priceCents: '30000' }, { uid: UID })) === 'price_invalid');
  ck('unknown subcategory refused', code(() => P.sanitizeFilmInput({ ...BASE, subcategory: 'porn' }, { uid: UID })) === 'subcategory_invalid');
  ck('foreign poster URL refused', code(() => P.sanitizeFilmInput({ ...BASE, posterUrl: 'https://evil.example/p.jpg' }, { uid: UID })) === 'asset_not_owned');
  ck('another creator\'s poster refused', code(() => P.sanitizeFilmInput({ ...BASE, posterUrl: POSTER.replace('creatorA', 'creatorB') }, { uid: UID })) === 'asset_not_owned');
  ck('http poster refused', code(() => P.sanitizeFilmInput({ ...BASE, posterUrl: POSTER.replace('https', 'http') }, { uid: UID })) === 'asset_not_owned');
  ck('rental without days refused', code(() => P.sanitizeFilmInput({ ...BASE, accessType: 'rental' }, { uid: UID })) === 'rental_days_invalid');
  ck('rental 7 days accepted', P.sanitizeFilmInput({ ...BASE, accessType: 'rental', rentalDays: 7 }, { uid: UID }).rentalDays === 7);
  ck('purchase clears rentalDays', P.sanitizeFilmInput({ ...BASE, rentalDays: 7 }, { uid: UID }).rentalDays === null);
  ck('control chars stripped from title', P.sanitizeFilmInput({ ...BASE, title: 'A\u0000B\u0007C' }, { uid: UID }).title === 'A B C');
  ck('partial update needs no title', P.sanitizeFilmInput({ description: 'x' }, { uid: UID, partial: true }).description === 'x');
}

console.log('\n── availability (explicit content rule) ──');
{
  const ww = P.normalizeAvailability({ mode: 'worldwide' });
  ck('worldwide available with unknown country', P.isAvailableIn(ww, null).available);
  const allow = P.normalizeAvailability({ mode: 'allow', countries: ['ke', 'UG'] });
  ck('allow-list normalised upper + sorted', JSON.stringify(allow.countries) === '["KE","UG"]');
  ck('allow-list: KE available', P.isAvailableIn(allow, 'KE').available);
  ck('allow-list: US not licensed', P.isAvailableIn(allow, 'US').reason === 'not_licensed_here');
  ck('restricted + unknown country → REFUSED (fail closed)', P.isAvailableIn(allow, '').reason === 'country_unknown');
  const deny = P.normalizeAvailability({ mode: 'deny', countries: ['US'] });
  ck('deny-list: US refused', !P.isAvailableIn(deny, 'US').available);
  ck('deny-list: NG available', P.isAvailableIn(deny, 'NG').available);
  ck('empty allow-list refused', code(() => P.normalizeAvailability({ mode: 'allow', countries: [] })) === 'availability_invalid');
  ck('bad country code refused', code(() => P.normalizeAvailability({ mode: 'allow', countries: ['Kenya'] })) === 'availability_invalid');
}

console.log('\n── readiness ──');
{
  const r = P.publishReadiness({ ...BASE }, { creatorState: 'ACTIVE', draftAgreementOk: true, mediaReady: true });
  ck('ready when all present (POSITIVE CONTROL)', r.ready, r.missing.join(','));
  ck('suspended creator not ready', P.publishReadiness(BASE, { creatorState: 'SUSPENDED', draftAgreementOk: true, mediaReady: true }).missing.includes('creator_not_active'));
  ck('no media → not ready', P.publishReadiness(BASE, { creatorState: 'ACTIVE', draftAgreementOk: true }).missing.includes('media'));
  ck('no agreement → not ready', P.publishReadiness(BASE, { creatorState: 'ACTIVE', mediaReady: true }).missing.includes('royalty_agreement'));
}

console.log('\n── playback decision ──');
{
  const NOW = 1_800_000_000_000;
  const film = { id: 'f1', pubState: 'PUBLISHED' };
  const ent = { ownerUid: 'v1', resourceId: 'f1', status: 'ACTIVE', expiresAtMs: null };
  ck('paid viewer allowed (POSITIVE CONTROL)', P.decidePlayback({ entitlement: ent, film, viewerUid: 'v1', nowMs: NOW }).allow);
  ck('unauthenticated denied', P.decidePlayback({ entitlement: ent, film, viewerUid: null, nowMs: NOW }).reason === 'unauthenticated');
  ck('unpaid viewer denied', P.decidePlayback({ entitlement: null, film, viewerUid: 'v1', nowMs: NOW }).reason === 'no_entitlement');
  ck('someone else\'s entitlement denied', P.decidePlayback({ entitlement: ent, film, viewerUid: 'v2', nowMs: NOW }).reason === 'not_owner');
  ck('entitlement for another title denied', P.decidePlayback({ entitlement: { ...ent, resourceId: 'f2' }, film, viewerUid: 'v1', nowMs: NOW }).reason === 'wrong_title');
  ck('refunded (REVOKED) viewer denied', P.decidePlayback({ entitlement: { ...ent, status: 'REVOKED' }, film, viewerUid: 'v1', nowMs: NOW }).reason === 'entitlement_revoked');
  ck('expired rental denied', P.decidePlayback({ entitlement: { ...ent, expiresAtMs: NOW }, film, viewerUid: 'v1', nowMs: NOW }).reason === 'entitlement_expired');
  ck('suspended film denied even when entitled', P.decidePlayback({ entitlement: ent, film: { ...film, pubState: 'SUSPENDED' }, viewerUid: 'v1', nowMs: NOW }).reason === 'film_unavailable');
  const live = [{ sessionId: 'a', lastSeenMs: NOW - 1000 }, { sessionId: 'b', lastSeenMs: NOW - 5000 }];
  ck('third concurrent session denied', P.decidePlayback({ entitlement: ent, film, viewerUid: 'v1', nowMs: NOW, activeSessions: live }).reason === 'too_many_sessions');
  ck('renewing an existing session is not "another" session', P.decidePlayback({ entitlement: ent, film, viewerUid: 'v1', nowMs: NOW, activeSessions: live, sessionId: 'a' }).allow);
  const stale = [{ sessionId: 'a', lastSeenMs: NOW - P.PLAYBACK.SESSION_IDLE_MS - 1 }, { sessionId: 'b', lastSeenMs: NOW - 5000 }];
  ck('idle session does not count', P.decidePlayback({ entitlement: ent, film, viewerUid: 'v1', nowMs: NOW, activeSessions: stale }).allow);
  ck('rate limit enforced', P.decidePlayback({ entitlement: ent, film, viewerUid: 'v1', nowMs: NOW, authorizationsLastHour: 30 }).reason === 'rate_limited');
  ck('many devices flagged', P.assessSessionRisk({ devices24h: ['a', 'b', 'c', 'd'] }).flags.includes('many_devices_24h'));
  ck('normal use not flagged', !P.assessSessionRisk({ devices24h: ['a', 'a'], networks1h: ['n1'] }).suspicious);
}

console.log('\n── watermark ──');
{
  ck('email masked', W.maskEmail('alex.ogutu@gmail.com') === 'a***u@g***.com', W.maskEmail('alex.ogutu@gmail.com'));
  ck('phone masked to last 3', W.maskPhone('+254 712 345 678') === '•••678');
  ck('garbage email → null (not echoed)', W.maskEmail('not-an-email') === null);
  const seed = 'f3a9c1d2e4b5a6978899aabbccddeeff';
  const p = W.buildPayload({ displayName: 'Alex Ogutu Kamau', email: 'alex.ogutu@gmail.com', phone: '+254712345678', entitlementId: 'SKNa1b2c3d4e', sessionSeed: seed, issuedAtMs: 1000 });
  const blob = JSON.stringify(p);
  ck('payload carries masked identity', p.label === 'Alex · a***u@g***.com', p.label);
  ck('payload binds session code', /^[A-Z2-9]{10}$/.test(p.sessionCode));
  ck('payload binds entitlement fragment (last 6)', p.entitlementTag === 'E-2C3D4E', p.entitlementTag);
  ck('NO full email in payload', !blob.includes('alex.ogutu@gmail.com'));
  ck('NO full phone in payload', !blob.includes('712345678'));
  ck('NO surname in payload', !blob.includes('Ogutu Kamau') && !blob.includes('Kamau'));
  ck('session code deterministic for a seed', W.sessionCode(seed) === p.sessionCode);
  ck('different session → different code', W.sessionCode(seed.replace('f3', '00')) !== p.sessionCode);
  ck('short seed refused', code(() => W.sessionCode('short')) !== null);
  const a0 = W.positionAt(p.sessionCode, 0), a1 = W.positionAt(p.sessionCode, 1);
  ck('position moves between ticks', a0.x !== a1.x || a0.y !== a1.y);
  ck('position reproducible (forensic reconstruction)', JSON.stringify(W.positionAt(p.sessionCode, 5)) === JSON.stringify(W.positionAt(p.sessionCode, 5)));
  let inFrame = true;
  for (let t = 0; t < 500; t++) { const q = W.positionAt(p.sessionCode, t); if (q.x < 0 || q.x > 0.7 || q.y < 0 || q.y > 0.9) inFrame = false; }
  ck('500 ticks stay inside the frame', inFrame);
  ck('tick advances every 20 s', W.tickAt(0, 39999) === 1 && W.tickAt(0, 40000) === 2);
  const g0 = W.forensicGrid(p.sessionCode, 0), g1 = W.forensicGrid(p.sessionCode, 1);
  ck('forensic grid shifts per tick', g0[0].x !== g1[0].x);
}

console.log('\n── hosting copies ──');
{
  const root = path.join(__dirname, '..');
  for (const [src, dst] of [['functions/shared/creator-publishing.js', 'sokoni-creator-rules.js'], ['functions/shared/creator-watermark.js', 'sokoni-watermark.js']]) {
    const same = fs.existsSync(path.join(root, dst)) && fs.readFileSync(path.join(root, src)).equals(fs.readFileSync(path.join(root, dst)));
    ck(`${dst} byte-identical to ${src}`, same, same ? '' : 'run node scripts/sync-creator-shared.js');
  }
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
