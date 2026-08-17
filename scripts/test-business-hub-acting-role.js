#!/usr/bin/env node
/* Business Hub follows the ACTING role — without ever becoming an authority.
 *
 *   npm run test:profile:acting-role
 *
 * THE THREE CONCEPTS THIS SUITE KEEPS APART
 *
 *   AUTHORITY       approved seller -> may exercise seller capability   _isSellerUser / _hasRole
 *   ACTING CONTEXT  active  seller  -> Profile PRESENTS the seller hub  _actingAs
 *   DIRECT ROUTING  approved seller -> seller.html stays reachable      guardWorkspace (untouched)
 *
 * The shipped defect was that Profile had only the first: switching to Buyer left the Business
 * Hub on screen, because _renderBusinessHub() read entitlement and nothing anywhere listened to
 * the authority's own sokoniActiveRoleChanged. The fix composes acting context ON TOP of
 * entitlement in that one function, so a switch changes presentation and NOTHING else.
 *
 * The dangerous failure mode is the inverse: a role switch that GRANTS. Case 10 exists for that —
 * selecting a role the account does not hold must present nothing, because _hasRole still has to
 * agree. If _actingAs() were ever rewritten as `activeRole === role` alone, case 10 fails.
 *
 * METHOD
 * The real predicate + render source is sliced out of profile.html and executed against a DOM
 * shim. It is the SHIPPING source, not a re-implementation — if the slice markers move, the
 * harness aborts rather than testing nothing. Section 9 is the negative control: it re-runs the
 * matrix with _actingAs() neutered back to _hasRole() and requires the entitlement-only cases to
 * FAIL, proving these assertions can distinguish the fix from its absence.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n-- ' + t + ' --');

const SRC = fs.readFileSync(path.join(ROOT, 'profile.html'), 'utf8');

/* -- slice the real source -------------------------------------------------- */
function slice(startMarker, endMarker, afterEnd) {
  const a = SRC.indexOf(startMarker);
  if (a < 0) throw new Error('slice start marker not found: ' + startMarker);
  const b = SRC.indexOf(endMarker, a);
  if (b < 0) throw new Error('slice end marker not found: ' + endMarker);
  const c = SRC.indexOf(afterEnd, b);
  if (c < 0) throw new Error('slice terminator not found after: ' + endMarker);
  return SRC.slice(a, c + afterEnd.length);
}

/* predicates + the Business Hub renderer */
const PRED = slice('function _syncMyStoreBtn(u){', 'if(provider) _bizRouteProvider(u);', '\n}');
/* the single coalesced refresh + its guarded subscription */
const REFRESH = slice('var _roleUiRefreshPending = false;', "document.addEventListener('sokoniActiveRoleChanged', _refreshRoleDependentUI);", '\n}');

/* -- harness ---------------------------------------------------------------- */
function el() { return { style: {}, innerHTML: '', setAttribute() {}, getAttribute() { return null; } }; }

function load(opts, mutate) {
  const o = opts || {};
  const els = {};
  const listeners = {};
  const counts = { switcher: 0, chips: 0, hub: 0 };

  const doc = {
    getElementById: (id) => (els[id] || (els[id] = el())),
    addEventListener: (t, fn) => { (listeners[t] || (listeners[t] = [])).push(fn); },
    dispatchEvent: (e) => { (listeners[e.type] || []).forEach((fn) => fn(e)); return true; },
  };

  /* The authority. isVerified() true means the claim set is KNOWN, so _hasRole trusts its noes —
     that is the production path and the one every case below runs on. */
  const state = { active: o.active || 'buyer', approved: (o.approved || ['buyer']).slice() };
  const win = {
    SokoniRoleAuthority: {
      isVerified: () => o.unverified !== true,
      isApproved: (r) => state.approved.indexOf(r) > -1,
      getActiveRole: () => state.active,
    },
    SokoniPermissions: undefined,   /* _isAdminUser fails closed without it */
  };

  const user = () => ({ uid: 'u1', roles: state.approved.slice(), activeRole: state.active });

  let body = PRED + '\n' + REFRESH;
  if (mutate) {
    const before = body;
    body = mutate(body);
    if (body === before) throw new Error('control mutation did not apply - source shape changed');
  }

  const api = new Function(
    'window', 'document', 'escHtml', '_bizRouteProvider', 'getUser',
    'renderRoleSwitcher', 'renderRoleChips', 'setTimeout',
    /* _user is the page-scope cache renderRoleSwitcher() refreshes. It is null here, which is
       exactly the state before that render runs, so the `|| getUser()` fallback governs. */
    'var _user = null;\n' + body +
    '\nreturn { _renderBusinessHub: _renderBusinessHub, _syncMyStoreBtn: _syncMyStoreBtn,' +
    ' _actingAs: _actingAs, _activeRoleNow: _activeRoleNow, _isSellerUser: _isSellerUser,' +
    ' _refreshRoleDependentUI: _refreshRoleDependentUI };'
  )(
    win, doc, String, function () {}, user,
    function () { counts.switcher++; }, function () { counts.chips++; },
    (fn, ms) => setTimeout(fn, ms)
  );

  const render = () => { counts.hub++; api._renderBusinessHub(user()); api._syncMyStoreBtn(user()); };
  render();

  return {
    api, doc, win, counts, state, els, render,
    hubVisible: () => els.upBizHub && els.upBizHub.style.display === 'block',
    hubHas: (t) => !!(els.upBizHubGrid && els.upBizHubGrid.innerHTML.indexOf(t) > -1),
    myStoreVisible: () => els.upMyStoreBtn && els.upMyStoreBtn.style.display === 'inline-flex',
    /* switch the way production does: the authority changes, then announces it */
    switchTo: (role) => {
      state.active = role;
      doc.dispatchEvent({ type: 'sokoniActiveRoleChanged', detail: { role } });
    },
    settle: () => new Promise((r) => setTimeout(r, 5)),
  };
}

