'use strict';
/* The review authority (functions/reviews.js, live lineage 76436b1). Owner 2026-10-01: all reviews approved in AdminOS
   before they are public. Runs the REAL callables with firebase-admin stubbed (in-memory Firestore with queries).
     node scripts/test-review-authority.js           BASE=76436b1 node scripts/test-review-authority.js (must FAIL) */
const path = require('path'), fs = require('fs'), os = require('os'), Module = require('module'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const NM = process.env.SOKONI_NODE_MODULES || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules';
process.env.NODE_PATH = NM; Module._initPaths(); process.env.GCLOUD_PROJECT = 'demo-rev'; process.env.FUNCTIONS_EMULATOR = 'true';
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 200) + ']')); ok ? pass++ : fail++; };

const DOCS = new Map(); let AUTO = 0;
const ref = (c, id) => { const p = c + '/' + id; return { path: p, id, get: async () => ({ exists: DOCS.has(p), id, data: () => DOCS.get(p) }),
  set: async (d, o) => { DOCS.set(p, Object.assign({}, (o && o.merge) ? DOCS.get(p) : {}, d)); },
  update: async (d) => { DOCS.set(p, Object.assign({}, DOCS.get(p), d)); },
  create: async (d) => { if (DOCS.has(p)) throw Object.assign(new Error('already exists'), { code: 6 }); DOCS.set(p, d); } }; };
const query = (c, filters, lim) => ({
  where: (f, op, v) => query(c, filters.concat([[f, op, v]]), lim), orderBy: () => query(c, filters, lim), limit: (n) => query(c, filters, n), startAfter: () => query(c, filters, lim),
  get: async () => { const docs = [...DOCS.entries()].filter(([k]) => k.indexOf(c + '/') === 0 && k.split('/').length === 2)
    .filter(([, v]) => filters.every(([f, op, val]) => op === '==' ? v[f] === val : op === '>' ? v[f] > val : true))
    .slice(0, lim || 1e9).map(([k, v]) => ({ id: k.split('/')[1], data: () => v, ref: ref(c, k.split('/')[1]) }));
    return { empty: !docs.length, size: docs.length, docs }; } });
const db = { collection: (c) => Object.assign(query(c, [], 0), { doc: (id) => ref(c, id || ('auto' + (++AUTO))), add: async (d) => { const id = 'a' + (++AUTO); DOCS.set(c + '/' + id, d); return ref(c, id); } }),
  runTransaction: async (fn) => { const w = []; const t = { get: (r) => r.get(), update: (r, d) => w.push(() => r.update(d)), set: (r, d, o) => w.push(() => r.set(d, o)) };
    const out = await fn(t); for (const f of w) await f(); return out; } };
/* Storage stub: FILES is the bucket; COPY_FAIL forces a copy failure */
const FILES = new Set(); let COPY_FAIL = false;
const storageStub = () => ({ bucket: (b) => ({ file: (f) => ({
  copy: async (dst) => { if (COPY_FAIL) throw Object.assign(new Error('copy failed'), { code: 500 }); if (!FILES.has(b + '/' + f)) throw Object.assign(new Error('no such object'), { code: 404 }); FILES.add(dst._key); },
  delete: async () => { FILES.delete(b + '/' + f); }, _key: b + '/' + f }) }) });
const adminStub = { apps: [1], initializeApp() {}, storage: storageStub, firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => 'TS', increment: (n) => n }, Timestamp: { fromDate: (d) => d } }) };
const adminPath = require.resolve('firebase-admin', { paths: [NM] });
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: adminStub };
let file = path.join(ROOT, 'functions', 'reviews.js');
if (process.env.BASE) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-')); file = path.join(d, 'reviews.js');
  fs.writeFileSync(file, execSync('git show ' + process.env.BASE + ':functions/reviews.js', { cwd: ROOT, encoding: 'utf8' })); }
const RV = require(file);
const call = async (fn, uid, data, token) => { try { return { ok: true, r: await fn.run({ auth: uid ? { uid, token: token || {} } : null, data, rawRequest: { headers: {} } }) }; }
  catch (e) { return { ok: false, code: e.code, reason: e.details && e.details.reason, msg: e.message }; } };
