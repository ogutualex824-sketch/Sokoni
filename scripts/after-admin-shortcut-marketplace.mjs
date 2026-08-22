/* PROOF — the admin shortcut, and the way back to the marketplace.
   ==========================================================================
   Run:  node <scratchpad>/serve.js <worktree> 8901
         node <browser-skill>/browser.mjs "http://127.0.0.1:8901/offline.html" \
              --script ./scripts/after-admin-shortcut-marketplace.mjs

   Point at a pre-change tree with SK_ORIGIN for the BEFORE half.

   ── WHAT WAS WRONG ────────────────────────────────────────────────────────
   1  The 7-tap shortcut on the logo opened a PIN / pattern / password overlay whose
      hashes lived in localStorage. NOTHING IN THE REPOSITORY EVER WROTE THOSE KEYS,
      so it dead-ended for every account on every device with "Admin credentials not
      configured. Set them via the SOKONI admin setup" — a setup that does not exist.
      It was the last surviving instance of the client-side secret removed from
      admin.html in 7976119.

   2  Administrative surfaces had no explicit way back to the marketplace.

   ── THE RULE UNDER TEST ───────────────────────────────────────────────────
      admin claim       -> Admin
      superAdmin claim  -> Super Admin, reachable SEPARATELY
      the shortcut      -> admin.html for BOTH, never super-admin.html
      Marketplace       -> navigation only; it must NOT change the account's
                           authority or drop the administrative context.

   Rendering and client-side state only. Rules and the admin callables are the
   boundary and are untouched.
==========================================================================*/

