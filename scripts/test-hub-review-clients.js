#!/usr/bin/env node
/* test-hub-review-clients.js — property / sports / BnB review clients on the ONE server authority (owner 2026-10-03).
 *   H  sokoni-hub-reviews.js, executed: success ONLY on a server-confirmed pending review; refusals before any call
 *      (not signed in, bad rating, bad body, unsupported target); server reasons surfaced; the request carries ONLY
 *      targetType/targetId/rating/body (no name, uid, status); a failed read is { ok:false }, never an empty list
 *   M  the three hub modules, executed: addReview requests the server (mapped target type) and writes NOTHING to
 *      localStorage, Firestore or the applications collection; BnB refuses; getters report "unknown" before a load
 *   P  pages, static: no name field, no false success copy, scripts load in order, values escaped, viewing/booking
 *      are server-first (the local copy is written only after the server confirmed)
 *   Z  negative controls
 * Run: node scripts/test-hub-review-clients.js
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, g) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + JSON.stringify(g) + ']')); ok ? pass++ : fail++; };

function sandbox (extra) {
  const store = {};
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const win = Object.assign({ localStorage, console: { log () {}, warn () {}, error () {}, info () {} }, setTimeout, Promise }, extra || {});
  win.window = win;
  const ctx = vm.createContext(win);
  return { ctx, win, store };
}

(async () => {
  console.log('\n── H: sokoni-hub-reviews.js ──');
  const helperSrc = R('sokoni-hub-reviews.js');
  const mk = (signedIn) => {
    const sb = sandbox({ firebaseApp: {}, firebaseAuth: { currentUser: signedIn ? { uid: 'u1' } : null } });
    vm.runInContext(helperSrc, sb.ctx);
    const calls = []; sb.win.SokoniHubReviews._setCaller(async (name, data) => { calls.push({ name, data }); return sb.reply(name, data); });
    sb.calls = calls; return sb;
  };
  let sb = mk(true); sb.reply = () => ({ reviewId: 'u1_property_L1', status: 'pending' });
  let r = await sb.win.SokoniHubReviews.submit({ targetType: 'property', targetId: 'L1', rating: 4, body: 'Lovely flat, quiet street.', name: 'Forged', uid: 'other', status: 'approved' });
  ck('H1 server-confirmed pending → ok:true, status pending', r.ok === true && r.status === 'pending' && r.reviewId === 'u1_property_L1', r);
  const sent = sb.calls[0] && sb.calls[0].data;
  ck('H2 the request carries ONLY targetType, targetId, rating, body (no name / uid / status)', sb.calls[0].name === 'submitReview' && Object.keys(sent).sort().join() === 'body,rating,targetId,targetType', sent);
  sb.reply = () => ({ reviewId: 'x', status: 'approved' });
  r = await sb.win.SokoniHubReviews.submit({ targetType: 'property', targetId: 'L1', rating: 4, body: 'Lovely flat, quiet street.' });
  ck('H3 a reply that is not "pending" is NOT success (UNCONFIRMED)', r.ok === false && r.reason === 'UNCONFIRMED', r);
  sb.reply = () => ({});
  r = await sb.win.SokoniHubReviews.submit({ targetType: 'property', targetId: 'L1', rating: 4, body: 'Lovely flat, quiet street.' });
  ck('H4 a reply with no review id is NOT success', r.ok === false && r.reason === 'UNCONFIRMED', r);
  sb.reply = () => { throw Object.assign(new Error('x'), { code: 'functions/failed-precondition', details: { reason: 'NOT_ELIGIBLE' } }); };
  r = await sb.win.SokoniHubReviews.submit({ targetType: 'sports_venue', targetId: 'V1', rating: 5, body: 'Great pitch and lights.' });
  ck('H5 server refusal NOT_ELIGIBLE surfaces with its message', r.ok === false && r.reason === 'NOT_ELIGIBLE' && /viewing or booking/.test(r.message), r);
  sb.reply = () => { throw Object.assign(new Error('x'), { code: 'functions/already-exists' }); };
  r = await sb.win.SokoniHubReviews.submit({ targetType: 'sports_venue', targetId: 'V1', rating: 5, body: 'Great pitch and lights.' });
  ck('H6 duplicate surfaces as DUPLICATE', r.reason === 'DUPLICATE', r);
  const n0 = sb.calls.length;
  r = await sb.win.SokoniHubReviews.submit({ targetType: 'property', targetId: 'L1', rating: 0, body: 'Lovely flat, quiet street.' });
  const r2 = await sb.win.SokoniHubReviews.submit({ targetType: 'property', targetId: 'L1', rating: 5, body: 'short' });
  const r3 = await sb.win.SokoniHubReviews.submit({ targetType: 'bnb', targetId: 'B1', rating: 5, body: 'Lovely stay overall.' });
  ck('H7 bad rating / short body / unsupported target refused BEFORE any server call', r.reason === 'BAD_RATING' && r2.reason === 'BAD_BODY' && r3.reason === 'UNSUPPORTED_TARGET' && sb.calls.length === n0, [r.reason, r2.reason, r3.reason]);
  const anonSb = mk(false); anonSb.reply = () => ({ reviewId: 'x', status: 'pending' });
  r = await anonSb.win.SokoniHubReviews.submit({ targetType: 'property', targetId: 'L1', rating: 4, body: 'Lovely flat, quiet street.' });
  ck('H8 not signed in → NOT_SIGNED_IN, no server call', r.reason === 'NOT_SIGNED_IN' && anonSb.calls.length === 0, r);
  sb.reply = () => { throw new Error('offline'); };
  r = await sb.win.SokoniHubReviews.load('property', 'L1');
  ck('H9 a failed read is { ok:false } — never an empty list', r.ok === false && !('reviews' in r), r);
  sb.reply = () => ({ reviews: [{ rating: 4 }, { rating: 5 }] });
  r = await sb.win.SokoniHubReviews.load('property', 'L1');
  ck('H10 load → approved reviews, average from loaded data only; none → null', r.ok && r.reviews.length === 2 && sb.win.SokoniHubReviews.average(r.reviews) === 4.5 && sb.win.SokoniHubReviews.average([]) === null, r);

  console.log('\n── M: hub modules ──');
  const modSb = (file, extra) => {
    const s = sandbox(extra);
    const reqs = [];
    s.win.SokoniHubReviews = { submit: async (x) => { reqs.push(x); return { ok: true, status: 'pending', reviewId: 'id' }; },
      load: async () => ({ ok: true, reviews: [{ rating: 3 }] }), average: (a) => (a.length ? a.reduce((p, c) => p + c.rating, 0) / a.length : null) };
    s.saved = []; s.win.SokoniDB = { saveApplication: async (a) => { s.saved.push(a); return 'APP'; } };
    s.fsWrites = []; s.win.firebase = { firestore: () => ({ collection: (c) => ({ doc: () => ({ set: async (d) => { s.fsWrites.push(c); } }) }) }) };
    vm.runInContext(R(file), s.ctx);
    s.reqs = reqs; return s;
  };
  const P = modSb('sokoni-property.js');
  r = await P.win.SokoniProperty.addReview('L1', 'property', { name: 'Forged Name', rating: 5, comment: 'Lovely flat, quiet street.' });
  ck('M1 property addReview → server request {property, L1, rating, body=comment}; no name forwarded', r.ok && P.reqs[0] && P.reqs[0].targetType === 'property' && P.reqs[0].targetId === 'L1' && P.reqs[0].body === 'Lovely flat, quiet street.' && !('name' in P.reqs[0]), P.reqs[0]);
  ck('M2 … and NOTHING goes to the applications collection or localStorage', P.saved.length === 0 && !Object.keys(P.store).some((k) => /review/i.test(k)), { saved: P.saved.length, keys: Object.keys(P.store) });
  ck('M3 property getters report UNKNOWN before a load (undefined / null), then the loaded data', P.win.SokoniProperty.getReviews('L1') === undefined && P.win.SokoniProperty.getAvgRating('L1') === null);
  await P.win.SokoniProperty.loadReviews('L1');
  ck('M3b after loadReviews: approved list + average from it', P.win.SokoniProperty.getReviews('L1').length === 1 && P.win.SokoniProperty.getAvgRating('L1') === '3.0', P.win.SokoniProperty.getAvgRating('L1'));
  r = await P.win.SokoniProperty.addReview('AG1', 'agent', { rating: 5, comment: 'Great agent indeed.' });
  ck('M4 an agent review is refused (only listings are reviewable), no server call', r.ok === false && P.reqs.length === 1, r);
  const S = modSb('sokoni-sports.js');
  r = await S.win.SokoniSports.addReview('V1', 'venue', { author: 'Forged', rating: 4, body: 'Great pitch and lights.' });
  ck('M5 sports addReview → server request {sports_venue, V1}; no author forwarded', r.ok && S.reqs[0].targetType === 'sports_venue' && S.reqs[0].targetId === 'V1' && !('author' in S.reqs[0]), S.reqs[0]);
  ck('M6 … and NO sportsReviews / localStorage write', S.fsWrites.length === 0 && !Object.keys(S.store).some((k) => /spt_rv_/.test(k)), { fs: S.fsWrites, keys: Object.keys(S.store) });
  const B = modSb('sokoni-bnb.js');
  r = await B.win.SokoniBnB.addReview('H1', { rating: 5, comment: 'x' });
  ck('M7 BnB addReview refuses honestly; no Firestore / localStorage write', r.ok === false && r.reason === 'UNSUPPORTED_TARGET' && B.fsWrites.length === 0 && !Object.keys(B.store).some((k) => /review/i.test(k)), r);

  console.log('\n── P: pages ──');
  const PL = R('property-listing.html'), PA = R('property-agent.html'), SV = R('sports-venue.html');
  ck('P1 no free-typed reviewer name field on any of the three pages', ![PL, PA, SV].some((h) => /id="rvName"/.test(h)));
  ck('P2 no false success copy ("Review submitted!", "Venue booked!", "Viewing request submitted!")', ![PL, PA, SV].some((h) => /Review submitted!|✅ Venue booked!|Viewing request submitted!/.test(h)));
  const order = (h, mod) => { const a = h.indexOf('src="firebase.js"'), b = h.indexOf('src="sokoni-hub-reviews.js"'), c = h.indexOf('src="' + mod + '"'); return a > -1 && b > a && c > b; };
  ck('P3 firebase.js → sokoni-hub-reviews.js → hub module, in that order, on all three pages', order(PL, 'sokoni-property.js') && order(PA, 'sokoni-property.js') && order(SV, 'sokoni-sports.js'));
  ck('P4 review author/body/time are escaped before insertion (listing + venue)', /_esc\(r\.body\)/.test(PL) && /_esc\(r\.authorName/.test(PL) && /_esc\(r\.body\)/.test(SV) && /_esc\(r\.authorName/.test(SV));
  ck('P5 the success toast is shown only after r.ok (listing + venue)', /if\(!r\|\|!r\.ok\)\{show[\s\S]{0,200}closeModal\(\);\(window\._skToast\|\|alert\)\('Review received/.test(PL) && /if \(!r \|\| !r\.ok\) \{ show[\s\S]{0,200}Review received/.test(SV));
  const PM = R('sokoni-property.js'), SM = R('sokoni-sports.js');
  const svBody = PM.slice(PM.indexOf('async function scheduleServerViewing'), PM.indexOf('function getViewings('));
  ck('P6 viewing: server scheduleViewing FIRST; local copy only after a viewingId came back', /op:'scheduleViewing'/.test(svBody) && svBody.indexOf("if (!viewingId) return") > -1 && svBody.indexOf("if (!viewingId) return") < svBody.indexOf('requestViewing({'));
  ck('P6b the listing page uses the server-first viewing call', /P\.scheduleServerViewing\(/.test(PL) && !/P\.requestViewing\(/.test(PL));
  const bkBody = SM.slice(SM.indexOf('async function recordServerVenueBooking'), SM.indexOf('function getVenueBookings('));
  ck('P7 booking: server setDoc FIRST, with the signed-in uid; local copy only after it resolved', /await fsm\.setDoc\(/.test(bkBody) && /uid:user\.uid/.test(bkBody) && bkBody.indexOf('await fsm.setDoc(') < bkBody.indexOf("localStorage.setItem('spt_venue_bookings'"));
  ck('P7b the venue page books through the server-first call and stops on refusal', /await S\.recordServerVenueBooking\(/.test(SV) && /if \(!res\.ok\) \{ \(window\._skToast\|\|alert\)\(res\.message\); return; \}/.test(SV));
  ck('P8 the agent page shows no invented rating/review count and no review form fields', !/a\.reviews\b/.test(PA) && !/id="rvComment"/.test(PA) && /Agent reviews are not available yet/.test(PA));

  console.log('\n── Z: negative controls ──');
  ck('Z1 the live (72dca56) property module DID file reviews into applications (M2 is not vacuous)', /SokoniDB\.saveApplication/.test(require('child_process').execSync('git show 72dca56:sokoni-property.js', { cwd: path.join(__dirname, '..') }).toString()));
  ck('Z2 the live sports page DID claim "Venue booked!" (P2 is not vacuous)', /✅ Venue booked!/.test(require('child_process').execSync('git show 72dca56:sports-venue.html', { cwd: path.join(__dirname, '..') }).toString()));
  ck('Z3 the H8 fake really has a signed-out user (not a stub that always refuses)', mk(true).win.firebaseAuth.currentUser.uid === 'u1');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack)); process.exit(2); });
