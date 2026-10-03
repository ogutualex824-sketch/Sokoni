#!/usr/bin/env node
/* test-moderation-media.js — a TAKEN-DOWN product's photos are PRIVATE while the hold exists; on restore they work again
 * with the SAME token (owner decision 2026-10-03).
 *
 *   node scripts/test-moderation-media.js                       # working tree — must PASS
 *   SABOTAGE=<name> node scripts/test-moderation-media.js       # one fault in a TEMP COPY (never the tree)
 *   node scripts/test-moderation-media.js --failure-injection   # every fault, one at a time: each must fail its NAMED row;
 *                                                               # the tree's files are hashed before and after
 *
 * The REAL functions/trust-safety.js + functions/moderation-media.js run on the transactional fake Firestore
 * (scripts/lib/fake-firestore-txn.js, strict read order) and a FAKE Storage bucket injected through
 * moderation-media._setStorage. The fake bucket models what matters: per-object custom metadata
 * (firebaseStorageDownloadTokens, moderationHold), generation/metageneration preconditions (412), null deletes a key,
 * 404 for a missing object — and a fake "download URL" check: a ?token= URL works only while the object's
 * firebaseStorageDownloadTokens contains that token (that is how Firebase token URLs bypass rules).
 *
 * NO PRODUCTION, NO NETWORK, NO EMULATOR. Tripwires: the real firebase-admin (any entry), ./notify and http/https THROW
 * on require; row Z1 asserts none was loaded. Console output of the code under test is CAPTURED (row L1 scans it).
 *
 * NAMED ROWS
 *   T1  take-down vaults every token (byte-equal) in moderationMediaVault/{productId} and strips each object
 *       (no firebaseStorageDownloadTokens, moderationHold='1'); the copied order/receipt URL stops working
 *   T2  the vault is CREATE-only: a retry finds it and never overwrites a stored token with the (now empty) live value
 *   T3  multiple tokens (comma-separated) are vaulted and reinstated exactly
 *   R1  restore reinstates the SAME token value (byte-equal), removes the flag and DELETES the vault doc
 *   R2  restore never writes a NEW token: every metadata write carries null or a vaulted value, nothing else
 *   R3  the product doc is not rewritten by the media step (image URLs byte-equal before take-down and after restore);
 *       the copied URL in an order works again
 *   L1  no token appears in any console output (captured)
 *   L2  no token and no raw object path appears in any trustSafetyAudit row (sha16 pathRef only)
 *   L3  no token appears on the report doc, the callable responses or any other non-vault document
 *   N1  a product with no images: take-down and restore succeed, media status 'none', no vault doc
 *   P1  a partially failed strip is RECORDED (response + report + vault: partial / strip_failed) — never claimed held —
 *       and tsRetryModerationMedia completes it (held), tokens still the originals
 *   P2  storage unavailable (no Functions runtime, no seam): the decision stands, media 'failed', nothing claimed
 *   F1  a URL into ANOTHER seller's prefix is never touched; recorded 'foreign'; result partial (not held)
 *   S1  a photo shared by two held listings: restoring one HANDS its token to the other (photo stays private); restoring
 *       the second reinstates the original token
 *   A1  tsRetryModerationMedia is admin-only
 *   V1  moderationMediaVault is unreadable to every client: the SERVED Firestore ruleset (and the takedown candidate)
 *       has no match covering it and no top-level wildcard → default deny (static; the emulator row is QUEUED in the
 *       rules worktree, scripts/test-media-hold-rules.js)
 *   Z1  tripwires held
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), Module = require('module'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const FILES = ['moderation-media.js', 'trust-safety.js'];
const RULES_DIR = process.env.SOKONI_RULES_DIR || 'C:/temp/sok-takedown-rules';

const SABOTAGES = {
  'rotate-instead-of-reinstate': { file: 'moderation-media.js', catch: 'R2',
    from: '{ metadata: { [TOKEN_KEY]: e.tokens == null ? null : e.tokens, [FLAG_KEY]: null } }',
    to: "{ metadata: { [TOKEN_KEY]: require('crypto').randomUUID(), [FLAG_KEY]: null } }" },
  'token-on-report': { file: 'trust-safety.js', catch: 'L3',
    from: "  const rec = Object.assign({ op, correlationId, at: FieldValue.serverTimestamp() }, r);",
    to: "  const _v = await db.collection('moderationMediaVault').doc(String(productId)).get();\n  const rec = Object.assign({ op, correlationId, at: FieldValue.serverTimestamp(), vault: _v.exists ? _v.data().objects : null }, r);" },
  'log-token': { file: 'moderation-media.js', catch: 'L1',
    from: "  const custom = (md && md.metadata) || {};",
    to: "  const custom = (md && md.metadata) || {};\n  console.log('[moderation-media] meta', path, custom.firebaseStorageDownloadTokens);" },
  'skip-flag': { file: 'moderation-media.js', catch: 'T1',
    from: '{ metadata: { [TOKEN_KEY]: null, [FLAG_KEY]: FLAG } }', to: '{ metadata: { [TOKEN_KEY]: null } }' },
  /* the vault rewritten with set() on every attempt (re-reading already-stripped objects): both layers removed */
  'vault-overwritten-on-retry': { file: 'moderation-media.js', catch: 'T2', edits: [
    ['    if (known.has(o.path)) continue;\n', ''],
    ['      if (!s.exists) {\n        tx.create(vref,', '      if (true) {\n        tx.set(vref,']] },
  'strip-claimed-held': { file: 'moderation-media.js', catch: 'P1',
    from: "  const status = truncated || notDone.length ? (done ? 'partial' : 'failed') : 'held';", to: "  const status = 'held';" },
};

