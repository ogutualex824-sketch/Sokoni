#!/usr/bin/env node
/* test-contact-requests.js — buyer "Chat Seller" request → contactRequests → seller's Enquiries.
 *
 * Proves, without touching production (static + VM; no emulator, no network):
 *   A  product.js buildContactRequest() — the ONE payload builder — EXECUTED on fixtures:
 *      buyerUid is the signed-in user's uid; sellerUid comes from the canonical product doc
 *      (never the cached object); every key the served rule's hasAll() names is present;
 *      signed-out / no product / no seller → no payload; message trimmed + capped at 1000.
 *      The page's submit writes built.data only, reads products/{id} at submit time, shows
 *      success only after addDoc, and never says "will contact you soon".
 *   R  the SERVED rules (git show f20be7d:firestore.rules): contactRequests create requires
 *      buyerUid == auth.uid and hasAll(...) — the executed payload satisfies it; the seller's
 *      update is hasOnly(status, respondedAt, sellerNote); exactly one match block.
 *   M  merchant-v2.html Enquiries: loadEnquiries / enqCard / markEnquiryResponded EXECUTED —
 *      query is sellerUid == the signed-in auth uid, no orderBy (no composite index exists),
 *      newest-first client sort; the update writes exactly { status, respondedAt }; every
 *      field rendered is escaped (hostile fixture); reachable from the Dashboard.
 *   T  store.html: the "Message Seller" → messages.html dead end is gone.
 *   N  negative controls: a builder without buyerUid fails A; an unescaped render fails M.
 *
 * Run: node scripts/test-contact-requests.js
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const SERVED_RULES_COMMIT = 'f20be7d';
let pass = 0, fail = 0;
const ck = (label, ok, got) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '   [got ' + JSON.stringify(got) + ']'));
  ok ? pass++ : fail++;
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');

/* Brace-matched extraction of a named function declaration. Returns null when absent —
   callers refuse to assert against a guess. */
function grab (src, name) {
  const re = new RegExp('(?:async\\s+)?function ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const at = src.search(re);
  if (at < 0) return null;
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(at, i + 1); }
  }
  return null;
}
function need (label, v) {
  if (!v) { console.error('\n  ' + label + ' could not be extracted — refusing to assert against a guess.\n'); process.exit(2); }
  return v;
}

const TS = { __serverTimestamp: true };
const USER = { uid: 'buyer_uid_1' };
const PRODUCT = { id: 'prod_1', name: 'Blue Kettle', sellerUid: 'seller_uid_9', sellerName: 'Mama Shop' };
const FORM = { name: '  Asha  ', phone: '0712 345 678', message: '  Is it available?  ' };

/* Run the builder checks against a given builder source; returns failures (for the N rows). */
function builderFindings (builderSrc, rulesKeys) {
  const ctx = vm.createContext({});
  vm.runInContext(builderSrc + '\nthis.build = buildContactRequest;', ctx);
  const build = ctx.build;
  const out = [];
  const r = build(USER, PRODUCT, FORM, TS);
  if (!r || !r.ok) { out.push('happy-path-refused'); return { out, r }; }
  if (r.data.buyerUid !== USER.uid) out.push('buyerUid');
  if (r.data.sellerUid !== PRODUCT.sellerUid) out.push('sellerUid');
  for (const k of rulesKeys) if (!(k in r.data)) out.push('missing:' + k);
  return { out, r, build };
}