const user = (uid) => DOCS.set('users/' + uid, { createdAt: { toDate: () => new Date(Date.now() - 86400e3) } });
['buyer', 'stranger', 'seller1', 'admin1', 'adminSeller'].forEach(user);
DOCS.set('products/p1', { sellerUid: 'seller1', shopId: 'seller1' });
DOCS.set('products/p2', { sellerUid: 'adminSeller' });
DOCS.set('orders/o1', { buyerUid: 'buyer', status: 'delivered', paymentVerified: true, sellerUid: 'seller1', items: [{ productId: 'p1' }, { productId: 'p2' }] });
DOCS.set('orders/o2', { buyerUid: 'stranger', status: 'pending_payment', paymentVerified: false, items: [{ productId: 'p1' }] });
const ADM = { admin: true };

(async () => {
  console.log('\nReview authority   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
  let r = await call(RV.submitReview, 'buyer', { targetType: 'product', targetId: 'product_p1', rating: 5, body: 'Excellent quality, arrived on time', status: 'approved', approved: true, published: true });
  const rid = r.ok && r.r.reviewId;
  const doc = rid ? DOCS.get('reviews/' + rid) : null;
  ck('R-1', r.ok && r.r.status === 'pending' && doc && doc.status === 'pending', 'a submitted review is PENDING — never public on write (browser status/approved/published ignored)', r);
  ck('R-2', doc && doc.targetId === 'p1' && rid === 'buyer_product_p1', 'the "product_<id>" widget key is canonicalised to the bare id (one rating key)', { rid, t: doc && doc.targetId });
  ck('R-3', doc && doc.orderId === 'o1', 'the qualifying order is found by the SERVER (no client orderId needed)', doc && doc.orderId);
  r = await call(RV.getReviews, null, { targetId: 'product_p1' });
  ck('R-4', r.ok && Array.isArray(r.r.reviews) && r.r.reviews.length === 0, 'a pending review is NOT returned by getReviews', r.ok ? r.r.reviews : r);
  r = await call(RV.submitReview, 'stranger', { targetType: 'product', targetId: 'p1', rating: 1, body: 'never bought this but here we go' });
  ck('E-1', !r.ok && r.reason === 'NOT_ELIGIBLE', 'NO eligible order (unpaid / not delivered) → refused', r);
  r = await call(RV.submitReview, 'stranger', { targetType: 'product', targetId: 'p1', rating: 1, body: 'forged order id attempt here', orderId: 'o1' });
  ck('E-2', !r.ok && r.reason === 'NOT_ELIGIBLE', 'someone else\'s orderId does not make a stranger eligible', r);
  r = await call(RV.submitReview, 'buyer', { targetType: 'product', targetId: 'p1', rating: 4, body: 'second review attempt same target' });
  ck('D-1', !r.ok && r.code === 'already-exists', 'one review per person per target', r);
  r = await call(RV.submitReview, 'buyer', { targetType: 'legal', targetId: 'x', rating: 4, body: 'some long legal text here' });
  ck('T-1', !r.ok && r.reason === 'UNSUPPORTED_TARGET', 'only product / seller reviews go through this authority', r);
  /* moderation */
  r = await call(RV.adminModerateReview, 'stranger', { reviewId: rid, action: 'approve' });
  ck('M-1', !r.ok && r.code === 'permission-denied' && DOCS.get('reviews/' + rid).status === 'pending', 'a NON-ADMIN (not the author, not the seller) cannot approve', r);
  r = await call(RV.adminModerateReview, null, { reviewId: rid, action: 'approve' });
  ck('M-2', !r.ok && (r.code === 'permission-denied' || r.code === 'unauthenticated') && DOCS.get('reviews/' + rid).status === 'pending', 'unauthenticated cannot approve (a refusal, not a crash)', r);
  r = await call(RV.adminModerateReview, 'admin1', { reviewId: rid, action: 'approve', note: 'ok' }, ADM);
  const s1 = DOCS.get('ratingsSummary/p1');
  ck('M-3', r.ok && r.r.status === 'approved' && DOCS.get('reviews/' + rid).status === 'approved' && s1 && s1.count === 1 && s1.avg === 5,
    'an ADMIN approves → published; ratingsSummary counts it', { r, s1 });
  r = await call(RV.getReviews, null, { targetId: 'p1' });
  ck('M-4', r.ok && r.r.reviews.length === 1, 'the approved review is now returned (bare id or the widget key alike)', r.ok ? r.r.reviews.length : r);
  const logs0 = [...DOCS.keys()].filter((k) => k.indexOf('reviewModerationLog/') === 0).length;
  r = await call(RV.adminModerateReview, 'admin1', { reviewId: rid, action: 'approve' }, ADM);
  ck('M-5', r.ok && r.r.unchanged === true && [...DOCS.keys()].filter((k) => k.indexOf('reviewModerationLog/') === 0).length === logs0, 'a repeated approve is a no-op — no second decision, no second audit row', r);
  r = await call(RV.adminModerateReview, 'admin1', { reviewId: rid, action: 'remove', note: 'abusive' }, ADM);
  ck('M-6', r.ok && DOCS.get('reviews/' + rid).status === 'removed' && DOCS.get('ratingsSummary/p1').count === 0, 'removing a PUBLISHED review un-publishes it (summary recounts) — the record stays', DOCS.get('ratingsSummary/p1'));
  r = await call(RV.adminModerateReview, 'admin1', { reviewId: rid, action: 'request_changes' }, ADM);
  ck('M-7', !r.ok && r.reason === 'BAD_TRANSITION', 'invalid transitions are refused (removed → request_changes)', r);
  r = await call(RV.adminModerateReview, 'admin1', { reviewId: rid, action: 'restore' }, ADM);
  ck('M-8', r.ok && r.r.status === 'pending', 'restore goes back to PENDING for re-review — never straight to public', r);
  const hist = [...DOCS.entries()].filter(([k, v]) => k.indexOf('reviewModerationLog/') === 0 && v.reviewId === rid).map(([, v]) => v.from + '→' + v.to);
  ck('M-9', hist.join(',') === 'null→pending,pending→approved,approved→removed,removed→pending', 'every transition is in the moderation history, in order', hist);
  /* self-interest */
  user('buyerA'); DOCS.set('orders/o3', { buyerUid: 'admin1', status: 'completed', paymentVerified: true, items: [{ productId: 'p1' }] });
  r = await call(RV.submitReview, 'admin1', { targetType: 'product', targetId: 'p1', rating: 5, body: 'admin reviewing as a buyer here' }, ADM);
  const own = r.ok && r.r.reviewId;
  r = await call(RV.adminModerateReview, 'admin1', { reviewId: own, action: 'approve' }, ADM);
  ck('S-1', !r.ok && r.reason === 'SELF_REVIEW', 'an admin cannot approve their OWN review', r);
  DOCS.set('reviews/x_product_p2', { authorUid: 'buyer', targetType: 'product', targetId: 'p2', status: 'pending', rating: 1 });
  r = await call(RV.adminModerateReview, 'adminSeller', { reviewId: 'x_product_p2', action: 'reject' }, ADM);
  ck('S-2', !r.ok && r.reason === 'SELF_INTEREST', 'an admin who SELLS the product cannot moderate its reviews', r);
  /* ── HUB TYPES: property + sports_venue through the same authority (owner 2026-10-03) ── */
  {
    const _c = () => [...DOCS.keys()].filter((k) => k.indexOf('reviewRateLimits/') === 0).forEach((k) => DOCS.delete(k));
    ['agent1', 'venueOwner', 'buyer2'].forEach(user);
    DOCS.set('propertyListings/L1', { agentUid: 'agent1', status: 'active' });
    DOCS.set('propertyViewings/L1_buyer_2026-10-04', { viewingId: 'L1_buyer_2026-10-04', listingId: 'L1', buyerUid: 'buyer', status: 'requested' });
    DOCS.set('propertyViewings/L1_buyer2_2026-10-04', { viewingId: 'L1_buyer2_2026-10-04', listingId: 'L1', buyerUid: 'buyer2', status: 'cancelled' });
    DOCS.set('sportsVenues/V1', { uid: 'venueOwner' });
    DOCS.set('sportsVenueBookings/b1', { venueId: 'V1', uid: 'buyer', status: 'pending' });
    DOCS.set('sportsVenueBookings/b2', { venueId: 'V2', uid: 'stranger', status: 'pending' });
    _c(); let h = await call(RV.submitReview, 'buyer', { targetType: 'property', targetId: 'L1', rating: 4, body: 'Viewing was on time and the house matched the listing', status: 'approved', approved: true, published: true, authorUid: 'agent1', reviewerName: 'Fake Name' });
    const hd = DOCS.get('reviews/buyer_property_L1');
    ck('H-1', h.ok && h.r.status === 'pending' && hd && hd.status === 'pending' && hd.authorUid === 'buyer' && hd.targetId === 'property_L1' && hd.hubTargetId === 'L1'
      && hd.eligibility === 'propertyViewings/L1_buyer_2026-10-04' && !('reviewerName' in hd),
      'a property review with a recorded viewing is created PENDING, authored by the CALLER (browser status/approved/published/authorUid/name ignored)', { h, hd });
    _c(); h = await call(RV.submitReview, 'stranger', { targetType: 'property', targetId: 'L1', rating: 1, body: 'never viewed this house at all, honestly' });
    ck('H-2', !h.ok && h.reason === 'NOT_ELIGIBLE', 'NO viewing in the caller\'s name → refused', h);
    _c(); h = await call(RV.submitReview, 'buyer2', { targetType: 'property', targetId: 'L1', rating: 1, body: 'my viewing was cancelled but still reviewing' });
    ck('H-3', !h.ok && h.reason === 'NOT_ELIGIBLE', 'a CANCELLED viewing does not count', h);
    _c(); h = await call(RV.submitReview, 'buyer', { targetType: 'sports_venue', targetId: 'V1', rating: 5, body: 'Pitch was well kept and the lights worked' });
    ck('H-4', h.ok && h.r.status === 'pending' && (DOCS.get('reviews/buyer_sports_venue_V1') || {}).targetId === 'sports_venue_V1', 'a venue review with a booking in the caller\'s name is created PENDING', h);
    _c(); h = await call(RV.submitReview, 'stranger', { targetType: 'sports_venue', targetId: 'V1', rating: 1, body: 'booked a different venue, reviewing this one' });
    ck('H-5', !h.ok && h.reason === 'NOT_ELIGIBLE', 'a booking for ANOTHER venue does not count', h);
    _c(); h = await call(RV.submitReview, 'buyer', { targetType: 'property', targetId: 'L1', rating: 5, body: 'second review of the same house today' });
    ck('H-6', !h.ok && h.reason === 'DUPLICATE', 'one review per person per hub target', h);
    _c(); h = await call(RV.submitReview, 'buyer', { targetType: 'sports_venue', targetId: 'V1x', rating: 5, body: 'short' });
    _c(); const h7b = await call(RV.submitReview, 'buyer', { targetType: 'sports_venue', targetId: 'V1x', rating: 5, body: 'x'.repeat(2001) });
    _c(); const h7c = await call(RV.submitReview, 'buyer', { targetType: 'sports_venue', targetId: 'V1x', rating: 5 });
    ck('H-7', !h.ok && h.reason === 'BAD_BODY' && !h7b.ok && h7b.reason === 'BAD_BODY' && !h7c.ok && h7c.reason === 'BAD_BODY', 'hub review text must be 10–2000 characters', [h.reason, h7b.reason, h7c.reason]);
    h = await call(RV.getReviews, null, { targetType: 'property', targetId: 'L1' });
    ck('H-8', h.ok && h.r.reviews.length === 0, 'a PENDING hub review is not public', h.ok ? h.r.reviews : h);
    h = await call(RV.adminModerateReview, 'agent1', { reviewId: 'buyer_property_L1', action: 'approve' }, ADM);
    ck('H-9', !h.ok && h.reason === 'SELF_INTEREST' && DOCS.get('reviews/buyer_property_L1').status === 'pending', 'the listing\'s AGENT (even an admin) cannot moderate its reviews', h);
    h = await call(RV.adminModerateReview, 'venueOwner', { reviewId: 'buyer_sports_venue_V1', action: 'approve' }, ADM);
    ck('H-9b', !h.ok && h.reason === 'SELF_INTEREST', 'the VENUE OWNER (even an admin) cannot moderate its reviews', h);
    h = await call(RV.adminModerateReview, 'admin1', { reviewId: 'buyer_property_L1', action: 'approve' }, ADM);
    const g = await call(RV.getReviews, null, { targetType: 'property', targetId: 'L1' });
    const sum = DOCS.get('ratingsSummary/property_L1');
    ck('H-10', h.ok && g.ok && g.r.reviews.length === 1 && g.r.reviews[0].authorName === 'SOKONI User' && !('authorUid' in g.r.reviews[0]) && sum && sum.count === 1 && sum.avg === 4,
      'APPROVED by AdminOS → public via getReviews (server display name, no uid) and counted in ratingsSummary/property_L1', { g: g.ok ? g.r : g, sum });
    const pg = await call(RV.getReviews, null, { targetId: 'L1' });
    ck('H-11', pg.ok && pg.r.reviews.length === 0 && !DOCS.has('ratingsSummary/L1'), 'a PRODUCT with the same id never shows or counts the property\'s review (no namespace collision)', pg.ok ? pg.r : pg);
    _c(); h = await call(RV.submitReview, 'buyer', { targetType: 'bnb', targetId: 'b001', rating: 5, body: 'a stay type that has no authority yet' });
    ck('H-12', !h.ok && h.reason === 'UNSUPPORTED_TARGET', 'an unsupported hub type is refused, not stored', h);
  }
  /* ── UNBOXING: server-side approval (owner 2026-10-01/03) ── */
  if (RV.submitUnboxing) {
    const _clr = () => [...DOCS.keys()].filter((k) => k.indexOf('reviewRateLimits/') === 0).forEach((k) => DOCS.delete(k));
    const IMG = 'https://firebasestorage.googleapis.com/v0/b/sk.appspot.com/o/unboxing-pending%2Fbuyer%2Fbox1.webp?alt=media';
    FILES.add('sk.appspot.com/unboxing-pending/buyer/box1.webp');
    DOCS.delete('reviewRateLimits/buyer_unboxing_' + new Date().toISOString().slice(0, 10));
    _clr(); let u = await call(RV.submitUnboxing, 'buyer', { orderId: 'o1', productId: 'p1', rating: 5, comment: 'Arrived sealed and exactly as pictured', images: [IMG], status: 'approved', approved: true });
    const ud = DOCS.get('unboxingReviews/buyer_p1');
    ck('U-1', u.ok && u.r.status === 'pending' && ud && ud.status === 'pending' && ud.verifiedPurchase === true && ud.orderId === 'o1' && ud.sellerUid === 'seller1',
      'an unboxing post is PENDING on submit (browser approved/status ignored), tied to the verified order and product', { u, ud });
    _clr(); u = await call(RV.submitUnboxing, 'stranger', { orderId: 'o1', productId: 'p1', rating: 5, comment: 'not my order but posting anyway' });
    ck('U-2', !u.ok && u.reason === 'NOT_YOUR_ORDER', 'someone else\'s order cannot be unboxed', u);
    _clr(); u = await call(RV.submitUnboxing, 'stranger', { orderId: 'o2', productId: 'p1', rating: 5, comment: 'unpaid order unboxing attempt' });
    ck('U-3', !u.ok && u.reason === 'NOT_ELIGIBLE', 'an unpaid / undelivered order is not eligible', u);
    _clr(); u = await call(RV.submitUnboxing, 'buyer', { orderId: 'o1', productId: 'pX', rating: 5, comment: 'a product that was never in this order' });
    ck('U-4', !u.ok && u.reason === 'PRODUCT_NOT_IN_ORDER', 'the product must be one of the order\'s own lines', u);
    _clr(); u = await call(RV.submitUnboxing, 'buyer', { orderId: 'o1', productId: 'p2', rating: 5, comment: 'photos hosted somewhere else entirely', images: ['https://evil.example/x.jpg'] });
    _clr(); const u2 = await call(RV.submitUnboxing, 'buyer', { orderId: 'o1', productId: 'p2', rating: 5, comment: 'someone else\'s storage upload here', images: [IMG.replace('unboxing-pending%2Fbuyer', 'unboxing-pending%2Fstranger')] });
    ck('U-5', !u.ok && u.reason === 'BAD_MEDIA' && !u2.ok && u2.reason === 'BAD_MEDIA', 'photos must be the caller\'s OWN unboxing uploads', [u.reason, u2.reason]);
    _clr(); const u3 = await call(RV.submitUnboxing, 'buyer', { orderId: 'o1', productId: 'p2', rating: 5, comment: 'pointing straight at the public folder', images: [IMG.replace('unboxing-pending%2F', 'unboxing%2F')] });
    ck('U-5b', !u3.ok && u3.reason === 'BAD_MEDIA', 'a photo must come from the QUARANTINE folder — a browser cannot claim a public unboxing/ URL', u3);
    ck('U-5c', !(DOCS.get('unboxingReviews/buyer_p1') || {}).publicImages && !FILES.has('sk.appspot.com/unboxing/buyer/box1.webp'), 'a PENDING post has no public photo, and nothing was copied out of quarantine', DOCS.get('unboxingReviews/buyer_p1'));
    _clr(); u = await call(RV.submitUnboxing, 'buyer', { orderId: 'o1', productId: 'p1', rating: 4, comment: 'second unboxing for the same product' });
    ck('U-6', !u.ok && u.reason === 'DUPLICATE', 'one unboxing per buyer per product', u);
    u = await call(RV.adminModerateReview, 'admin1', { kind: 'unboxing', reviewId: 'buyer_p1', action: 'approve' }, ADM);
    const uh = [...DOCS.values()].filter((v) => v && v.reviewId === 'buyer_p1' && v.kind === 'unboxing').map((v) => v.from + '→' + v.to);
    ck('U-7', u.ok && DOCS.get('unboxingReviews/buyer_p1').status === 'approved' && uh.join(',') === 'null→pending,pending→approved', 'an ADMIN approves the unboxing (same state machine + history)', { u, uh });
    const ap = DOCS.get('unboxingReviews/buyer_p1');
    ck('U-7b', FILES.has('sk.appspot.com/unboxing/buyer/box1.webp') && Array.isArray(ap.publicImages) && ap.publicImages.length === 1
      && ap.publicImages[0] === 'https://firebasestorage.googleapis.com/v0/b/sk.appspot.com/o/' + encodeURIComponent('unboxing/buyer/box1.webp') + '?alt=media',
      'APPROVE copies the photo out of quarantine to unboxing/{uid}/ and the SERVER sets the public URL', ap);
    u = await call(RV.adminModerateReview, 'seller1', { kind: 'unboxing', reviewId: 'buyer_p1', action: 'remove', note: 'x' }, ADM);
    ck('U-8', !u.ok && u.reason === 'SELF_INTEREST', 'the product\'s SELLER cannot moderate its unboxing posts', u);
    u = await call(RV.adminModerateReview, 'buyer', { kind: 'unboxing', reviewId: 'buyer_p1', action: 'archive' }, ADM);
    ck('U-9', !u.ok && u.reason === 'SELF_REVIEW', 'the author cannot moderate their own unboxing', u);
    u = await call(RV.adminModerateReview, 'stranger', { kind: 'unboxing', reviewId: 'buyer_p1', action: 'remove' });
    ck('U-10', !u.ok && u.code === 'permission-denied' && DOCS.get('unboxingReviews/buyer_p1').status === 'approved', 'a non-admin cannot moderate', u);
    u = await call(RV.adminModerateReview, 'admin1', { kind: 'unboxing', reviewId: 'buyer_p1', action: 'remove', note: 'withdrawn' }, ADM);
    const rm = DOCS.get('unboxingReviews/buyer_p1');
    ck('U-11', u.ok && rm.status === 'removed' && !FILES.has('sk.appspot.com/unboxing/buyer/box1.webp') && rm.publicImages.length === 0
      && FILES.has('sk.appspot.com/unboxing-pending/buyer/box1.webp'), 'REMOVING an approved post deletes the PUBLIC copy (the private original stays for the record)', { u, rm });
    FILES.add('sk.appspot.com/unboxing-pending/buyer/box2.webp');
    _clr(); u = await call(RV.submitUnboxing, 'buyer', { orderId: 'o1', productId: 'p2', rating: 4, comment: 'second product in the same box', images: [IMG.replace('box1', 'box2')] });
    COPY_FAIL = true;
    const uf = await call(RV.adminModerateReview, 'admin1', { kind: 'unboxing', reviewId: 'buyer_p2', action: 'approve' }, ADM);
    COPY_FAIL = false;
    const fd = DOCS.get('unboxingReviews/buyer_p2') || {};
    ck('U-12', u.ok && uf.ok && fd.status === 'approved' && Array.isArray(fd.publicImages) && fd.publicImages.length === 0 && fd.photoCopyFailed === true,
      'if the photo copy FAILS, the post is approved with NO photos and the failure is recorded', { u, uf, fd });
    /* a stored post that names ANOTHER user's quarantined file (legacy / tampered record) must never publish it */
    FILES.add('sk.appspot.com/unboxing-pending/stranger/s1.webp');
    DOCS.set('unboxingReviews/legacy1', { uid: 'buyer', productId: 'p1', sellerUid: 'seller1', status: 'pending', rating: 5,
      images: ['https://firebasestorage.googleapis.com/v0/b/sk.appspot.com/o/unboxing-pending%2Fstranger%2Fs1.webp?alt=media'] });
    const ul = await call(RV.adminModerateReview, 'admin1', { kind: 'unboxing', reviewId: 'legacy1', action: 'approve' }, ADM);
    ck('U-13', ul.ok && !FILES.has('sk.appspot.com/unboxing/stranger/s1.webp') && (DOCS.get('unboxingReviews/legacy1').publicImages || []).length === 0,
      'approving a post never publishes a photo from ANOTHER user\'s quarantine folder', { ul, d: DOCS.get('unboxingReviews/legacy1') });
  } else { ck('U-0', false, 'submitUnboxing exists'); }

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