/* The matrix, run against whatever source `mutate` produces. Returns a result map so the
   negative control can assert the SAME checks come out differently. */
async function matrix(mutate) {
  const r = {};

  /* 1 */
  let h = load({ approved: ['buyer', 'seller'], active: 'seller' }, mutate);
  r.sellerActiveVisible = h.hubVisible() && h.hubHas('Marketplace');
  r.sellerActiveMyStore = h.myStoreVisible();
  r.sellerActiveFinance = h.hubHas('Finance');

  /* 2 - seller -> buyer, no reload */
  h.switchTo('buyer'); await h.settle();
  r.sellerToBuyerHidden = !h.hubVisible();
  r.sellerToBuyerMyStore = h.myStoreVisible();
  r.approvedUnchanged = h.state.approved.join(',') === 'buyer,seller';

  /* 3 - buyer -> rider on a seller+rider account: the SELLER hub must not be presented */
  const h3 = load({ approved: ['buyer', 'seller', 'rider'], active: 'buyer' }, mutate);
  r.buyerActiveHidden = !h3.hubVisible();
  h3.switchTo('rider'); await h3.settle();
  r.riderActiveNoSeller = !h3.hubHas('Marketplace');
  r.riderActiveRider = h3.hubHas('Rider');
  r.riderActiveMyStore = h3.myStoreVisible();

  /* 4 - rider -> seller returns it */
  h3.switchTo('seller'); await h3.settle();
  r.backToSellerVisible = h3.hubVisible() && h3.hubHas('Marketplace');
  r.backToSellerNoRider = !h3.hubHas('Rider');

  /* 7 - a switch originating outside Profile (header bridge) drives the same subscription */
  const h7 = load({ approved: ['buyer', 'seller'], active: 'seller' }, mutate);
  /* Sentinel rather than a call counter: the subscription calls _renderBusinessHub from INSIDE
     the sandbox, where the harness cannot wrap it. Overwriting display proves the renderer
     actually ran, which "it is hidden" alone would not. */
  h7.els.upBizHub.style.display = '__not-rendered__';
  h7.switchTo('buyer'); await h7.settle();
  r.externalSwitchApplied = h7.els.upBizHub.style.display === 'none';
  r.externalSwitchRendersSwitcher = h7.counts.switcher >= 1 && h7.counts.chips >= 1;

  /* 10 - selecting a role the account does not hold presents NOTHING */
  const h10 = load({ approved: ['buyer'], active: 'seller' }, mutate);
  r.unentitledPresentsNothing = !h10.hubVisible();
  r.unentitledMyStoreHidden = !h10.myStoreVisible();

  return r;
}