(async () => {
  /* ── R: the served rules (read first; A uses the hasAll list) ── */
  console.log('\n── R: served rules (' + SERVED_RULES_COMMIT + ':firestore.rules) ──');
  let rules = '';
  try { rules = execSync('git show ' + SERVED_RULES_COMMIT + ':firestore.rules', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, '\n'); }
  catch (e) { rules = ''; }
  ck('R0  served ruleset readable from git (' + SERVED_RULES_COMMIT + ')', rules.length > 1000, rules.length);
  const blocks = rules.match(/match \/contactRequests\/\{[^}]+\}\s*\{/g) || [];
  ck('R1  exactly one contactRequests match block (a duplicate would OR its grants)', blocks.length === 1, blocks.length);
  const bAt = rules.search(/match \/contactRequests\/\{[^}]+\}\s*\{/);
  let block = '';
  if (bAt >= 0) { let d = 0; for (let i = rules.indexOf('{', rules.indexOf('}', bAt) + 1); i < rules.length; i++) { if (rules[i] === '{') d++; else if (rules[i] === '}') { d--; if (!d) { block = rules.slice(bAt, i + 1); break; } } } }
  const create = (block.match(/allow create:([\s\S]*?);/) || [])[1] || '';
  ck('R2  create requires request.resource.data.buyerUid == request.auth.uid', /request\.resource\.data\.buyerUid\s*==\s*request\.auth\.uid/.test(create), create);
  const hasAll = ((create.match(/hasAll\(\[([^\]]*)\]\)/) || [])[1] || '').split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  ck('R3  create hasAll names buyerUid, sellerUid, productId, message, createdAt', ['buyerUid', 'sellerUid', 'productId', 'message', 'createdAt'].every((k) => hasAll.includes(k)), hasAll);
  const update = (block.match(/allow update:([\s\S]*?);/) || [])[1] || '';
  const hasOnly = ((update.match(/hasOnly\(\[([^\]]*)\]\)/) || [])[1] || '').split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  ck('R4  seller update is affectedKeys().hasOnly([status, respondedAt, sellerNote]) and gated on resource.sellerUid == auth.uid', hasOnly.includes('status') && hasOnly.includes('respondedAt') && /resource\.data\.sellerUid\s*==\s*request\.auth\.uid/.test(update), { hasOnly, update });
  const readRule = (block.match(/allow read:([\s\S]*?);/) || [])[1] || '';
  ck('R5  seller read is resource.data.sellerUid == request.auth.uid (so the query must key on the auth uid)', /resource\.data\.sellerUid\s*==\s*request\.auth\.uid/.test(readRule), readRule);

  /* ── A: the payload builder, executed ── */
  console.log('\n── A: product.js buildContactRequest(), executed ──');
  const P = read('product.js');
  const builderSrc = need('buildContactRequest', grab(P, 'buildContactRequest'));
  const { out, r, build } = builderFindings(builderSrc, hasAll);
  ck('A1  builds a payload for a signed-in buyer + canonical product with a seller', r && r.ok === true, r);
  ck('A2  buyerUid == user.uid (what the rule compares to request.auth.uid)', r && r.ok && r.data.buyerUid === USER.uid, r && r.data);
  ck('A3  sellerUid comes from the PRODUCT DOC passed in', r && r.ok && r.data.sellerUid === 'seller_uid_9', r && r.data);
  ck('A4  every key the served rule hasAll() requires is present', out.length === 0 && hasAll.length === 5, out);
  ck('A5  createdAt is the server timestamp handed in; status pending; productId from the doc', r && r.ok && r.data.createdAt === TS && r.data.status === 'pending' && r.data.productId === 'prod_1', r && r.data);
  ck('A6  message is a trimmed string; name trimmed; phone digits', r && r.ok && r.data.message === 'Is it available?' && r.data.buyerName === 'Asha' && r.data.buyerPhone === '0712345678', r && r.data);
  const out1 = build(null, PRODUCT, FORM, TS), out2 = build({}, PRODUCT, FORM, TS);
  ck('A7  signed out (null user / no uid) → NO payload', out1.ok === false && out1.reason === 'signed-out' && out2.ok === false && !out1.data, [out1, out2]);
  const out3 = build(USER, { id: 'p', name: 'x' }, FORM, TS), out4 = build(USER, { id: 'p', sellerUid: '   ' }, FORM, TS), out5 = build(USER, null, FORM, TS);
  ck('A8  product doc without sellerUid (missing / blank) → NO payload (reason no-seller); no doc → no-product', out3.ok === false && out3.reason === 'no-seller' && out4.reason === 'no-seller' && out5.reason === 'no-product' && !out3.data, [out3, out4, out5]);
  const legacy = build(USER, { id: 'p', sellerId: 'legacy_uid' }, FORM, TS);
  ck('A9  a legacy sellerId alone is NOT used as the recipient (only the rule-pinned sellerUid)', legacy.ok === false && legacy.reason === 'no-seller', legacy);
  const long = build(USER, PRODUCT, Object.assign({}, FORM, { message: 'x'.repeat(5000) }), TS);
  ck('A10 message capped at 1000 chars', long.ok && long.data.message.length === 1000, long.ok && long.data.message.length);
  const empty = build(USER, PRODUCT, Object.assign({}, FORM, { message: undefined }), TS);
  ck('A11 absent message → empty string (still satisfies hasAll)', empty.ok && empty.data.message === '' && typeof empty.data.message === 'string', empty);
  const own = build({ uid: 'seller_uid_9' }, PRODUCT, FORM, TS);
  ck('A12 a seller contacting their own listing is refused (own-product)', own.ok === false && own.reason === 'own-product', own);
  const noTs = build(USER, PRODUCT, FORM, undefined);
  ck('A13 no createdAt → no payload (addDoc would reject undefined; the rule requires the key)', noTs.ok === false, noTs);

  const submit = need('_submitContactRequest', grab(P, '_submitContactRequest'));
  ck('A14 submit reads products/{id} at submit time and passes that doc to the builder', /getDoc\(fsm\.doc\(db, 'products', pid\)\)/.test(submit) && /buildContactRequest\(user, productDoc, form, fsm\.serverTimestamp\(\)\)/.test(submit), null);
  ck('A15 submit writes ONLY built.data to contactRequests', /addDoc\(fsm\.collection\(db, 'contactRequests'\), built\.data\)/.test(submit) && (submit.match(/addDoc\(/g) || []).length === 1, null);
  const iAdd = submit.indexOf('await fsm.addDoc('), iOk = submit.indexOf('Request sent to the seller on SOKONI');
  ck('A16 success copy appears only AFTER the awaited addDoc', iAdd > 0 && iOk > iAdd, { iAdd, iOk });
  ck('A17 no "will contact you soon" anywhere in product.js', !/will contact you soon/i.test(P), null);
  ck('A18 signed out → login.html?redirect=<this page> (no write)', /login\.html\?redirect=' \+ encodeURIComponent\(location\.pathname \+ location\.search\)/.test(grab(P, '_prdLoginForContact') || '') && /if \(!user\) \{[^}]*_prdLoginForContact\(\); return; \}/.test(submit), null);
  ck('A23 after the write resolves, an Open chat link anchors the conversation on THIS contactRequests id (product_enquiry, DOM-built, no innerHTML)', submit.indexOf("var crRef = await fsm.addDoc(fsm.collection(db, 'contactRequests'), built.data)") >= 0 && submit.indexOf("tx: 'product_enquiry', txId: String(crRef.id)") >= 0 && submit.indexOf('chat.textContent = ') >= 0 && submit.indexOf('chat.innerHTML') < 0 && submit.indexOf('crRef.id') > submit.indexOf('addDoc('), null);
  ck('A19 failure names the class (permission / network) and offers Support', /permission-denied/.test(submit) && /Network problem/.test(submit) && /_prdContactSupportLink\(fb, lead\)/.test(submit) && /support\.html\?topic=request/.test(grab(P, '_prdContactSupportLink') || ''), null);
  ck('A20 the modal requires a signed-in user before it opens', /if \(!user\) \{ _prdLoginForContact\(\); return; \}/.test(grab(P, '_openContactRequestModal') || ''), null);
  const csg = grab(P, 'contactSellerGated') || '';
  ck('A21 every seller (premium included) is reached through the ONE request modal — no store.html bounce loop', /_openContactRequestModal\(\);/.test(csg) && !/_prdInAppSellerContact\(\)/.test(csg), csg.slice(0, 160));
  ck('A22 R↔A: the served rule would accept this payload shape (buyerUid==uid, hasAll ⊆ keys)', r && r.ok && hasAll.every((k) => k in r.data) && r.data.buyerUid === USER.uid, null);

  /* ── M: merchant-v2 Enquiries, executed ── */
  console.log('\n── M: merchant-v2.html Enquiries view ──');
  const M = read('merchant-v2.html');
  const src = {};
  for (const n of ['esc', 'waPhone', 'ago', '_enqDate', 'loadEnquiries', 'enqCard', 'markEnquiryResponded', 'openEnquiries', 'paintEnquiries']) src[n] = need(n, grab(M, n));
  const idx = JSON.parse(read('firestore.indexes.json'));
  const hasIdx = (idx.indexes || []).some((i) => i.collectionGroup === 'contactRequests' &&
    (i.fields || []).some((f) => f.fieldPath === 'sellerUid') && (i.fields || []).some((f) => f.fieldPath === 'createdAt'));
  ck('M1  no orderBy in the query while firestore.indexes.json lacks a (sellerUid, createdAt) index', hasIdx || !/orderBy/.test(src.loadEnquiries), { hasIdx });

  const mctx = vm.createContext({ window: { firebaseDB: {} }, Promise, Date });
  vm.runInContext([src.esc, src.waPhone, src.ago, src._enqDate, src.loadEnquiries, src.enqCard, src.markEnquiryResponded, src.paintEnquiries].join('\n') +
    '\nvar S = { state: "in", uid: "seller_uid_9" }; var ENQ = { rows: null, seq: 0 }; var ENQ_LIMIT = 200;' +
    '\nvar SPEC = null; function _q (spec) { SPEC = spec; return Promise.resolve(ROWS); } var ROWS = [];' +
    '\nvar UPD = null; var TOASTS = []; function toast (m) { TOASTS.push(m); } function _enqSheetIsOpen () { return false; }' +
    '\nfunction sdk () { return Promise.resolve({ fs: { doc: function (db, c, id) { return { path: c + "/" + id }; }, serverTimestamp: function () { return "__TS__"; },' +
    ' updateDoc: function (ref, data) { UPD = { ref: ref, data: data }; return Promise.resolve(); } } }); }' +
    '\nthis.api = { load: loadEnquiries, card: enqCard, mark: markEnquiryResponded, paint: paintEnquiries, get: function () { return { SPEC: SPEC, UPD: UPD, ENQ: ENQ, TOASTS: TOASTS }; }, setRows: function (r) { ROWS = r; }, setS: function (s) { S = s; } };', mctx);
  const api = mctx.api;
  api.setRows([
    { id: 'a', createdAt: { seconds: 100 } },
    { id: 'b', createdAt: { toDate: () => new Date(300000) } },
    { id: 'c' },
  ]);
  const lr = await api.load();
  const spec = api.get().SPEC;
  ck('M2  query: contactRequests where sellerUid == the signed-in auth uid (S.uid), bounded', spec && spec.collection === 'contactRequests' && JSON.stringify(spec.where) === JSON.stringify([['sellerUid', '==', 'seller_uid_9']]) && spec.limit === 200 && !spec.orderBy, spec);
  ck('M3  rows sorted newest-first on the client; undated last', lr.rows && lr.rows.map((x) => x.id).join(',') === 'b,a,c', lr.rows && lr.rows.map((x) => x.id));
  api.setS({ state: 'out', uid: null });
  const lo = await api.load();
  ck('M4  signed out → an error state, never an empty list', lo.error === 'signed-out' && !lo.rows, lo);

  const btn = { disabled: false, textContent: '' };
  api.mark('req_1', btn);
  await new Promise((r) => setTimeout(r, 20));
  const upd = api.get().UPD;
  ck('M5  Mark responded writes contactRequests/<id> with EXACTLY {status:"responded", respondedAt}', upd && upd.ref.path === 'contactRequests/req_1' && JSON.stringify(Object.keys(upd.data).sort()) === JSON.stringify(['respondedAt', 'status']) && upd.data.status === 'responded' && upd.data.respondedAt === '__TS__', upd);
  ck('M6  those keys ⊆ the served rule\'s hasOnly (status, respondedAt, sellerNote)', upd && Object.keys(upd.data).every((k) => hasOnly.includes(k)), { keys: upd && Object.keys(upd.data), hasOnly });

  const HOSTILE = '<img src=x onerror=alert(1)>"\'';
  const hostileRow = { id: 'x"><script>1</script>', productId: 'p"1', productName: HOSTILE, buyerName: HOSTILE, buyerPhone: '0712345678<b>', message: HOSTILE, status: '<i>pending</i>', createdAt: { seconds: 1 } };
  const unescapedFound = (html) => /<img|<script|<i>|<b>|onerror=alert\(1\)>/.test(html);
  const html = api.card(hostileRow);
  ck('M7  every rendered field is escaped (hostile product/buyer/message/status/id)', !unescapedFound(html) && html.includes('&lt;img'), html.slice(0, 300));
  ck('M8  product links to product.html?id=<encoded id>; tel: is digits only; no wa.me', /href="product\.html\?id=p%221"/.test(html) && /href="tel:\+254712345678"/.test(html) && !/wa\.me/.test(html), html);
  const html2 = api.card({ id: 'r', productId: 'p', productName: 'P', buyerName: 'B', message: '', status: 'responded' });
  ck('M9  responded rows offer no Mark button; absent message and phone render neutrally (no tel:)', !/data-enq-respond/.test(html2) && /No message/.test(html2) && !/tel:/.test(html2), html2);
  const host = { innerHTML: '' };
  mctx.ENQ_ROWS_EMPTY = true;
  vm.runInContext('ENQ.rows = [];', mctx);
  api.paint(host, null);
  ck('M10 empty → "No enquiries yet" (no fabricated count)', /No enquiries yet/.test(host.innerHTML) && !/>0</.test(host.innerHTML), host.innerHTML);
  api.paint(host, 'permission-denied');
  ck('M11 permission-denied → a permissions state with retry, not an empty inbox', /cannot read these enquiries/.test(host.innerHTML) && /data-enq-retry/.test(host.innerHTML), host.innerHTML);
  ck('M12 reachable: Dashboard quick action data-enquiries="open" + delegated click opens the sheet', /data-enquiries="open"/.test(M) && /closest\('\[data-enquiries\]'\)[\s\S]{0,40}openEnquiries\(\)/.test(M), null);
  ck('M13 staff (servedBy.role != owner) are told enquiries go to the owner — not shown an empty list', /S\.servedBy\.role !== 'owner'/.test(src.openEnquiries) && /Enquiries go to the shop owner/.test(src.openEnquiries), null);
  ck('M14 merchant-v2 still carries no wa.me link', !/wa\.me\//.test(M.replace(/\/\*[\s\S]*?\*\//g, '')), null);

  /* ── T: store.html ── */
  console.log('\n── T: store.html contact chip ──');
  const T = read('store.html');
  const Tcode = T.replace(/\/\*[\s\S]*?\*\//g, '');   /* the explanatory comment names the old chip */
  ck('T1  the "Message Seller" → messages.html dead end is gone', !/href="messages\.html"[^>]*>💬 Message Seller/.test(Tcode) && !/💬 Message Seller/.test(Tcode), null);
  ck('T2  "Ask about a product" opens the Products tab, only when the store lists products', /if\(products\.length\)\{\s*contacts\.push\(`<a href="#st-tab-products" onclick="return stAskAboutProduct\(\)"/.test(T) && /function stAskAboutProduct\(\)\{/.test(T), null);

  /* ── N: negative controls ── */
  console.log('\n── N: negative controls ──');
  const noUid = builderSrc.replace(/\n\s*buyerUid:\s*user\.uid,/, '\n');
  ck('N0  the mutation actually removed buyerUid from the builder', noUid !== builderSrc, null);
  const nf = builderFindings(noUid, hasAll).out;
  ck('N1  a builder WITHOUT buyerUid is caught by the A checks (buyerUid + hasAll)', nf.includes('buyerUid') && nf.includes('missing:buyerUid'), nf);
  const badCard = src.enqCard.replace("esc(q.message)", 'q.message');
  ck('N2a the mutation actually unescaped the message', badCard !== src.enqCard, null);
  const nctx = vm.createContext({});
  vm.runInContext([src.esc, src.waPhone, src.ago, src._enqDate, badCard].join('\n') + '\nthis.card = enqCard;', nctx);
  ck('N2  an unescaped render is caught by the M7 detector', unescapedFound(nctx.card(hostileRow)) === true, null);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log('\n' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
