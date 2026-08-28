/* ══════════════════════════════════════════════════════════════════════════════
   PRODUCTS 2c — MEDIA UPLOAD
   ══════════════════════════════════════════════════════════════════════════════
     node scripts/test-merchant-products-2c-media.js

   A green toast is not evidence. This suite follows the whole chain and asserts
   each link separately, because every one of them can fail on its own:

       upload accepted
         -> a Storage OBJECT exists at the conventional path
           -> the CANONICAL product record references it
             -> the PROJECTIONS reference it
               -> the UI reflects it

   The failure that matters most is the third link breaking while the first
   reports success: a product that claims an image it does not have shows buyers
   a broken picture, and the merchant — having been told it worked — never tries
   again. So every negative control asserts on the RECORDED writes, not on a
   returned value.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, unproven = 0, blocked = 0;

/* BLOCKED is not UNPROVEN. The un() calls in this suite are deliberate scope
   notes — things it never intended to prove — and they correctly do not fail it.
   A missing PREREQUISITE is different: a check that was MEANT to run and could
   not. Those must not exit 0, or the gate goes green while a deployed-rule
   assertion was silently skipped. */
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const bl = (l, d) => { console.log('  BLOCKED   ' + l + (d ? '   [' + d + ']' : '')); blocked++; };

/* THE DEPLOYED Storage rules, read once and only if present. storage.rules.deployed
   is gitignored, so no clean checkout has it and this suite aborted with ENOENT in
   CI — a stack trace where a verdict should be. */
const RULES_PATH = path.join(ROOT, 'storage.rules.deployed');
const RULES = fs.existsSync(RULES_PATH) ? fs.readFileSync(RULES_PATH, 'utf8') : null;
const NO_RULES = 'storage.rules.deployed absent — fetch the DEPLOYED Storage rules; a ' +
                 'committed snapshot would verify a stale copy, not production';
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

const MD = require(path.join(ROOT, 'sokoni-merchant-data.js'));
const MEDIA = require(path.join(ROOT, 'sokoni-merchant-media.js'));

console.log('\nPRODUCTS 2c — MEDIA UPLOAD');
console.log('='.repeat(78));

const SHOP = 'shop_A', UID = 'uid_A';
const SCOPE = { ok: true, shopId: SHOP, sellerUid: UID };

const file = (name, type, size) => ({ name, type, size });
const JPEG = () => file('photo.jpg', 'image/jpeg', 220 * 1024);

/* Records every product write AND every bucket object. */
function rig(seed, opts = {}) {
  const products = Object.assign({}, seed || {});
  const mirrors = {};
  const bucket = {};
  const log = [];
  let puts = 0;
  return {
    products, mirrors, bucket, log,
    putCount: () => puts,
    reset() { log.length = 0; },
    db: {
      queryProducts: async (spec) => Object.values(products).filter((p) =>
        (spec.where || []).every(([f, o, v]) => o === '==' && p[f] === v)),
      getProduct: async (id) => products[id] || null,
      writeProduct: async ({ id, data, mode }) => {
        log.push({ op: mode, collection: 'products', id });
        products[id] = Object.assign({}, products[id] || {}, data);
        return { replayed: false };
      },
      deleteProduct: async ({ id }) => { log.push({ op: 'delete', collection: 'products', id }); delete products[id]; },
      writeMirror: async ({ path: p, data }) => {
        log.push({ op: 'mirror', collection: p[0], id: p[p.length - 1] });
        mirrors[p.join('/')] = Object.assign({}, mirrors[p.join('/')] || {}, data);
      },
    },
    storage: {
      putImage: async ({ path: p, blob, contentType, cacheControl }) => {
        puts++;
        if (opts.failUploadAt != null && puts > opts.failUploadAt) {
          throw new Error('storage/unauthorized');
        }
        log.push({ op: 'put', collection: 'storage', id: p });
        /* An object OVERWRITES at the same path, exactly as a bucket does — that
           is what makes a retry idempotent, so the fake must behave that way. */
        bucket[p] = { size: (blob && blob.size) || 0, contentType, cacheControl };
        return 'https://cdn.example/' + encodeURIComponent(p) + '?alt=media';
      },
    },
  };
}

