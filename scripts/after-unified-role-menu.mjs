/* PROOF — ONE role menu, inside the profile dropdown, on a real page.
   ==========================================================================
   Run:  node <scratchpad>/serve.js <worktree> 8901
         node <browser-skill>/browser.mjs "http://127.0.0.1:8901/cart.html" \
              --script ./scripts/after-unified-role-menu.mjs

   Runs on /cart — the page measured live as having NO authority at all — and
   INJECTS NOTHING. after-role-menu-convergence stubs the authority on 404.html and
   so proved the logic while being structurally unable to notice that real pages did
   not load it. This asks a real page.

   WHAT IS UNDER TEST
     1  the standalone role-switcher button is gone
     2  the profile dropdown carries the workspace roles
     3  Administration appears ONLY for a claim the authority confirms
     4  a FORGED localStorage role cannot create an Administration entry
     5  the menu scrolls inside itself and stays in the viewport

   ── ON THE FIXTURE ────────────────────────────────────────────────────────
   Only the CLAIM SOURCE is stubbed — window.firebaseAuth.getIdTokenResult — which
   is the boundary SokoniPermissions really reads. The real sokoni-permissions.js and
   sokoni-role-authority.js load and run. Nothing signs in.
*/

const ORIGIN = 'http://127.0.0.1:8901';

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ label, ok, detail: detail || '' });

  await page.addInitScript(() => {
    const q = new URLSearchParams(location.search);
    const claims = {};
    (q.get('claims') || '').split(',').filter(Boolean).forEach((c) => { claims[c] = true; });
    const lsRoles = (q.get('lsroles') || 'buyer,rider,seller').split(',').filter(Boolean);

    localStorage.setItem('loggedIn', 'true');
    localStorage.setItem('sokoniUser', JSON.stringify({
      uid: 'fx', name: 'Fixture', email: 'fx@example.test',
      roles: lsRoles, activeRole: 'buyer',
    }));
    /* the boundary SokoniPermissions actually reads */
    window.firebaseAuth = { currentUser: { uid: 'fx',
      getIdTokenResult: function () { return Promise.resolve({ claims: claims }); } } };
    window.firebaseDB = null;
  });

  async function open(qs) {
    await page.goto(ORIGIN + '/cart.html?' + qs, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#sk-nav-avatar', { timeout: 15000 }).catch(() => {});
    /* let the self-bootstrapped modules load */
    await page.waitForTimeout(2500);

    /* window.firebaseAuth is set BY firebase.js, which cart.html loads — so it
       overwrites the claim stub installed at document-start, and SokoniPermissions
       verifies against the real signed-out auth instead. Re-install it, then ask the
       authority to re-read the token: reverify() exists precisely because init()
       caches an unverified result, and it only ever upgrades. */
    await page.addScriptTag({ content: `
      (function () {
        var q = new URLSearchParams(location.search);
        var claims = {};
        (q.get('claims') || '').split(',').filter(Boolean).forEach(function (c) { claims[c] = true; });
        window.firebaseAuth = { currentUser: { uid: 'fx',
          getIdTokenResult: function () { return Promise.resolve({ claims: claims }); } } };
        window.__reverified = window.SokoniPermissions && window.SokoniPermissions.reverify
          ? window.SokoniPermissions.reverify() : Promise.resolve(false);
      }());` });
    await page.waitForTimeout(900);

    await page.addScriptTag({ content:
      'var a=document.getElementById("sk-nav-avatar"); if(a) a.click();' });
    await page.waitForTimeout(600);
    await page.addScriptTag({ content: `
      (function () {
        var p = document.getElementById('sk-acct-popup');
        var out = { open: !!p, standalone: !!document.getElementById('sk-role-switcher'),
                    workspace: [], admin: [], marked: null };
        if (p) {
          var cs = getComputedStyle(p);
          out.overflowY = cs.overflowY; out.maxHeight = cs.maxHeight;
          out.scrollH = p.scrollHeight; out.clientH = p.clientHeight;
          var b = p.getBoundingClientRect();
          out.left = Math.round(b.left); out.right = Math.round(b.right);
          out.vw = window.innerWidth;
          Array.prototype.forEach.call(p.querySelectorAll('.sk-acct-role-pill'), function (el) {
            var t = (el.textContent || '').trim();
            if (el.classList.contains('sk-acct-admin-pill')) out.admin.push(t);
            else { out.workspace.push(t); if (el.classList.contains('active')) out.marked = t; }
          });
        }
        document.documentElement.setAttribute('data-p', JSON.stringify(out));
      }());` });
    return JSON.parse(await page.getAttribute('html', 'data-p'));
  }

  /* ── 1. no standalone switcher; the profile menu carries the roles ──
     Workspace roles come from CLAIMS, so the claims must grant them. The first
     version of this row seeded only localStorage and expected three pills — which
     asserted that the MIRROR should win, the exact behaviour this slice removes.
     Once the authority verifies, an account with no workspace claim is approved for
     buyer alone and there is correctly nothing to switch to. */
  let p = await open('claims=rider,seller&lsroles=buyer,rider,seller');
  ck('RIG  the profile dropdown opens on /cart', p.open === true, '');
  ck('U1   the standalone role-switcher button is GONE',
    p.standalone === false, 'sk-role-switcher present=' + p.standalone);
  ck('U2   claim-granted workspace roles appear in the profile menu',
    p.workspace.length >= 2, JSON.stringify(p.workspace));
  ck('U2b  CONTROL the acting role is marked',
    !!p.marked, 'marked=' + p.marked);

  /* ── 2. Administration only for a confirmed claim ── */
  ck('U3   CONTROL workspace claims alone -> no Administration entry',
    p.admin.length === 0, JSON.stringify(p.admin));

  p = await open('claims=admin&lsroles=buyer,rider,seller');
  ck('U4   admin claim -> Admin appears',
    p.admin.some((x) => /^🛡️?\s*Admin$/.test(x) || /Admin/.test(x)), JSON.stringify(p.admin));
  ck('U5   admin claim alone -> Super Admin absent',
    !p.admin.some((x) => /Super Admin/.test(x)), JSON.stringify(p.admin));

  p = await open('claims=admin,superAdmin&lsroles=buyer,rider,seller');
  ck('U6   both claims -> both entries appear',
    p.admin.length === 2, JSON.stringify(p.admin));

  /* ── 3. THE NEGATIVE CONTROL: a forged localStorage role grants nothing ── */
  p = await open('claims=&lsroles=buyer,seller,admin,superAdmin');
  ck('U7   CONTROL forged localStorage roles create NO Administration entry',
    p.admin.length === 0,
    'ls roles included admin+superAdmin, claims empty -> ' + JSON.stringify(p.admin));

  /* ── 4. scrolling and viewport, on an oversized list ── */
  p = await open('claims=admin,superAdmin&lsroles=buyer,rider,seller,provider,mechanic,health,legal,landlord,tenant');
  ck('U8   the menu scrolls inside itself',
    p.overflowY === 'auto' || p.overflowY === 'scroll', 'overflow-y=' + p.overflowY);
  ck('U9   the menu is height-capped', p.maxHeight !== 'none', 'max-height=' + p.maxHeight);

  const vps = [];
  for (const vp of [{ width: 390, height: 844 }, { width: 820, height: 1180 },
                    { width: 1440, height: 900 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => {
      const p2 = document.getElementById('sk-acct-popup');
      if (!p2) return null;
      const b = p2.getBoundingClientRect();
      return { ok: b.right <= window.innerWidth + 1 && b.left >= -1 && b.height <= window.innerHeight,
               left: Math.round(b.left), right: Math.round(b.right), vw: window.innerWidth };
    });
    vps.push({ vp: vp.width + 'x' + vp.height, r });
  }
  ck('U10  the menu stays inside the viewport at 390/820/1440 and landscape',
    vps.every((v) => v.r && v.r.ok),
    vps.map((v) => v.vp + ':' + (v.r && v.r.ok ? 'ok' : 'left=' + (v.r && v.r.left))).join('  '));

  const passed = rows.filter((r) => r.ok).length;
  return { passed, failed: rows.length - passed, rows };
}