(async () => {
  head('0 - harness integrity');
  ck('predicate slice is the real source', /function _actingAs\(role, u\)\{/.test(PRED) && PRED.indexOf('_renderBusinessHub') > -1);
  ck('refresh slice carries the guarded binding', /__skProfileActiveRoleBound/.test(REFRESH));
  ck('_renderBusinessHub composes acting role', /_actingAs\('seller', u\)/.test(PRED));
  ck('_isSellerUser is STILL entitlement-only (My Store unchanged)',
     /function _isSellerUser\(u\)\{\s*return _hasRole\('seller', u\); \}/.test(PRED));
  ck('_actingAs requires entitlement AND acting context',
     /return _hasRole\(role, u\) && _activeRoleNow\(\) === role;/.test(PRED));
  ck('exactly one sokoniActiveRoleChanged subscription in profile.html',
     (SRC.match(/addEventListener\('sokoniActiveRoleChanged'/g) || []).length === 1,
     (SRC.match(/addEventListener\('sokoniActiveRoleChanged'/g) || []).length);
  ck('admin is not given an acting context', !/_actingAs\('admin'/.test(PRED));

  /* profile.html is HTML, so `node --check` cannot see it. Compile every classic inline script
     instead — the edits touch three separate places and only two of them are inside the slices. */
  {
    const blocks = [...SRC.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
      .filter((m) => !/\bsrc=/.test(m[1]) && !/type=["']module/.test(m[1]) && !/^\s*$/.test(m[2]));
    let bad = null, n = 0;
    for (const b of blocks) {
      if (/^\s*(import|export)\s/m.test(b[2])) continue;   /* module syntax, not a classic script */
      n++;
      try { new Function(b[2]); } catch (e) { bad = e.message; break; }
    }
    ck('every classic inline script compiles (' + n + ' blocks)', !bad, bad || undefined);
  }

  const m = await matrix(null);

  head('1 - seller acting as seller');
  ck('Business Hub visible with the Marketplace module', m.sellerActiveVisible);
  ck('Finance/Insights present (anyBiz)', m.sellerActiveFinance);
  ck('My Store visible', m.sellerActiveMyStore);

  head('2 - seller -> buyer, without a reload');
  ck('Business Hub hidden', m.sellerToBuyerHidden);
  ck('My Store STILL visible - entitlement did not change', m.sellerToBuyerMyStore);
  ck('approved roles unchanged by the switch', m.approvedUnchanged);

  head('3 - buyer -> rider on a seller+rider account');
  ck('acting as buyer presents no hub', m.buyerActiveHidden);
  ck('acting as rider does NOT present the seller module', m.riderActiveNoSeller);
  ck('acting as rider presents the Rider module', m.riderActiveRider);
  ck('My Store still visible - seller entitlement is untouched', m.riderActiveMyStore);

  head('4 - rider -> seller returns it');
  ck('seller module comes back', m.backToSellerVisible);
  ck('rider module drops out', m.backToSellerNoRider);

  head('7 - a switch made outside Profile updates Profile');
  ck('hub re-rendered and now hidden', m.externalSwitchApplied);
  ck('switcher and chips refreshed too', m.externalSwitchRendersSwitcher);

  head('10 - a switch never GRANTS');
  ck('active=seller with no seller entitlement presents nothing', m.unentitledPresentsNothing);
  ck('...and My Store stays hidden', m.unentitledMyStoreHidden);

  head('5 - the acting role is read, never stored');
  {
    const h = load({ approved: ['buyer', 'seller'], active: 'seller' });
    h.state.active = 'buyer';                 /* authority changes with NO event */
    h.render();
    ck('_activeRoleNow() reflects the authority immediately', h.api._activeRoleNow() === 'buyer');
    ck('no stale cache keeps the hub up', !h.hubVisible());
  }
  {
    /* Before verification the authority does not know the claim set. _hasRole falls back to the
       document; the acting role falls back to the same mirror renderRoleSwitcher() uses. */
    const h = load({ approved: ['buyer', 'seller'], active: 'seller', unverified: true });
    ck('unverified first paint still presents the hub (no blank flash)', h.hubVisible());
  }

  head('8 - duplicate registration cannot double-render');
  {
    const h = load({ approved: ['buyer', 'seller'], active: 'seller' });
    /* Re-evaluate the subscription block against the SAME window, as a re-executed script would */
    new Function('window', 'document', 'renderRoleSwitcher', 'renderRoleChips', '_renderBusinessHub',
                 'getUser', 'setTimeout', 'var _user=null;\n' + REFRESH)(
      h.win, h.doc, function () { h.counts.switcher++; }, function () { h.counts.chips++; },
      function () { h.counts.hub++; }, () => ({ uid: 'u1', roles: ['buyer', 'seller'] }), setTimeout);
    const before = { s: h.counts.switcher, c: h.counts.chips };
    h.switchTo('buyer'); await h.settle();
    ck('one switch -> exactly one switcher render', h.counts.switcher - before.s === 1, h.counts.switcher - before.s);
    ck('one switch -> exactly one chips render', h.counts.chips - before.c === 1, h.counts.chips - before.c);
  }
  {
    /* The Profile switcher calls _refreshRoleDependentUI() itself AND the authority emits the
       event for the same switch. Coalescing is what keeps that a single render chain. */
    const h = load({ approved: ['buyer', 'seller'], active: 'seller' });
    const before = h.counts.switcher;
    h.api._refreshRoleDependentUI();
    h.switchTo('buyer');
    await h.settle();
    ck('switcher-initiated + authority event -> one render', h.counts.switcher - before === 1, h.counts.switcher - before);
  }

  head('9 - NEGATIVE CONTROL: entitlement-only must fail these');
  {
    const neuter = (s) => s.replace(/_actingAs\((\'(?:seller|provider|rider)\'), u\)/g, '_hasRole($1, u)');
    const n = await matrix(neuter);
    ck('control: seller acting as seller still visible (unchanged behaviour)', n.sellerActiveVisible);
    ck('control: seller -> buyer WRONGLY stays visible', n.sellerToBuyerHidden === false);
    ck('control: acting as rider WRONGLY still shows Marketplace', n.riderActiveNoSeller === false);
    ck('control: acting as buyer WRONGLY shows the hub', n.buyerActiveHidden === false);
    ck('control: un-entitled role still presents nothing (never regressed)', n.unentitledPresentsNothing);
    ck('control: My Store behaviour identical (proves the fix did not touch it)',
       n.sellerToBuyerMyStore === m.sellerToBuyerMyStore && n.riderActiveMyStore === m.riderActiveMyStore);
  }

  console.log('\n' + '='.repeat(72));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