(async () => {
  head('1 - the conventions are the EXISTING ones, not a second media system');
  const sellerSrc = fs.readFileSync(path.join(ROOT, 'seller.js'), 'utf8');
  ck('the Storage path matches seller.js\'s convention',
     MEDIA.storagePath('u1', 'p1', 0) === 'product-images/u1/p1/0.jpg' &&
     sellerSrc.indexOf('`product-images/${sellerUid || \'anon\'}/${productId}/${i}.jpg`') > -1,
     MEDIA.storagePath('u1', 'p1', 0));
  if (!RULES) bl('the accepted types mirror the DEPLOYED storage rule', NO_RULES);
  else ck('the accepted types mirror the DEPLOYED storage rule', await (async () => {
    const rules = RULES;
    const fn = rules.match(/function safeImageOnly\(\)[\s\S]*?\n    \}/)[0];
    const inRule = (fn.match(/'image\/[a-z]+'/g) || []).map((s) => s.replace(/'/g, '')).sort();
    return JSON.stringify(inRule) === JSON.stringify(MEDIA.ACCEPTED.slice().sort());
  })(), MEDIA.ACCEPTED.join(' '));
  if (!RULES) bl('the size cap matches the deployed rule (15 MB, strictly less)', NO_RULES);
  else ck('the size cap matches the deployed rule (15 MB, strictly less)',
     MEDIA.MAX_BYTES === 15 * 1024 * 1024 &&
     RULES.indexOf('request.resource.size < 15 * 1024 * 1024') > -1);
  ck('a file of EXACTLY 15 MB is refused, as the rule refuses it',
     MEDIA.validate(file('big.jpg', 'image/jpeg', 15 * 1024 * 1024)).ok === false,
     'the rule is `<`, not `<=`');
  ck('the immutable cache header is preserved', await (async () => {
    const r = rig({ p1: { id: 'p1', name: 'X', shopId: SHOP, sellerUid: UID } });
    await MD.attachProductImages({ scope: SCOPE, db: r.db, media: MEDIA, storage: r.storage,
      id: 'p1', files: [JPEG()] });
    return Object.values(r.bucket)[0].cacheControl === 'public, max-age=31536000, immutable';
  })(), 'Storage defaults to private,max-age=0 — measured on a live product image');

  head('2 - VALIDATION refuses before a single byte is sent');
  for (const [label, f] of [
    ['a PDF', file('invoice.pdf', 'application/pdf', 1000)],
    ['a video', file('clip.mp4', 'video/mp4', 1000)],
    ['a 20 MB photo', file('huge.jpg', 'image/jpeg', 20 * 1024 * 1024)],
    ['an empty file', file('empty.jpg', 'image/jpeg', 0)],
    ['a typeless file', file('mystery', '', 1000)],
  ]) {
    const r = rig({ p1: { id: 'p1', name: 'X', shopId: SHOP, sellerUid: UID } });
    let e = null;
    try {
      await MD.attachProductImages({ scope: SCOPE, db: r.db, media: MEDIA, storage: r.storage,
        id: 'p1', files: [f] });
    } catch (err) { e = err; }
    ck('  ' + label + ' is refused, nothing uploaded, nothing written',
       !!e && r.putCount() === 0 && r.log.length === 0,
       e ? e.message.slice(0, 46) : 'ACCEPTED!');
  }
  ck('a mixed selection keeps the good files and names the bad', await (async () => {
    const v = MEDIA.validateAll([JPEG(), file('x.pdf', 'application/pdf', 10), JPEG()]);
    return v.ok && v.accepted.length === 2 && v.rejected.length === 1;
  })(), 'one bad file must not discard the other three');

  head('3 - THE CHAIN, link by link');
  let r = rig({ p1: { id: 'p1', name: 'Sukuma', price: 40, shopId: SHOP, sellerUid: UID } });
  r.reset();
  const res = await MD.attachProductImages({
    scope: SCOPE, db: r.db, media: MEDIA, storage: r.storage, id: 'p1', files: [JPEG()],
  });
  const objPath = 'product-images/' + UID + '/p1/0.jpg';
  ck('link 1  upload accepted', res.urls.length === 1, res.urls[0]);
  ck('link 2  a Storage OBJECT exists at the conventional path', !!r.bucket[objPath], objPath);
  ck('link 2  it was stored as JPEG', r.bucket[objPath].contentType === 'image/jpeg');
  ck('link 3  the CANONICAL record references it', r.products.p1.image === res.urls[0]);
  ck('link 3  images[] carries it', JSON.stringify(r.products.p1.images) === JSON.stringify(res.urls));
  ck('link 3  imageStorageUrls too, as seller.js writes it',
     JSON.stringify(r.products.p1.imageStorageUrls) === JSON.stringify(res.urls),
     'the two implementations describe the same product the same way');
  ck('link 4  the POS projection references it',
     r.mirrors['posProducts/p1'].imageUrl === res.urls[0]);
  ck('link 4  the Inventory projection references it',
     r.mirrors['tenants/' + UID + '/inventory_products/p1'].imageUrl === res.urls[0]);
  ck('link 4  both projections are reported complete', res.complete === true, JSON.stringify(res.mirrors));
  ck('the ORDER was upload-then-record, never the reverse',
     r.log[0].op === 'put' && r.log.findIndex((l) => l.collection === 'products') > 0,
     r.log.map((l) => l.op).join(' -> '));

  head('4 - A FAILED UPLOAD LEAVES NO FALSE IMAGE');
  r = rig({ p1: { id: 'p1', name: 'Sukuma', price: 40, shopId: SHOP, sellerUid: UID } }, { failUploadAt: 0 });
  r.reset();
  let upErr = null;
  try {
    await MD.attachProductImages({ scope: SCOPE, db: r.db, media: MEDIA, storage: r.storage,
      id: 'p1', files: [JPEG()] });
  } catch (e) { upErr = e; }
  ck('the attach threw', !!upErr, upErr && upErr.message);
  ck('it states that NOTHING was written', upErr.wrote === false);
  ck('the product has NO image field at all', r.products.p1.image === undefined,
     JSON.stringify(r.products.p1).slice(0, 70));
  ck('no product write happened', r.log.filter((l) => l.collection === 'products').length === 0,
     JSON.stringify(r.log));
  ck('no projection was written', Object.keys(r.mirrors).length === 0);
  ck('the bucket is empty', Object.keys(r.bucket).length === 0);

  head('4b - a PARTIAL upload writes only what actually landed');
  r = rig({ p1: { id: 'p1', name: 'X', shopId: SHOP, sellerUid: UID } }, { failUploadAt: 1 });
  let partErr = null;
  try {
    await MD.attachProductImages({ scope: SCOPE, db: r.db, media: MEDIA, storage: r.storage,
      id: 'p1', files: [JPEG(), JPEG(), JPEG()] });
  } catch (e) { partErr = e; }
  ck('a partial upload REJECTS rather than half-succeeding', !!partErr);
  ck('the product still claims no image', r.products.p1.image === undefined,
     'one object exists in the bucket, but the record was never told a lie');
  ck('the caller can see what did land', Array.isArray(partErr.uploaded) && partErr.uploaded.length === 1,
     partErr.uploaded.length + ' object(s)');
  ck('nothing was written to the product', r.log.filter((l) => l.collection === 'products').length === 0);

  head('5 - RETRY does not duplicate media or corrupt image state');
  r = rig({ p1: { id: 'p1', name: 'X', shopId: SHOP, sellerUid: UID } });
  const a1 = await MD.attachProductImages({ scope: SCOPE, db: r.db, media: MEDIA, storage: r.storage,
    id: 'p1', files: [JPEG()] });
  /* The same slot, uploaded again — a merchant retrying after a flaky network. */
  const a2 = await MD.attachProductImages({ scope: SCOPE, db: r.db, media: MEDIA, storage: r.storage,
    id: 'p1', files: [JPEG()], replaceAt: 0 });
  ck('the retry wrote the SAME Storage path', a1.urls[0] === a2.urls[0], a2.urls[0]);
  ck('the bucket holds ONE object, not two', Object.keys(r.bucket).length === 1,
     Object.keys(r.bucket).join(', '));
  ck('the product has ONE image, not a duplicate', r.products.p1.images.length === 1,
     JSON.stringify(r.products.p1.images));
  ck('image still equals images[0]', r.products.p1.image === r.products.p1.images[0]);

  head('5b - a SECOND photo appends rather than overwriting');
  const a3 = await MD.attachProductImages({ scope: SCOPE, db: r.db, media: MEDIA, storage: r.storage,
    id: 'p1', files: [JPEG()] });
  ck('it took the next slot', a3.urls[0].indexOf('1.jpg') > -1, a3.urls[0].slice(-40));
  ck('the product now has two images', r.products.p1.images.length === 2);
  ck('the FIRST image is still the primary', r.products.p1.image === a1.urls[0],
     'adding a photo must not silently reorder the merchant\'s gallery');

  head('6 - OWNERSHIP is checked BEFORE a byte is uploaded');
  r = rig({ theirs: { id: 'theirs', name: 'Another shop', shopId: 'shop_B', sellerUid: 'uid_B' } });
  r.reset();
  let ownErr = null;
  try {
    await MD.attachProductImages({ scope: SCOPE, db: r.db, media: MEDIA, storage: r.storage,
      id: 'theirs', files: [JPEG()] });
  } catch (e) { ownErr = e; }
  ck('attaching to another shop\'s product is REFUSED', !!ownErr, ownErr && ownErr.message.slice(0, 46));
  ck('NOTHING was uploaded', r.putCount() === 0, 'refused before the bucket was touched');
  ck('nothing was written', r.log.length === 0);
  ck('NC the same call succeeds on an owned product', await (async () => {
    const r2 = rig({ mine: { id: 'mine', name: 'Mine', shopId: SHOP, sellerUid: UID } });
    const out = await MD.attachProductImages({ scope: SCOPE, db: r2.db, media: MEDIA,
      storage: r2.storage, id: 'mine', files: [JPEG()] });
    return out.urls.length === 1;
  })(), 'so the refusal is ownership, not a broken call');
  ck('a missing product is refused', await (async () => {
    const r3 = rig({});
    try { await MD.attachProductImages({ scope: SCOPE, db: r3.db, media: MEDIA, storage: r3.storage,
      id: 'ghost', files: [JPEG()] }); return false; }
    catch (_) { return r3.putCount() === 0; }
  })());

  head('7 - the bucket path is the SCOPE\'s uid, which is what the rule checks');
  r = rig({ p1: { id: 'p1', name: 'X', shopId: SHOP, sellerUid: UID } });
  await MD.attachProductImages({ scope: SCOPE, db: r.db, media: MEDIA, storage: r.storage,
    id: 'p1', files: [JPEG()] });
  ck('the uid segment comes from the resolved scope',
     Object.keys(r.bucket)[0].indexOf('product-images/' + UID + '/') === 0,
     Object.keys(r.bucket)[0]);
  if (!RULES) bl('the deployed rule pins that segment to request.auth.uid', NO_RULES);
  else ck('the deployed rule pins that segment to request.auth.uid',
     RULES.indexOf('request.auth.uid == uid') > -1,
     'so a forged path cannot be written even if this module were bypassed');

  head('8 - NO media quota is invented');
  const mediaSrc = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-media.js'), 'utf8');
  const mediaCode = mediaSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  ck('the media module reads no entitlement', !/uploadLimit|uploadsUsed|entitlement/.test(mediaCode),
     'uploadLimit counts LISTINGS; a photo on an owned product creates none');
  ck('it does not call canPublishProduct', mediaCode.indexOf('canPublish') === -1,
     'that gate is for creating a product, and 2b already asks it');
  /* Comment-stripped, because these assertions are about CODE. The surface's own
     header says it writes no counters and does no promotion; a raw-text match
     would fail on the sentence promising the very thing being checked. */
  const strip = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const uiCode = strip('sokoni-merchant-products.js');
  ck('NC the comment stripper leaves real code intact',
     uiCode.indexOf('function submitPhotos') > -1 && mediaCode.indexOf('function upload') > -1,
     'so the absences below are absences of code, not of comments');
  ck('no productCounters anywhere in the media path',
     mediaCode.indexOf('productCounters') === -1 && uiCode.indexOf('productCounters') === -1);
  ck('NC the catalogue genuinely has no media entitlement to enforce',
     fs.readFileSync(path.join(ROOT, 'functions/subscription-catalog.js'), 'utf8')
       .search(/maxImages|imageLimit|mediaLimit|storageQuota/) === -1,
     'so this is an absence in the catalogue, not an omission here');

  head('9 - 2d stays out of this slice');
  ck('no boost / promote / story in the media module',
     !/boost|promote|story|flashSale/i.test(mediaCode));
  ck('no boost / promote / story in the surface',
     !/boost|promoteToStory|flashSale/i.test(uiCode));

  head('10 - seller.js is untouched');
  ck('seller.js still owns its own uploader',
     sellerSrc.indexOf('async function _uploadImagesToStorage') > -1);
  ck('seller.js still owns its own product write',
     sellerSrc.indexOf("m.doc(db,'products',newProduct.id)") > -1);

  head('11 - base64 can never reach a product record through this path');
  r = rig({ p1: { id: 'p1', name: 'X', shopId: SHOP, sellerUid: UID,
                  image: 'data:image/png;base64,AAAA' } });
  await MD.attachProductImages({ scope: SCOPE, db: r.db, media: MEDIA, storage: r.storage,
    id: 'p1', files: [JPEG()] });
  ck('a pre-existing data: URI is replaced by a real address',
     r.products.p1.image.indexOf('data:') !== 0, r.products.p1.image.slice(0, 34));
  ck('the projections never carry a data: URI',
     r.mirrors['posProducts/p1'].imageUrl.indexOf('data:') !== 0,
     'one 195KB base64 image once poisoned every search-index batch it shipped in');

  head('what this suite does NOT prove');
  un('real Firebase Storage', 'the bucket here is in-memory; the browser suite drives the real UI, ' +
     'and the deployed rule is asserted by text rather than executed');
  un('Storage rules ENFORCEMENT', 'the Firestore emulator suite covers Firestore rules; ' +
     'the Storage emulator is not running in this rig');

  console.log('\n' + '='.repeat(78));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven' +
              (blocked ? ', ' + blocked + ' BLOCKED' : ''));
  if (blocked) {
    console.log('');
    console.log('  ' + blocked + ' assertion(s) could not run: ' + NO_RULES + '.');
    console.log('  Reported as BLOCKED and exiting non-zero. A check that did not run is');
    console.log('  not a check that passed.');
  }
  console.log('='.repeat(78) + '\n');
  process.exit((fail || blocked) ? 1 : 0);
})().catch((e) => { console.error('\n  aborted: ' + (e && e.stack) + '\n'); process.exit(1); });