if (process.argv.includes('--failure-injection')) {
  const hash = () => FILES.map((f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(FN, f))).digest('hex')).join(',');
  const before = hash(); let ok = true;
  for (const [name, s] of Object.entries(SABOTAGES)) {
    const r = cp.spawnSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: name }), encoding: 'utf8', maxBuffer: 64e6 });
    const out = (r.stdout || '') + (r.stderr || '');
    const applied = !/SABOTAGE NOT APPLIED/.test(out);
    const caught = new RegExp('^  FAIL  ' + s.catch + ' ', 'm').test(out);
    const pass = applied && caught && r.status === 1;
    if (!pass) ok = false;
    console.log(`  ${pass ? 'CAUGHT ' : 'MISSED '} ${name.padEnd(30)} → ${s.catch}${applied ? '' : '  (sabotage did not apply — harness fails closed)'}${caught ? '' : '  (named row did not fail)'}  exit=${r.status}`);
  }
  const after = hash();
  console.log(`  tree unchanged after injection: ${before === after ? 'YES' : 'NO'}`);
  console.log(ok && before === after ? '\nFAILURE INJECTION: all caught, all restored' : '\nFAILURE INJECTION: FAILED');
  process.exit(ok && before === after ? 0 : 1);
}

/* ── the copy under test ── */
const SAB = process.env.SABOTAGE || null;
const say = console.log.bind(console);
const LOG = [];
for (const k of ['log', 'info', 'warn', 'error', 'debug']) console[k] = (...a) => { LOG.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'modmedia-'));
for (const f of FILES) {
  let text = fs.readFileSync(path.join(FN, f), 'utf8');
  if (SAB) {
    const s = SABOTAGES[SAB];
    if (!s) { say('UNKNOWN SABOTAGE ' + SAB); process.exit(2); }
    if (s.file === f) {
      let t2 = text.replace(/\r\n/g, '\n');
      for (const [from, to] of (s.edits || [[s.from, s.to]])) {
        if (t2.split(from).length !== 2) { say('SABOTAGE NOT APPLIED: ' + SAB); process.exit(3); }
        t2 = t2.replace(from, () => to);
      }
      text = t2;
      say(`\nSABOTAGE ${SAB} applied to a temp copy of ${f}`);
    }
  }
  fs.writeFileSync(path.join(TMP, f), text);
}