import {
  installFixture, stubFirebaseModule, setScenario, primeOrigin, ORIGIN,
} from './lib/admin-fixture.mjs';

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ label, ok, detail: detail || '' });

  await stubFirebaseModule(page);
  await installFixture(page);

  /* window._showAdminLock lives in the main world; page.evaluate does not. Same DOM
     handshake the accessor proof uses — the isolated world raises a flag, the main
     world acts and reports. Calling it directly from evaluate would silently find
     `undefined` and pass a row while doing nothing. */
  await page.addInitScript(() => {
    const iv = setInterval(() => {
      if (!document.documentElement.hasAttribute('data-fx-tap')) return;
      if (typeof window._showAdminLock !== 'function') return;
      clearInterval(iv);
      /* sessionStorage, not a DOM attribute: on the paths that WORK the handler
         navigates, the document is replaced, and an attribute would be gone before it
         could be read. The control then failed on every passing case and passed only
         on the inert one — an inverted control is worse than none. */
      try { sessionStorage.setItem('__fxTapped', '1'); } catch (_) {}
      document.documentElement.setAttribute('data-fx-tapped', '1');
      try { window._showAdminLock(); } catch (e) {
        document.documentElement.setAttribute('data-fx-taperr', String(e && e.message || e));
      }
    }, 60);
  });

  await primeOrigin(page);

  async function tapAndSee(scenario) {
    await setScenario(page, scenario);
    await page.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    /* NOT typeof window._showAdminLock — page.evaluate is an isolated world and would
       report undefined for a function that is perfectly well defined in the page. The
       main-world hook publishes data-fx-tapped instead, which is observable from here. */
    const pre = await page.evaluate(() => ({
      overlay: !!document.getElementById('idxAdminLock'),
    }));
    await page.evaluate(() => {
      try { sessionStorage.removeItem('__fxTapped'); } catch (_) {}
      document.documentElement.setAttribute('data-fx-tap', '1');
    });
    await page.waitForTimeout(4000);
    const tapped = await page.evaluate(() => {
      try { return sessionStorage.getItem('__fxTapped') === '1'; } catch (_) { return false; }
    }).catch(() => false);
    const landed = page.url().split('?')[0].split('#')[0].split('/').pop().replace(/\.html$/, '');
    return { ...pre, landed, tapped };
  }

  /* ══ 1. The dead credential overlay is gone ══════════════════════════════ */
  const asAdmin = await tapAndSee({ claims: ['admin'], ctx: '', lsroles: ['buyer'] });
  ck('RIG  CONTROL the shortcut handler actually ran',
    asAdmin.tapped === true, 'invoked=' + asAdmin.tapped);
  ck('K1   no credential overlay is rendered on the home page',
    asAdmin.overlay === false, '#idxAdminLock present=' + asAdmin.overlay);

  /* ══ 2. THE P0: an Admin lands on Admin, never on Super Admin ════════════ */
  ck('K2   admin claim -> admin.html',
    asAdmin.landed === 'admin', 'landed=' + asAdmin.landed);

  const asSuper = await tapAndSee({ claims: ['superAdmin'], ctx: '', lsroles: ['buyer'] });
  ck('K3   superAdmin claim -> ALSO admin.html, not super-admin',
    asSuper.landed === 'admin', 'landed=' + asSuper.landed);

  /* ══ 3. CONTROLS ════════════════════════════════════════════════════════
     No claim: the shortcut must go nowhere AND reveal nothing. A forged
     localStorage mirror is the same test with the mirror shouting. */
  const asNobody = await tapAndSee({ claims: [], ctx: '', lsroles: ['buyer'] });
  ck('K4   CONTROL no claim -> the shortcut navigates nowhere',
    asNobody.landed === 'index' && asNobody.tapped === true,
    'landed=' + asNobody.landed + ' invoked=' + asNobody.tapped);

  const asForged = await tapAndSee({ claims: [],
    ctx: '', lsroles: ['buyer', 'admin', 'superAdmin'] });
  ck('K5   CONTROL forged localStorage roles -> still nowhere',
    asForged.landed === 'index',
    'ls roles included admin+superAdmin, claims empty -> landed=' + asForged.landed);

  /* ══ 4. Marketplace action on the administrative surfaces ════════════════ */
  /* ctx must match the surface: super-admin.html guards on requireAdminContext
     ('superAdmin'), so seeding 'admin' produced a wrong-context denial and the profile
     menu never mounted — which the harness then read as "no Marketplace entry". */
  await setScenario(page, { claims: ['admin', 'superAdmin'], ctx: 'superAdmin',
    lsroles: ['buyer', 'seller'] });
  await page.goto(ORIGIN + '/super-admin.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await page.evaluate(() => {
    const b = document.getElementById('sk-admin-profile');
    if (b) b.click();
  });
  await page.waitForTimeout(500);
  const menu = await page.evaluate(() => {
    const m = document.getElementById('sk-admin-profile-menu');
    if (!m) return { present: false };
    const mk = m.querySelector('[data-sk-marketplace]');
    return {
      present: true,
      marketplace: !!mk,
      href: mk ? mk.getAttribute('href') : null,
      text: mk ? (mk.textContent || '').trim() : null,
      ctxBefore: (() => { try { return sessionStorage.getItem('sokoniAdminContext'); }
                          catch (_) { return 'ERR'; } })(),
    };
  });
  ck('RIG  CONTROL the super-admin profile menu opened',
    menu.present === true, 'menu present=' + menu.present);
  ck('K6   the menu offers SOKONI Marketplace, pointing at /',
    menu.marketplace === true && menu.href === '/',
    'present=' + menu.marketplace + ' href=' + menu.href + ' text=' + JSON.stringify(menu.text));

  /* ══ 5. Marketplace is NAVIGATION, not a change of authority ═════════════
     The administrative context must survive the trip. If it did not, returning to
     the admin surface would demand a fresh deliberate entry, and the operator would
     reasonably read "went to the shop" as "lost my admin rights". */
  await page.evaluate(() => {
    const mk = document.querySelector('#sk-admin-profile-menu [data-sk-marketplace]');
    if (mk) mk.click();
  });
  await page.waitForTimeout(4000);
  const after = await page.evaluate(() => ({
    landed: location.pathname.split('/').pop(),
    ctx: (() => { try { return sessionStorage.getItem('sokoniAdminContext'); }
                  catch (_) { return 'ERR'; } })(),
  }));
  ck('K7   Marketplace navigates to the marketplace',
    after.landed === '' || after.landed === 'index.html' || after.landed === 'index',
    'landed=' + JSON.stringify(after.landed));
  ck('K8   Marketplace does NOT drop the administrative context',
    after.ctx === menu.ctxBefore && after.ctx != null,
    'before=' + JSON.stringify(menu.ctxBefore) + ' after=' + JSON.stringify(after.ctx));

  const passed = rows.filter((r) => r.ok).length;
  return { passed, failed: rows.length - passed, rows };
}
