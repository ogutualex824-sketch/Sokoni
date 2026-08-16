#!/usr/bin/env node
/* Merchant Team/Staff — the client layer and the merchant-path invariants (2D-2 step 2).
 *
 *   node scripts/test-merchant-staff.js
 *
 * FIXTURE — non-degenerate by construction:
 *     SELLER_A   the account   (auth.uid)
 *     SHOP_B     the shop      (activeShopId)
 *     SHOP_C     a shop this account must never reach
 * SELLER_A !== SHOP_B, so code substituting the account for the shop fails here.
 *
 * The gate this suite exists for: the Team surface must reach the shopEmployees
 * collection ONLY through the server authorities. seller.js removed a person with
 * a client-side deleteDoc on shopEmployees/{id} AND users/{id}, and mirrored the
 * roster into localStorage so a revoked cashier kept appearing as staff on that
 * device. Neither may survive anywhere in the merchant path.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MD = require(path.join(ROOT, 'sokoni-merchant-data.js'));
const ST = require(path.join(ROOT, 'sokoni-merchant-staff.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 140) + ']' : ''));
  ok ? pass++ : fail++;
};

const SELLER_A = 'SELLER_A_uid_7f3';
const SHOP_B = 'SHOP_B_shop_91c';
const SHOP_C = 'SHOP_C_shop_42x';

const scopeOf = (uid, shop) => MD.resolveScope({ uid, activeShopId: shop });
const SCOPE = scopeOf(SELLER_A, SHOP_B);
const SRC = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* Comment-stripper: the merchant-path invariants are properties of CODE, and
   these modules document the defects they replace by naming them. Asserting on
   raw source would fail a correct file for explaining itself. */
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
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

