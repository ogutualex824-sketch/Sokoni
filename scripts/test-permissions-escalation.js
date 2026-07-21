/* Privilege-escalation regression tests for sokoni-permissions.js.
 *
 * The module resolves roles from three places: a sessionStorage cache, a
 * localStorage sync pass, and the Firebase ID token. Only the last is
 * authoritative; the other two are attacker-writable. These tests assert that
 * forged storage cannot produce an elevated answer, and — just as important —
 * that a genuine admin is still granted once a signed token is read.
 *
 * Browser globals are stubbed, so this runs with no credentials and never
 * touches production. Run: node scripts/test-permissions-escalation.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.resolve('sokoni-permissions.js'), 'utf8');

/* Build a fresh module instance with controllable storage + auth. */
function load({ session = null, local = null, claims = null, authReady = true } = {}) {
  const store = { session: {}, local: {} };
  if (session) store.session['sokoniPermCache'] = JSON.stringify(session);
  if (local)   store.local['sokoniUser']        = JSON.stringify(local);

  const mk = (bag) => ({
    getItem: (k) => (k in bag ? bag[k] : null),
    setItem: (k, v) => { bag[k] = String(v); },
    removeItem: (k) => { delete bag[k]; },
  });

  const win = {
    localStorage:   mk(store.local),
    sessionStorage: mk(store.session),
    document: {
      querySelectorAll: () => [],
      getElementById:   () => null,
      createElement:    () => ({ setAttribute() {}, appendChild() {}, style: {}, set textContent(_) {} }),
      head: { appendChild() {} },
      body: { appendChild() {} },
      addEventListener() {},
      dispatchEvent() {},
      readyState: 'complete',
    },
    addEventListener() {},
    dispatchEvent() {},
    CustomEvent: function(n,o){ this.type=n; this.detail=o&&o.detail; },
    console,
  };
  win.window = win;
  win.firebaseAuth = authReady
    ? { currentUser: claims ? { getIdTokenResult: async () => ({ claims }) } : null }
    : null;

  const ctx = vm.createContext(win);
  vm.runInContext(SRC, ctx);
  return { P: win.SokoniPermissions || win.SokoniAccessControl, win };
}

let pass = 0, fail = 0;
const t = (n, v) => {
  if (v && typeof v.then === 'function') { fail++; console.log('  FAIL  ' + n + ' (async assertion)'); return; }
  v ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n));
};

(async () => {
  const FORGED_CACHE = { roles: ['user', 'superAdmin'], level: 100, claimsVerified: true, ts: Date.now() };
  const FORGED_LOCAL = { roles: ['superAdmin'], role: 'admin', registeredAs: { admin: true } };

  console.log('\n=== forged sessionStorage cache must NOT elevate ===');
  {
    const { P } = load({ session: FORGED_CACHE });
    if (!P) { console.log('  module did not expose an API'); fail++; }
    else {
      await P.init();
      t('hasRole("superAdmin") denied', P.hasRole('superAdmin') === false);
      t('hasRole("admin") denied',      P.hasRole('admin') === false);
      t('can(elevated) denied',         P.can('manageUsers') === false || P.can('moderateContent') === false);
    }
  }

  console.log('\n=== forged localStorage roles must NOT elevate ===');
  {
    const { P } = load({ local: FORGED_LOCAL });
    await P.init();
    t('hasRole("superAdmin") denied', P.hasRole('superAdmin') === false);
    t('hasRole("admin") denied',      P.hasRole('admin') === false);
  }

  console.log('\n=== both forged at once must NOT elevate ===');
  {
    const { P } = load({ session: FORGED_CACHE, local: FORGED_LOCAL });
    await P.init();
    t('still denied', P.hasRole('superAdmin') === false && P.hasRole('admin') === false);
  }

  console.log('\n=== a REAL admin claim must be granted (no false negative) ===');
  {
    const { P } = load({ claims: { admin: true } });
    await P.init();
    t('hasRole("admin") granted', P.hasRole('admin') === true);
  }
  {
    const { P } = load({ claims: { superAdmin: true } });
    await P.init();
    t('hasRole("superAdmin") granted', P.hasRole('superAdmin') === true);
  }

  console.log('\n=== a real admin is granted even with a stale cache present ===');
  {
    const { P } = load({ session: FORGED_CACHE, claims: { admin: true } });
    await P.init();
    t('cache no longer short-circuits verification', P.hasRole('admin') === true);
  }

  console.log('\n=== baseline roles still resolve (no first-paint regression) ===');
  {
    const { P } = load({ local: { roles: ['seller'] } });
    await P.init();
    t('seller still resolves from cache', P.hasRole('seller') === true);
    t('but seller is not elevated',       P.hasRole('admin') === false);
  }

  console.log('\n=== no claims at all → nothing elevated ===');
  {
    const { P } = load({});
    await P.init();
    t('anonymous denied admin', P.hasRole('admin') === false);
    t('anonymous denied superAdmin', P.hasRole('superAdmin') === false);
  }

  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' PASSED'));
  process.exitCode = fail ? 1 : 0;
})();