let pass = 0, fail = 0;
const ck = (n, ok, d) => { if (ok) { pass++; say('  PASS  ' + n); } else { fail++; say('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 600) : '')); } };

/* ── fakes ── */
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const BUCKET = 'sokoni-aeb26.firebasestorage.app';
const OBJ = new Map();                        /* path → { generation, metageneration, metadata:{} } */
const META_WRITES = [];                       /* every setMetadata call: { path, metadata } */
const FAIL_NEXT = new Map();                  /* path → error code to throw on the next setMetadata */
function gcsErr(code) { const e = new Error('fake gcs ' + code); e.code = code; return e; }
let genSeq = 1000;
function putObject(p, tokens) { OBJ.set(p, { generation: String(++genSeq), metageneration: '1', metadata: tokens == null ? {} : { firebaseStorageDownloadTokens: tokens } }); }
const fakeBucket = {
  name: BUCKET,
  file: (p) => ({
    getMetadata: async () => {
      const o = OBJ.get(p); if (!o) throw gcsErr(404);
      return [{ name: p, bucket: BUCKET, generation: o.generation, metageneration: o.metageneration, metadata: Object.assign({}, o.metadata) }];
    },
    setMetadata: async (md, opts) => {
      const o = OBJ.get(p); if (!o) throw gcsErr(404);
      if (FAIL_NEXT.has(p)) { const c = FAIL_NEXT.get(p); FAIL_NEXT.delete(p); throw gcsErr(c); }
      opts = opts || {};
      if (opts.ifGenerationMatch != null && String(opts.ifGenerationMatch) !== o.generation) throw gcsErr(412);
      if (opts.ifMetagenerationMatch != null && String(opts.ifMetagenerationMatch) !== o.metageneration) throw gcsErr(412);
      META_WRITES.push({ path: p, metadata: JSON.parse(JSON.stringify((md && md.metadata) || {})) });
      for (const [k, v] of Object.entries((md && md.metadata) || {})) { if (v === null) delete o.metadata[k]; else o.metadata[k] = String(v); }
      o.metageneration = String(Number(o.metageneration) + 1);
      return [{}];
    },
  }),
};
const urlOf = (p, tok) => `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(p)}?alt=media&token=${tok}`;
/* a Firebase token URL: served iff the object's token list contains the URL's token (rules NOT consulted) */
function fetchTokenUrl(u) {
  const m = u.match(/\/o\/([^?]+)\?alt=media&token=([^&]+)/); if (!m) return 400;
  const o = OBJ.get(decodeURIComponent(m[1])); if (!o) return 404;
  const toks = String(o.metadata.firebaseStorageDownloadTokens || '').split(',').filter(Boolean);
  return toks.includes(m[2]) ? 200 : 403;
}

let adminLoads = 0, notifyLoads = 0, netLoads = 0;
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin' || id === 'firebase-admin/app' || id === 'firebase-admin/auth' || id === 'firebase-admin/storage') { adminLoads++; throw new Error('TRIPWIRE: real firebase-admin ' + id); }
  if (id === './notify' || /[\\/]notify(\.js)?$/.test(id)) { notifyLoads++; throw new Error('TRIPWIRE: notify.js'); }
  if (id === 'http' || id === 'https') { netLoads++; throw new Error('TRIPWIRE: network module'); }
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  if (id === 'firebase-functions/v2/firestore') { const t = (_o, h) => h; return { onDocumentCreated: t, onDocumentUpdated: t, onDocumentDeleted: t, onDocumentWritten: t }; }
  return origReq.apply(this, arguments);
};
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET; delete process.env.FUNCTIONS_EMULATOR;

const tryv = async (p) => { try { return await p; } catch (e) { return { error: e.code || e.message, details: e.details }; } };
const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const as = (uid, data, token) => ({ auth: uid ? { uid, token: token || {} } : null, data, rawRequest: {} });
const ADMIN = { admin: true };
const sha16 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const RESPONSES = [];
const keep = (r) => { RESPONSES.push(r); return r; };

(async () => {
  say('\nSOURCE: working tree' + (SAB ? ' + SABOTAGE ' + SAB : '') + ' — ' + FN);
  const MM = require(path.join(TMP, 'moderation-media.js'));
  const TS = require(path.join(TMP, 'trust-safety.js'));
  console.error('[capture-control] sentinel');   /* positive control: the capture really records console output */
  TS._setNotifier(async (o) => ({ ok: true, key: o.dedupeKey, channels: { inapp: 'sent' } }));

  const SELLER = 'sellerA', OTHER = 'sellerB', BUYER = 'buyer1', BUYER2 = 'buyer2';
  for (const u of [SELLER, OTHER]) await db.doc('users/' + u).set({ uid: u, status: 'active' });
  await db.doc('shops/shopA').set({ name: 'Shop A', sellerUid: SELLER });

  const TOK = { a: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', b: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    c1: 'cccccccc-3333-4333-8333-cccccccccccc', c2: 'dddddddd-4444-4444-8444-dddddddddddd', o: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
    s: 'ffffffff-6666-4666-8666-ffffffffffff', q1: '99999999-7777-4777-8777-999999999999', q2: '88888888-8888-4888-8888-888888888888' };
  const ALL_TOKENS = Object.values(TOK);
  const PA = `product-images/${SELLER}/p1/0.jpg`, PB = `product-images/${SELLER}/p1/1.jpg`, PC = `product-images/${SELLER}/p1/2.jpg`;
  putObject(PA, TOK.a); putObject(PB, TOK.b); putObject(PC, TOK.c1 + ',' + TOK.c2);
  const p1 = { name: 'Rolex', sellerUid: SELLER, shopId: 'shopA', price: 5000, status: 'active', isVisible: true,
    images: [urlOf(PA, TOK.a), urlOf(PB, TOK.b)], image: urlOf(PA, TOK.a), thumbnail: urlOf(PC, TOK.c1) };
  await db.doc('products/p1').set(p1);
  /* an order + receipt COPY the URLs at sale time */
  await db.doc('orders/o1').set({ items: [{ productId: 'p1', image: urlOf(PA, TOK.a) }], thumb: urlOf(PC, TOK.c2) });
  const imgFields = (p) => JSON.stringify({ images: p.images, image: p.image, thumbnail: p.thumbnail });
  const before = imgFields(await get('products/p1'));

  MM._setStorage((name) => (name === BUCKET ? fakeBucket : null));

  const file = async (uid, pid) => (await TS.tsReportContent(as(uid, { entityType: 'product', entityId: pid, reasonCode: 'counterfeit', detail: 'fake logo on the product' }))).reportId;
  const uphold = (rid) => TS.tsReviewReport(as('adm1', { reportId: rid, action: 'approve', hideProduct: true, resolution: 'Counterfeit confirmed', internalNote: 'brand check done' }, ADMIN));
  const restore = (rid) => TS.tsReviewReport(as('adm1', { reportId: rid, action: 'restore', internalNote: 'seller proved authenticity' }, ADMIN));
  const retry = (rid, uid, tok) => TS.tsRetryModerationMedia(as(uid || 'adm1', { reportId: rid }, tok === undefined ? ADMIN : tok));

  /* ═══ T1 / T2 / T3 / P1 — take-down with one injected strip failure ═══ */
  const r1 = await file(BUYER, 'p1');
  FAIL_NEXT.set(PB, 503);
  const up = keep(await tryv(uphold(r1)));
  const vault1 = await get('moderationMediaVault/p1');
  const rep1 = await get('reports/' + r1);
  const vTok = (p) => ((vault1 && vault1.objects) || []).find((o) => o.path === p);
  ck('P1 a partially failed strip is RECORDED, never claimed held: response + report say partial, the failed object is strip_failed in the vault',
    up.mediaHold && up.mediaHold.status === 'partial' && up.mediaHold.failed === 1 && up.mediaHold.stripped === 2
    && rep1.mediaHold && rep1.mediaHold.status === 'partial' && vTok(PB) && vTok(PB).state === 'strip_failed'
    && OBJ.get(PB).metadata.firebaseStorageDownloadTokens === TOK.b,
    { media: up.mediaHold, rep: rep1.mediaHold, pb: vTok(PB) && vTok(PB).state });

  const rt = keep(await tryv(retry(r1)));
  const vault2 = await get('moderationMediaVault/p1');
  const v2 = (p) => ((vault2 && vault2.objects) || []).find((o) => o.path === p) || {};
  ck('P1 … and tsRetryModerationMedia completes it: held, every object stripped',
    rt.mediaHold && rt.mediaHold.status === 'held' && rt.mediaHold.stripped === 3 && (await get('reports/' + r1)).mediaHold.status === 'held',
    rt);
  const stripped = [PA, PB, PC].every((p) => !('firebaseStorageDownloadTokens' in OBJ.get(p).metadata) && OBJ.get(p).metadata.moderationHold === '1');
  ck('T1 take-down vaults every token byte-equal and strips each object (token removed, moderationHold=1); copied order URLs stop working',
    v2(PA).tokens === TOK.a && v2(PB).tokens === TOK.b && stripped
    && fetchTokenUrl(urlOf(PA, TOK.a)) === 403 && fetchTokenUrl(urlOf(PC, TOK.c2)) === 403 && vault2.holdRef === rep1.holdRef,
    { stripped, meta: [...OBJ.entries()].map(([k, v]) => [sha16(k), Object.keys(v.metadata)]) });
  ck('T2 the vault is create-only: the retry kept the ORIGINAL tokens (never the empty live value), one vault doc, created once',
    v2(PA).tokens === TOK.a && v2(PB).tokens === TOK.b && v2(PC).tokens === TOK.c1 + ',' + TOK.c2
    && (await db.collection('moderationMediaVault').get()).size === 1, vault2 && vault2.objects.map((o) => [sha16(o.path), o.state, !!o.tokens]));
  ck('T3 multiple tokens (comma-separated) are vaulted exactly', v2(PC).tokens === TOK.c1 + ',' + TOK.c2);

  /* ═══ R1 / R2 / R3 — restore ═══ */
  const writesBeforeRestore = META_WRITES.length;
  const rs = keep(await tryv(restore(r1)));
  const after = await get('products/p1');
  const restoredMeta = [PA, PB, PC].map((p) => OBJ.get(p).metadata);
  ck('R1 restore reinstates the SAME token (byte-equal), removes the flag and DELETES the vault doc',
    rs.mediaHold && rs.mediaHold.status === 'released'
    && restoredMeta[0].firebaseStorageDownloadTokens === TOK.a && restoredMeta[1].firebaseStorageDownloadTokens === TOK.b
    && restoredMeta[2].firebaseStorageDownloadTokens === TOK.c1 + ',' + TOK.c2
    && restoredMeta.every((m) => !('moderationHold' in m)) && (await get('moderationMediaVault/p1')) === null,
    { media: rs.mediaHold, flags: restoredMeta.map((m) => 'moderationHold' in m) });
  const restoreWrites = META_WRITES.slice(writesBeforeRestore);
  const vaulted = new Set([TOK.a, TOK.b, TOK.c1 + ',' + TOK.c2]);
  ck('R2 restore never writes a NEW token: every metadata write carries null or a vaulted value',
    restoreWrites.length === 3 && META_WRITES.every((w) => !('firebaseStorageDownloadTokens' in w.metadata)
      || w.metadata.firebaseStorageDownloadTokens === null || vaulted.has(w.metadata.firebaseStorageDownloadTokens)),
    restoreWrites.map((w) => w.metadata.firebaseStorageDownloadTokens === null ? null : (vaulted.has(w.metadata.firebaseStorageDownloadTokens) ? 'vaulted' : 'NEW')));
  ck('R3 the product doc is not rewritten by the media step (image URLs byte-equal) and the copied order URLs work again',
    imgFields(after) === before && after.isVisible === true && !after.moderationHold
    && fetchTokenUrl(urlOf(PA, TOK.a)) === 200 && fetchTokenUrl(urlOf(PC, TOK.c2)) === 200 && fetchTokenUrl(urlOf(PC, TOK.c1)) === 200);

  /* ═══ N1 — no images ═══ */
  await db.doc('products/p2').set({ name: 'Plain', sellerUid: SELLER, price: 10, status: 'active', isVisible: true });
  const r2 = await file(BUYER, 'p2');
  const up2 = keep(await tryv(uphold(r2)));
  const rs2 = keep(await tryv(restore(r2)));
  ck('N1 a product with no images: take-down and restore succeed, media none, no vault doc',
    up2.success && up2.enforcement === 'listing_hidden' && up2.mediaHold.status === 'none' && rs2.success && rs2.mediaHold.status === 'none'
    && (await get('moderationMediaVault/p2')) === null && (await get('products/p2')).isVisible === true, { up2: up2.mediaHold, rs2: rs2.mediaHold });

  /* ═══ F1 — a URL into another seller's prefix ═══ */
  const PO = `product-images/${OTHER}/x/0.jpg`, PQ = `product-images/${SELLER}/p3/0.jpg`;
  putObject(PO, TOK.o); putObject(PQ, TOK.q1);
  await db.doc('products/p3').set({ name: 'Mixed', sellerUid: SELLER, price: 10, status: 'active', isVisible: true, images: [urlOf(PQ, TOK.q1), urlOf(PO, TOK.o)] });
  const r3 = await file(BUYER, 'p3');
  const up3 = keep(await tryv(uphold(r3)));
  const v3 = await get('moderationMediaVault/p3');
  ck('F1 another seller\'s object is never touched: recorded foreign, result partial (not held); own object stripped',
    OBJ.get(PO).metadata.firebaseStorageDownloadTokens === TOK.o && !('moderationHold' in OBJ.get(PO).metadata)
    && up3.mediaHold.status === 'partial' && v3.objects.find((o) => o.path === PO).state === 'foreign'
    && OBJ.get(PQ).metadata.moderationHold === '1', up3.mediaHold);
  keep(await tryv(restore(r3)));

  /* ═══ S1 — a photo shared by two held listings ═══ */
  const PS = `product-images/${SELLER}/shared/0.jpg`;
  putObject(PS, TOK.s);
  await db.doc('products/p4').set({ name: 'S4', sellerUid: SELLER, price: 10, status: 'active', isVisible: true, images: [urlOf(PS, TOK.s)] });
  await db.doc('products/p5').set({ name: 'S5', sellerUid: SELLER, price: 10, status: 'active', isVisible: true, images: [urlOf(PS, TOK.s)] });
  const r4 = await file(BUYER, 'p4'), r5 = await file(BUYER, 'p5');
  keep(await tryv(uphold(r4))); const up5 = keep(await tryv(uphold(r5)));
  const rs4 = keep(await tryv(restore(r4)));
  const stillPrivate = !('firebaseStorageDownloadTokens' in OBJ.get(PS).metadata) && OBJ.get(PS).metadata.moderationHold === '1';
  const v5 = await get('moderationMediaVault/p5');
  const rs5 = keep(await tryv(restore(r5)));
  ck('S1 shared photo: restoring one listing HANDS the token to the other (photo stays private); restoring the second reinstates the original',
    up5.mediaHold.status === 'held' && rs4.mediaHold.status === 'released' && stillPrivate
    && v5 && v5.objects[0].tokens === TOK.s && rs5.mediaHold.status === 'released'
    && OBJ.get(PS).metadata.firebaseStorageDownloadTokens === TOK.s && !('moderationHold' in OBJ.get(PS).metadata),
    { up5: up5.mediaHold, rs4: rs4.mediaHold, stillPrivate, rs5: rs5.mediaHold });

  /* ═══ A1 — retry is admin-only ═══ */
  ck('A1 tsRetryModerationMedia is admin-only (seller and buyer refused)',
    (await codeOf(retry(r1, SELLER, {}))) !== null && (await codeOf(retry(r1, BUYER, {}))) !== null);

  /* ═══ P2 — storage unavailable ═══ */
  MM._setStorage(null);
  const PU = `product-images/${SELLER}/p6/0.jpg`; putObject(PU, TOK.q2);
  await db.doc('products/p6').set({ name: 'U', sellerUid: SELLER, price: 10, status: 'active', isVisible: true, images: [urlOf(PU, TOK.q2)] });
  const r6 = await file(BUYER2, 'p6');
  const up6 = keep(await tryv(uphold(r6)));
  ck('P2 storage unavailable: the take-down stands, media failed and recorded, nothing claimed, object untouched',
    up6.success && up6.enforcement === 'listing_hidden' && up6.mediaHold.status === 'failed' && up6.mediaHold.stripped === 0
    && (await get('reports/' + r6)).mediaHold.status === 'failed' && OBJ.get(PU).metadata.firebaseStorageDownloadTokens === TOK.q2, up6.mediaHold);
  MM._setStorage((name) => (name === BUCKET ? fakeBucket : null));

  /* ═══ L1 / L2 / L3 — the token never leaves the vault ═══ */
  const hasTok = (s) => ALL_TOKENS.some((t) => String(s).includes(t));
  const logText = LOG.join('\n');
  ck('L1 no token appears in any console output (captured: ' + LOG.length + ' lines, capture control present)', LOG.includes('[capture-control] sentinel') && !hasTok(logText), LOG.filter(hasTok).slice(0, 2));
  const audits = (await db.collection('trustSafetyAudit').get()).docs.map((d) => d.data());
  const mediaAudits = audits.filter((a) => /^media_/.test(a.action || ''));
  const auditText = JSON.stringify(audits);
  const allPaths = [PA, PB, PC, PO, PQ, PS, PU];
  ck('L2 no token and no raw object path in any trustSafetyAudit row (sha16 pathRef only); media rows written: ' + mediaAudits.length,
    mediaAudits.length >= 6 && !hasTok(auditText) && !allPaths.some((p) => auditText.includes(p))
    && mediaAudits.every((a) => (a.objects || []).every((o) => /^[0-9a-f]{16}$/.test(o.pathRef))), mediaAudits.slice(0, 1));
  const nonVault = db._dump('').filter((d) => !d.path.startsWith('moderationMediaVault/') && !d.path.startsWith('products/') && !d.path.startsWith('orders/'));
  ck('L3 no token on the report docs, the callable responses or any non-vault document',
    !hasTok(JSON.stringify(nonVault)) && !hasTok(JSON.stringify(RESPONSES)),
    nonVault.filter((d) => hasTok(JSON.stringify(d))).map((d) => d.path).slice(0, 3));

  /* ═══ V1 — the vault has no client rule (served text) ═══ */
  const v1 = [];
  for (const f of ['firestore.rules.served-f259c0b5', 'firestore.rules.takedown-candidate']) {
    const p = path.join(RULES_DIR, f);
    if (!fs.existsSync(p)) { v1.push(f + ': MISSING'); continue; }
    const t = fs.readFileSync(p, 'utf8');
    const lines = t.split(/\r?\n/);
    /* a first-segment wildcard directly under /documents — e.g. match /{collection}/{doc} or /{document=**} */
    const topWild = lines.filter((l) => /^\s*match \/\{[^}]+\}/.test(l));
    if (/moderationMediaVault/.test(t)) v1.push(f + ': names moderationMediaVault');
    if (topWild.length) v1.push(f + ': top-level wildcard ' + topWild.join(' | '));
    if (!/match \/databases\/\{database\}\/documents \{/.test(t)) v1.push(f + ': unexpected shape (positive control failed)');
  }
  ck('V1 moderationMediaVault is default-deny in the SERVED ruleset f259c0b5 and the takedown candidate (no rule names it, no top-level wildcard)',
    v1.length === 0, v1);

  ck('Z1 tripwires held: real firebase-admin / notify / network never loaded', adminLoads === 0 && notifyLoads === 0 && netLoads === 0
    && !Object.keys(require.cache).some((k) => /[\\/]node_modules[\\/](firebase-admin|@google-cloud)[\\/]/.test(k)), { adminLoads, notifyLoads, netLoads });

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack)); process.exit(1); });