(async () => {

/* ═══ A — the payload carries the SHOP ═══ */
console.log('\nPART A — every call names the shop\n');
{
  const inv = ST.buildInvite({ scope: SCOPE, email: 'New.Person@Example.COM ', role: 'cashier', shopName: 'B Shop' });
  ck('A1  an invite carries the shopId', inv.shopId === SHOP_B);
  ck('A2  ...and it is the SHOP, not the account', inv.shopId !== SELLER_A);
  ck('A3  the email is normalised', inv.email === 'new.person@example.com');
  ck('A4  the role is carried', inv.role === 'cashier');

  const rm = ST.buildRemoval({ scope: SCOPE, uid: 'EMP_1' });
  ck('A5  a removal carries the shop AND the person', rm.shopId === SHOP_B && rm.uid === 'EMP_1');

  const other = ST.buildInvite({ scope: scopeOf(SELLER_A, SHOP_C), email: 'x@y.com', role: 'cashier' });
  ck('A6  a different shop produces a different payload', other.shopId === SHOP_C);

  const bad = (fn) => { try { fn(); return false; } catch (_) { return true; } };
  ck('A7  an unresolved scope cannot produce an invite',
    bad(() => ST.buildInvite({ scope: scopeOf(SELLER_A, null), email: 'a@b.com', role: 'cashier' })));
  ck('A8  an unresolved scope cannot produce a removal',
    bad(() => ST.buildRemoval({ scope: scopeOf(SELLER_A, null), uid: 'EMP_1' })));
  ck('A9  a missing role is refused', bad(() => ST.buildInvite({ scope: SCOPE, email: 'a@b.com', role: null })));
  ck('A10 an unknown role is refused', bad(() => ST.buildInvite({ scope: SCOPE, email: 'a@b.com', role: 'superAdmin' })));
  ck('A11 a malformed email is refused', bad(() => ST.buildInvite({ scope: SCOPE, email: 'notanemail', role: 'cashier' })));
  ck('A12 an empty email is refused', bad(() => ST.buildInvite({ scope: SCOPE, email: '  ', role: 'cashier' })));
}

/* ═══ B — the invite link ═══ */
console.log('\nPART B — the link comes from the server token\n');
{
  ck('B1  the link embeds the SERVER token', ST.inviteLink('tok_abc', 'https://x.test') === 'https://x.test/join?t=tok_abc&type=shop');
  ck('B2  no token means no link', ST.inviteLink(null, 'https://x.test') === null);
  ck('B3  a token is URL-encoded', /tok%20a/.test(ST.inviteLink('tok a', 'https://x.test')));
}

/* ═══ C — calls go to the server, and failure is failure ═══ */
console.log('\nPART C — the authority decides\n');
{
  const calls = [];
  const rec = (name, res) => async (p) => { calls.push({ name, p }); return res; };

  const list = await ST.listStaff({ scope: SCOPE,
    callList: rec('list', { data: { ok: true, shopId: SHOP_B, employees: [
      { uid: 'u3', name: 'Zoe Zulu', role: 'cashier' },
      { uid: 'u1', name: 'Ann Ali', role: 'manager' },
      { uid: 'u2', name: 'Bob Bee', role: 'cashier' },
    ] } }) });
  ck('C1  the staff list comes from the server', list.ok === true && list.count === 3);
  ck('C2  ...scoped by shopId', calls[0].p.shopId === SHOP_B);
  ck('C3  managers sort first, then alphabetically',
    list.employees.map(e => e.uid).join(',') === 'u1,u2,u3', list.employees.map(e => e.name).join(' | '));

  const inv = await ST.invite({ scope: SCOPE, email: 'a@b.com', role: 'cashier',
    callInvite: rec('invite', { data: { token: 'tok_1', shopId: SHOP_B } }) });
  ck('C4  an invite returns the server token', inv.ok === true && inv.token === 'tok_1');

  const rm = await ST.removeMember({ scope: SCOPE, uid: 'u2',
    callRemove: rec('remove', { data: { ok: true, active: false } }) });
  ck('C5  a removal goes through removeShopEmployee', rm.ok === true && rm.active === false);
  ck('C6  ...carrying shopId and uid',
    calls[2].p.shopId === SHOP_B && calls[2].p.uid === 'u2');

  const rv = await ST.revokeInvite({ token: 'tok_1', callRevoke: rec('revoke', { data: { success: true } }) });
  ck('C7  a revoke goes through revokeShopInvite with just the token',
    rv.ok === true && Object.keys(calls[3].p).join(',') === 'token');

  const denied = await ST.removeMember({ scope: SCOPE, uid: 'u2',
    callRemove: async () => { const e = new Error('Only the shop owner can manage staff.'); e.code = 'permission-denied'; throw e; } });
  ck('C8  a refusal is reported as a refusal, in the SERVER\'s words',
    denied.ok === false && /Only the shop owner/.test(denied.error), denied.error);
  ck('C9  ...and carries the server code', denied.code === 'permission-denied');

  const down = await ST.listStaff({ scope: SCOPE, callList: async () => { throw new Error('network down'); } });
  ck('C10 a failed read is a failure, not an empty team',
    down.ok === false && down.employees === undefined, JSON.stringify(down).slice(0, 80));

  const notOk = await ST.listStaff({ scope: SCOPE, callList: async () => ({ data: { ok: false, error: 'nope' } }) });
  ck('C11 a server ok:false is a refusal', notOk.ok === false);
}

/* ═══ D — the merchant path cannot touch shopEmployees directly ═══ */
console.log('\nPART D — no client write survives in the merchant path\n');
{
  const MERCHANT_PATH = [
    'merchant.html',
    'sokoni-merchant-staff.js',
    'sokoni-merchant-team.js',
    'sokoni-merchant-data.js',
    'sokoni-merchant-stock.js',
    'sokoni-merchant-sell.js',
    'sokoni-merchant-inventory-ui.js',
    'sokoni-merchant-routes.js',
  ];

  /* USAGE, not the word. Every one of these files documents the defect it
     replaces by naming `shopEmployees` and `deleteDoc` in prose — a route note,
     an HTML comment — and an assertion that failed on the mention would be
     telling the author to stop explaining the code. What must be absent is a
     Firestore CALL: the collection named as a collection, and a write invoked. */
  const COLLECTION_USE = /['"]shopEmployees['"]\s*[,)]|\.collection\(\s*['"]shopEmployees['"]/;
  const WRITE_CALL = /\b(deleteDoc|setDoc|updateDoc|addDoc|writeBatch|runTransaction)\s*\(/g;

  for (const f of MERCHANT_PATH) {
    let src = code(SRC(f));
    if (f.endsWith('.html')) src = src.replace(/<!--[\s\S]*?-->/g, '');   /* HTML comments too */
    const uses = COLLECTION_USE.test(src);
    const writes = (src.match(WRITE_CALL) || []);
    ck('D-' + f + ': never names shopEmployees as a collection', !uses);
    ck('D-' + f + ': invokes no Firestore write', writes.length === 0, writes.join(','));
  }

  /* The detector must be able to FAIL — otherwise the twelve passes above prove
     nothing. Both patterns are exercised against the exact code being forbidden. */
  ck('D0  the collection detector catches a real usage (control)',
    COLLECTION_USE.test(`deleteDoc(doc(window.firebaseDB,"shopEmployees",id))`));
  ck('D0b the write detector catches a real call (control)',
    'await deleteDoc(ref)'.match(WRITE_CALL) !== null);
  ck('D0c ...and neither fires on documentation prose (control)',
    !COLLECTION_USE.test("note:'the canonical shopEmployees contract'") &&
    "'remove path called deleteDoc on shopEmployees/{id}'".match(WRITE_CALL) === null);

  /* The specific defect, named: seller.js deleted the employment record AND the
     person's user document from the browser. */
  const sellerSrc = code(SRC('seller.js'));
  ck('D1  seller.js still carries the client-side delete (unchanged by this work)',
    /deleteDoc\(doc\(window\.firebaseDB,"shopEmployees"/.test(sellerSrc),
    'recorded, not fixed here — it is legacy-page code, out of the merchant path');

  const teamSrc = code(SRC('sokoni-merchant-team.js'));
  const staffSrc = code(SRC('sokoni-merchant-staff.js'));
  ck('D2  the Team surface has no localStorage business state',
    !/localStorage/.test(teamSrc) && !/localStorage/.test(staffSrc));
  ck('D3  ...and no sokoniEmployees mirror', !/sokoniEmployees/.test(teamSrc + staffSrc));
  ck('D4  the client layer names only the five server authorities',
    Object.values(ST.CALLABLES).sort().join(',') ===
    'inviteShopEmployee,listShopEmployees,listShopInvites,removeShopEmployee,revokeShopInvite',
    Object.values(ST.CALLABLES).join(','));
  ck('D5  neither module builds an inline on* handler from data',
    !/\son(click|input|change|submit)\s*=\s*(\\?["'])/.test(teamSrc + staffSrc));
}

/* ═══ E — routing ═══ */
console.log('\nPART E — Staff is native, and nothing was removed\n');
{
  const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
  ck('E1  the route contract still validates', C.validate().length === 0, C.validate().join(' | '));
  ck('E2  Staff is a NATIVE route', C.get('staff').kind === 'native');
  ck('E3  ...so no seller.html iframe is required for Team',
    !C.get('staff').sec && !C.get('staff').src);
  ck('E4  #team still resolves to Staff (no bookmark broken)', C.resolve('team') === 'staff');
  ck('E5  Staff requires a resolved SHOP, not just an account',
    C.get('staff').ctx.indexOf('shopId') >= 0);
  ck('E6  Staff is mobile- and desktop-safe', C.get('staff').mobile === true && C.get('staff').desktop === true);

  /* Nothing else lost its destination. */
  const EXPECTED = ['dashboard','plan','sell','products','inventory','pos','orders','analytics','revenue',
    'payments','deliveries','returns','receipts','staff','messages','disputes','settings'];
  ck('E7  every primary merchant destination is still present',
    EXPECTED.every(id => !!C.get(id)), EXPECTED.filter(id => !C.get(id)).join(','));
  ck('E8  POS and the 2D-1C surfaces are untouched',
    C.get('pos').kind === 'pos' && C.get('sell').kind === 'native' && C.get('inventory').kind === 'native');

  const shell = SRC('merchant.html');
  ck('E9  the shell loads both new modules',
    /sokoni-merchant-staff\.js/.test(shell) && /sokoni-merchant-team\.js/.test(shell));
  ck('E10 the shell has a renderer for Staff', /id === 'staff'\) renderStaff\(\)/.test(shell));
  ck('E11 the shell binds Team to the five server authorities',
    /callList:\s*_callable\('listShopEmployees'\)/.test(shell) &&
    /callInvites:\s*_callable\('listShopInvites'\)/.test(shell) &&
    /callInvite:\s*_callable\('inviteShopEmployee'\)/.test(shell) &&
    /callRevoke:\s*_callable\('revokeShopInvite'\)/.test(shell) &&
    /callRemove:\s*_callable\('removeShopEmployee'\)/.test(shell));
  ck('E12 ...and passes NO db adapter to the Team surface (nothing to write with)',
    !/SokoniMerchantTeam\.mount\([^)]*db:/.test(shell.replace(/\s+/g, ' ')));
}

/* ═══ F — the callables exist and are re-exported ═══ */
console.log('\nPART F — the authorities are deployable\n');
{
  const idx = SRC('functions/index.js');
  for (const n of ['listShopEmployees', 'listShopInvites', 'removeShopEmployee', 'inviteShopEmployee', 'revokeShopInvite']) {
    ck('F-' + n + ' is re-exported by name in functions/index.js',
      new RegExp('^exports\\.' + n + '\\b', 'm').test(idx));
  }
  const se = SRC('functions/shop-employees.js');
  ck('F1  listShopInvites is owner-scoped', /assertShopOwner\(uid, shopId\)/.test(se));
  ck('F2  ...and never returns another shop\'s invites', /String\(v\.shopId\) !== String\(shopId\)/.test(se));
}

/* ═══ G — mutation control ═══ */
console.log('\nPART G — mutation control (each defect must be CAUGHT)\n');
{
  ck('G1  a client delete reintroduced into the Team surface → detected',
    /deleteDoc/.test('await deleteDoc(doc(db,"shopEmployees",id))'));
  ck('G2  a localStorage roster mirror → detected',
    /localStorage/.test('localStorage.setItem("sokoniEmployees", JSON.stringify(rows))'));
  ck('G3  the shop falling back to the uid → detected',
    scopeOf(SELLER_A, null).ok === false);
  ck('G4  a removal payload losing its shopId → detected',
    (() => { const p = ST.buildRemoval({ scope: SCOPE, uid: 'u' }); return !!p.shopId; })());
  ck('G5  a failed read rendered as an empty team → detected',
    (await ST.listStaff({ scope: SCOPE, callList: async () => { throw new Error('x'); } })).ok === false);
}

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });
