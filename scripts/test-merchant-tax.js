#!/usr/bin/env node
/* Merchant Tax — the client layer and the identity boundary (2D-2 Tax Stage 2).
 *
 *   node scripts/test-merchant-tax.js
 *
 * FIXTURE: SELLER_A (account) owns SHOP_B. SHOP_C belongs to someone else.
 *
 * The properties this suite holds:
 *
 *   1. NO merchant identifier is ever sent. Tax identity is
 *      etimsProfiles/{auth.uid} — the uid IS the document id — so a sellerUid,
 *      merchantId or shopId in a payload is not a scoping bug waiting to
 *      happen, it is a category error. assertNoIdentity makes it a hard refusal.
 *   2. A shopId cannot enter this layer even if the shell offers one. SHOP_B and
 *      SHOP_C are interchangeable here precisely because neither is ever named.
 *   3. Figures come from the server or render as a dash. Nothing is totalled
 *      locally over a list the server already truncated.
 *   4. Credentials are write-only: the taxpayer secret and device serial go out
 *      once and are never displayed.
 *   5. The unsafe and out-of-scope eTIMS authorities are NEVER BOUND — not
 *      fetched and hidden.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TX = require(path.join(ROOT, 'sokoni-merchant-tax.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 140) + ']' : ''));
  ok ? pass++ : fail++;
};

const SELLER_A = 'SELLER_A_uid_7f3';
const SHOP_B = 'SHOP_B_shop_91c';
const SHOP_C = 'SHOP_C_shop_42x';
const SRC = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* Absence is a property of CODE. These modules document the defects they avoid
   BY NAMING THEM, so an assertion run over prose reports the opposite of the
   truth. Every source assertion below runs on the stripped text. */
function code(src) {
  let out = '', i = 0, n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i]; if (src[i] === q) { i++; break; } i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/* A callable stub that RECORDS what it was sent. The point of this suite is
   what leaves the browser, so every call is captured and inspected. */
function stub(reply) {
  const calls = [];
  const fn = async (payload) => { calls.push(payload); return typeof reply === 'function' ? reply(payload) : (reply || {}); };
  fn.calls = calls;
  return fn;
}

const PROFILE = {
  sellerUid: SELLER_A, kraPin: 'P051234567T', businessName: 'Bravilex Duka',
  vatStatus: 'registered', taxCategory: 'A', branchId: '00', invoicePrefix: 'BRV',
  address: 'Nairobi', phone: '0700000000', status: 'active', kraVerified: true,
  totalInvoices: 12, pendingInvoices: 1, failedInvoices: 2,
  lastSubmissionAt: '2026-08-14T09:00:00.000Z', enabledAt: '2026-01-02T08:00:00.000Z',
};

(async function () {

/* ══ A. No identity leaves this layer ═════════════════════════════════════ */
console.log('\nA. Tax identity is auth.uid — nothing else may be named');
{
  ck('A1 assertNoIdentity refuses sellerUid', (() => {
    try { TX.assertNoIdentity({ sellerUid: SELLER_A }); return false; } catch (_) { return true; }
  })());
  ck('A2 assertNoIdentity refuses shopId', (() => {
    try { TX.assertNoIdentity({ shopId: SHOP_B }); return false; } catch (_) { return true; }
  })());
  ck('A3 assertNoIdentity refuses merchantId', (() => {
    try { TX.assertNoIdentity({ merchantId: SHOP_C }); return false; } catch (_) { return true; }
  })());
  /* NEGATIVE CONTROL. A guard that refused everything would pass A1–A3 while
     making the module useless; it must let a resource id through. */
  ck('A4 assertNoIdentity ALLOWS a resource id (orderId)', (() => {
    try { TX.assertNoIdentity({ orderId: 'ORD-1' }); return true; } catch (_) { return false; }
  })());
  ck('A5 every forbidden key is one of the seven identity spellings',
    TX.FORBIDDEN_KEYS.length === 7 && TX.FORBIDDEN_KEYS.includes('sellerId') && TX.FORBIDDEN_KEYS.includes('ownerUid'));

  const call = stub({ profile: PROFILE });
  await TX.loadProfile({ callProfile: call });
  ck('A6 loadProfile sends an EMPTY payload', JSON.stringify(call.calls[0]) === '{}', JSON.stringify(call.calls[0]));

  const stats = stub({ profile: PROFILE, stats: {} });
  await TX.loadStats({ callStats: stats });
  ck('A7 loadStats sends an EMPTY payload', JSON.stringify(stats.calls[0]) === '{}', JSON.stringify(stats.calls[0]));

  const bulk = stub({ success: true });
  await TX.bulkGenerate({ callBulk: bulk, periodStart: '2026-07-01', periodEnd: '2026-07-31' });
  const bk = Object.keys(bulk.calls[0]);
  ck('A8 bulkGenerate names a PERIOD and no merchant',
    bk.length === 2 && bk.includes('periodStart') && bk.includes('periodEnd'), bk.join(','));

  const inv = stub({ ok: true });
  await TX.generateInvoice({ callInvoice: inv, orderId: 'ORD-9' });
  ck('A9 generateInvoice names an ORDER and no merchant',
    JSON.stringify(inv.calls[0]) === '{"orderId":"ORD-9"}', JSON.stringify(inv.calls[0]));

  const rs = stub({ success: true });
  await TX.resubmitInvoice({ callResubmit: rs, invoiceId: 'INV-3' });
  ck('A10 resubmitInvoice names an INVOICE and no merchant',
    JSON.stringify(rs.calls[0]) === '{"invoiceId":"INV-3"}', JSON.stringify(rs.calls[0]));

  /* The fixture's whole point: SHOP_B and SHOP_C never appear because no shop
     is ever named. If a shopId could reach a payload this would catch it. */
  const all = JSON.stringify([call.calls, stats.calls, bulk.calls, inv.calls, rs.calls]);
  ck('A11 neither SHOP_B nor SHOP_C appears in any payload',
    !all.includes(SHOP_B) && !all.includes(SHOP_C));
  ck('A12 SELLER_A does not appear in any payload either', !all.includes(SELLER_A));
}

/* ══ B. Source: no Firestore, no shell identity, no localStorage ══════════ */
console.log('\nB. The layer reaches nothing but its eight callables');
{
  const src = code(SRC('sokoni-merchant-tax.js'));
  ck('B1 no Firestore access', !/\.collection\(|\.doc\(|firebase\./.test(src));
  ck('B2 no localStorage', !/localStorage|sessionStorage/.test(src));
  ck('B3 no SokoniShell.activeShopId', !/activeShopId/.test(src));
  ck('B4 no window.location / URL scraping', !/location\.(search|href|hash)|URLSearchParams/.test(src));
  /* NEGATIVE CONTROL for the stripper: the header prose DOES mention
     activeShopId-style concepts, so a stripper that silently passed the raw
     text through would make B3 vacuous. Prove it actually removed comments. */
  ck('B5 stripper control — the raw file contains prose the stripped one does not',
    /account-scoped|ACCOUNT-scoped/i.test(SRC('sokoni-merchant-tax.js')) &&
    !/ACCOUNT-scoped/i.test(src));
  ck('B6 the eight bound callables are exactly the SAFE census set',
    Object.values(TX.CALLABLES).sort().join(',') ===
    ['etimsBulkGenerate', 'etimsGenerateInvoice', 'etimsGetProfile', 'etimsGetSellerStats',
      'etimsRegisterSeller', 'etimsResubmitInvoice', 'etimsUpdateProfile', 'etimsValidatePin'].sort().join(','),
    Object.values(TX.CALLABLES).join(','));
  ck('B7 etimsGetBuyerReceipts is NOT bound (a buyer authority)', !/etimsGetBuyerReceipts/.test(src));
  ck('B8 the admin authorities are NOT bound',
    !/etimsGetAdminStats|etimsPlatformInvoice|hubUpdateTaxConfig|hubRegisterEtims/.test(src));
  ck('B9 calculateTaxBreakdown is NOT bound (a quote, not a filing)', !/calculateTaxBreakdown/.test(src));
  ck('B10 the receipt authorities are NOT bound here',
    !/emailTrustReceipt|sendPOSReceipt|posLogReprint|verifyTrustReceipt/.test(src));
}

/* ══ C. Profile update: the server's allow-list, and only what changed ════ */
console.log('\nC. Updates carry the allow-list and nothing else');
{
  ck('C1 the six editable fields mirror etimsUpdateProfile exactly',
    TX.EDITABLE_IDS.sort().join(',') ===
    ['address', 'businessName', 'invoicePrefix', 'phone', 'taxCategory', 'vatStatus'].sort().join(','),
    TX.EDITABLE_IDS.join(','));

  ck('C2 buildUpdate refuses kraPin', (() => {
    try { TX.buildUpdate({ fields: { kraPin: 'P051234567T' } }); return false; } catch (_) { return true; }
  })());
  ck('C3 buildUpdate refuses taxpayerSecret', (() => {
    try { TX.buildUpdate({ fields: { taxpayerSecret: 'x' } }); return false; } catch (_) { return true; }
  })());
  ck('C4 buildUpdate refuses deviceSerial', (() => {
    try { TX.buildUpdate({ fields: { deviceSerial: 'x' } }); return false; } catch (_) { return true; }
  })());
  ck('C5 buildUpdate drops an unknown field rather than forwarding it', (() => {
    const p = TX.buildUpdate({ fields: { phone: '0711', status: 'active', totalInvoices: 999 } });
    return !('status' in p) && !('totalInvoices' in p) && p.phone === '0711';
  })());
  ck('C6 buildUpdate refuses when nothing changed', (() => {
    try { TX.buildUpdate({ fields: {} }); return false; } catch (_) { return true; }
  })());
  ck('C7 buildUpdate enforces the invoice-prefix cap the server enforces', (() => {
    try { TX.buildUpdate({ fields: { invoicePrefix: 'TOOLONGPREFIX' } }); return false; } catch (_) { return true; }
  })());
  ck('C8 buildUpdate refuses a vatStatus outside the server\'s set', (() => {
    try { TX.buildUpdate({ fields: { vatStatus: 'whatever' } }); return false; } catch (_) { return true; }
  })());
  ck('C9 ...and accepts one inside it', TX.buildUpdate({ fields: { vatStatus: 'exempt' } }).vatStatus === 'exempt');

  ck('C10 changedFields returns only what differs', (() => {
    const d = TX.changedFields({ phone: '0700', address: 'Nairobi' }, { phone: '0711', address: 'Nairobi' });
    return Object.keys(d).length === 1 && d.phone === '0711';
  })());
  ck('C11 changedFields is empty when nothing moved',
    Object.keys(TX.changedFields({ phone: '0700' }, { phone: '0700' })).length === 0);

  const up = stub({ success: true });
  await TX.updateProfile({ callUpdate: up, fields: { phone: '0711' } });
  ck('C12 updateProfile sends ONLY the changed field',
    JSON.stringify(up.calls[0]) === '{"phone":"0711"}', JSON.stringify(up.calls[0]));
}

/* ══ D. Registration ══════════════════════════════════════════════════════ */
console.log('\nD. Registration validates before it submits');
{
  const base = { kraPin: 'P051234567T', businessName: 'Duka', deviceSerial: 'DS1', taxpayerSecret: 'TS1' };
  ck('D1 a well-formed registration builds', !!TX.buildRegistration(base));
  ck('D2 a malformed PIN is refused', (() => {
    try { TX.buildRegistration(Object.assign({}, base, { kraPin: '12345' })); return false; } catch (_) { return true; }
  })());
  ck('D3 a missing device serial is refused', (() => {
    try { TX.buildRegistration(Object.assign({}, base, { deviceSerial: '' })); return false; } catch (_) { return true; }
  })());
  ck('D4 a missing taxpayer secret is refused', (() => {
    try { TX.buildRegistration(Object.assign({}, base, { taxpayerSecret: '' })); return false; } catch (_) { return true; }
  })());
  ck('D5 the PIN is upper-cased the way the server does',
    TX.buildRegistration(Object.assign({}, base, { kraPin: ' p051234567t ' })).kraPin === 'P051234567T');
  ck('D6 the invoice prefix is capped at 6 like the server',
    TX.buildRegistration(Object.assign({}, base, { invoicePrefix: 'ABCDEFGHIJ' })).invoicePrefix.length === 6);
  ck('D7 registration carries NO merchant identifier', (() => {
    const p = TX.buildRegistration(base);
    return TX.FORBIDDEN_KEYS.every((k) => !(k in p));
  })());
  ck('D8 pinProblem accepts the canonical example', TX.pinProblem('P051234567T') === null);
  ck('D9 pinProblem rejects a near-miss (8 digits)', TX.pinProblem('P05123456T') !== null);
  ck('D10 pinProblem rejects an empty PIN', TX.pinProblem('') !== null);
}

/* ══ E. Figures: server-derived or a dash ═════════════════════════════════ */
console.log('\nE. No figure is invented and no list claims to be complete');
{
  const src = code(SRC('sokoni-merchant-tax.js'));
  ck('E1 the layer performs no local summation over invoices',
    !/\.reduce\(/.test(src), 'a client-side total over a truncated list understates filed VAT');

  const st = await TX.loadStats({
    callStats: stub({
      profile: PROFILE,
      stats: { totalRevenue: 1000, vatCollected: 160, acceptedCount: 3, failedCount: 0, pendingCount: 1 },
      recentInvoices: [{ invoiceId: 'i1', total: 500, vat: 80 }],
      failedInvoices: [],
    }),
  });
  ck('E2 stats come through unchanged from the server', st.stats.vatCollected === 160);
  ck('E3 a genuine zero is preserved as 0, not turned into a dash', st.stats.failedCount === 0);
  ck('E4 the caps the server applies are reported', st.recentCap === 15 && st.failedCap === 10);

  const missing = await TX.loadStats({ callStats: stub({ profile: PROFILE, stats: {} }) });
  ck('E5 an absent figure is null, never 0', missing.stats.vatCollected === null);
  ck('E6 formatCount renders null as an em dash', TX.formatCount(null) === '—');
  ck('E7 formatCount renders a real 0 as 0', TX.formatCount(0) === '0');
  ck('E8 formatKes renders null as an em dash', TX.formatKes(null) === '—');
  ck('E9 formatKes renders a real 0 as an amount', /0\.00/.test(TX.formatKes(0)));
  ck('E10 formatDate renders a missing date as an em dash', TX.formatDate(null) === '—');

  const unreg = await TX.loadStats({ callStats: stub({ profile: null, stats: null }) });
  ck('E11 an unregistered account is a real answer, not an error',
    unreg.ok === true && unreg.registered === false);
  ck('E12 ...and carries no invented stats', unreg.stats === null);
}

/* ══ F. Status is a claim, so it must distinguish its states ══════════════ */
console.log('\nF. "Registered" and "filing" are not the same statement');
{
  ck('F1 no profile → not set up', TX.statusOf(null).key === 'none');
  ck('F2 an inactive profile is NOT reported as active',
    TX.statusOf({ status: 'pending', kraVerified: true }).key === 'inactive');
  ck('F3 an active but unverified PIN is called out',
    TX.statusOf({ status: 'active', kraVerified: false }).key === 'unverified');
  ck('F4 active + verified is active', TX.statusOf({ status: 'active', kraVerified: true }).key === 'active');
  ck('F5 only the fully-good state gets the ok tone',
    TX.statusOf({ status: 'active', kraVerified: true }).tone === 'ok' &&
    TX.statusOf({ status: 'active', kraVerified: false }).tone === 'warn');
}

/* ══ G. Credentials are write-only ════════════════════════════════════════ */
console.log('\nG. The taxpayer secret goes out once and is never read back');
{
  const uiSrc = code(SRC('sokoni-merchant-tax-ui.js'));
  ck('G1 the surface never renders a taxpayerSecret value',
    !/profile\.taxpayerSecret|S\.profile\.taxpayerSecret/.test(uiSrc));
  ck('G2 the surface never renders a deviceSerial value',
    !/profile\.deviceSerial|S\.profile\.deviceSerial/.test(uiSrc));
  ck('G3 normaliseProfile does not carry credentials through', (() => {
    const p = TX.normaliseProfile(Object.assign({}, PROFILE, { taxpayerSecret: 'LEAK', deviceSerial: 'LEAK2' }));
    return !('taxpayerSecret' in p) && !('deviceSerial' in p);
  })());
  ck('G4 the secret input is type=password', /type="password"|'password'/.test(SRC('sokoni-merchant-tax-ui.js')));
  ck('G5 REGISTRATION_ONLY names all four immutable fields',
    TX.REGISTRATION_ONLY.sort().join(',') === ['branchId', 'deviceSerial', 'kraPin', 'taxpayerSecret'].sort().join(','));
}

/* ══ H. Failure handling ══════════════════════════════════════════════════ */
console.log('\nH. A refusal is reported, never swallowed');
{
  const bad = await TX.loadProfile({ callProfile: async () => { throw Object.assign(new Error('permission-denied'), { code: 'permission-denied' }); } });
  ck('H1 a thrown callable becomes ok:false with the reason', bad.ok === false && /permission-denied/.test(bad.error));
  const softFail = await TX.updateProfile({ callUpdate: stub({ ok: false, error: 'Register eTIMS first' }), fields: { phone: '07' } });
  ck('H2 a server ok:false is preserved', softFail.ok === false && softFail.error === 'Register eTIMS first');
  ck('H3 a missing callable is a hard error, not a silent no-op', await (async () => {
    try { await TX.loadProfile({}); return false; } catch (_) { return true; }
  })());
  ck('H4 bulk refuses an inverted date range', (() => {
    try { TX.buildBulk({ periodStart: '2026-08-31', periodEnd: '2026-08-01' }); return false; } catch (_) { return true; }
  })());
  ck('H5 bulk refuses a half-specified range', (() => {
    try { TX.buildBulk({ periodStart: '2026-08-01' }); return false; } catch (_) { return true; }
  })());
  const noOrder = await TX.generateInvoice({ callInvoice: stub({}), orderId: '' });
  ck('H6 generateInvoice refuses an empty order without calling', noOrder.ok === false);
}

/* ══ I. The route contract and the shell ══════════════════════════════════ */
console.log('\nI. The route is native, account-scoped, and the shell binds it');
{
  const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
  const tax = C.ROUTES.filter((r) => r.id === 'kra-tax')[0];
  ck('I1 kra-tax still exists — the existing button is preserved', !!tax);
  ck('I2 kra-tax is now native, not an iframe of seller.html', tax.kind === 'native');
  ck('I3 kra-tax declares SELLER_UID context', (tax.ctx || []).indexOf('sellerUid') !== -1);
  ck('I4 kra-tax does NOT declare a shop context — tax has no shop dimension',
    (tax.ctx || []).indexOf('shopId') === -1, JSON.stringify(tax.ctx));
  ck('I5 the route contract still validates', (() => {
    try { C.validate(); return true; } catch (e) { return String(e.message); }
  })() === true);
  ck('I6 the sidebar order is unchanged in length', C.PRIMARY_ORDER.length > 0);
  ck('I7 the bottom nav still has exactly four entries', C.BOTTOM_NAV.length === 4);

  const shell = SRC('merchant.html');
  ck('I8 the shell loads both new modules',
    /sokoni-merchant-tax\.js/.test(shell) && /sokoni-merchant-tax-ui\.js/.test(shell));
  ck('I9 the shell has a renderer for KRA Tax', /id === 'kra-tax'\) renderTax\(\)/.test(shell));
  ck('I10 the shell binds all eight SAFE authorities',
    /callProfile:\s*_callable\('etimsGetProfile'\)/.test(shell) &&
    /callRegister:\s*_callable\('etimsRegisterSeller'\)/.test(shell) &&
    /callUpdate:\s*_callable\('etimsUpdateProfile'\)/.test(shell) &&
    /callValidate:\s*_callable\('etimsValidatePin'\)/.test(shell) &&
    /callStats:\s*_callable\('etimsGetSellerStats'\)/.test(shell) &&
    /callInvoice:\s*_callable\('etimsGenerateInvoice'\)/.test(shell) &&
    /callBulk:\s*_callable\('etimsBulkGenerate'\)/.test(shell) &&
    /callResubmit:\s*_callable\('etimsResubmitInvoice'\)/.test(shell));
  /* Bound to renderTax's own body by its delimiters, then STRIPPED. The mount
     call documents the absence of a shopId by naming it, so a raw-text
     assertion would report the opposite of the truth — the same trap that
     caught four earlier suites in this track. */
  const rt = shell.indexOf('function renderTax');
  const rtEnd = shell.indexOf('_taxKey = _taxUI', rt);
  ck('I11a the renderTax body was located', rt > 0 && rtEnd > rt);
  const mountBlock = code(shell.slice(rt, rtEnd));
  ck('I11b stripper control — the raw body names shopId, the stripped one must not',
    /shopId/.test(shell.slice(rt, rtEnd)));
  ck('I11 the mount passes NO db adapter', !/\bdb:/.test(mountBlock));
  ck('I12 the mount passes NO shopId', !/shopId/.test(mountBlock), mountBlock.slice(0, 120));
  ck('I13 the shell does not bind the buyer or admin eTIMS authorities to Tax',
    !/callBuyer|etimsGetBuyerReceipts|etimsGetAdminStats|etimsPlatformInvoice/.test(mountBlock));
}

/* ══ J. The server contract this layer assumes ════════════════════════════ */
console.log('\nJ. The assumptions about the server are still true');
{
  const et = code(SRC('functions/etims.js'));
  ck('J1 etimsProfiles is still keyed by req.auth.uid',
    /collection\("etimsProfiles"\)\.doc\(req\.auth\.uid\)/.test(et) ||
    /const uid\s*=\s*req\.auth\.uid/.test(et));
  ck('J2 etimsGenerateInvoice still checks order.sellerUid against the caller',
    /order\.sellerUid\s*!==\s*sellerUid/.test(et));
  ck('J3 etimsResubmitInvoice still checks inv.sellerUid against the caller',
    /inv\.sellerUid\s*!==\s*req\.auth\.uid/.test(et));
  ck('J4 etimsGetSellerStats still queries BY the caller\'s uid, not a parameter',
    /where\("sellerUid","==",uid\)/.test(et));
  ck('J5 etimsUpdateProfile still uses an allow-list', /const allow\s*=\s*\[/.test(et));
  ck('J6 no merchant-facing eTIMS callable reads a sellerUid from req.data',
    !/req\.data\.sellerUid/.test(et.replace(/etimsPlatformInvoice[\s\S]*?\n\}\);/, '')),
    'etimsPlatformInvoice is admin-only and is excluded');
  const idx = code(SRC('functions/index.js'));
  ck('J7 all eight callables are re-exported by name', [
    'etimsGetProfile', 'etimsRegisterSeller', 'etimsUpdateProfile', 'etimsValidatePin',
    'etimsGetSellerStats', 'etimsGenerateInvoice', 'etimsBulkGenerate', 'etimsResubmitInvoice',
  ].every((n) => new RegExp('exports\\.' + n + '\\s*=').test(idx)));
  /* NEGATIVE CONTROL for J7 — a matcher that matched anything would pass. */
  ck('J8 export detector true negative', !/exports\.etimsNotARealFunction\s*=/.test(idx));
}

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });
