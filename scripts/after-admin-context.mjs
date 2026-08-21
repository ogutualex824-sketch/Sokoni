/* AFTER-PROOF — F4: the administrative context decision table.

   Run:
     node <scratchpad>/serve.js <worktree> 8901
     node <browser-skill>/browser.mjs "http://127.0.0.1:8901/404.html" \
          --script ./scripts/after-admin-context.mjs

   WHAT THIS PROVES
   The claim answers "may this account". The administrative context answers "is it
   doing so now". Before F4 all three admin surfaces read only the first, so an
   administrator who switched to a workspace role kept full admin access. These rows
   pin the table:

     claim      context            require('admin')   require('superAdmin')
     admin      none               DENY               DENY
     admin      entered            ALLOW              DENY
     admin      entered, switched  DENY               DENY      <- the invariant
     superAdmin entered            ALLOW              ALLOW
     buyer      forged mirror      DENY               DENY      <- mirror grants nothing

   ── ON THE FIXTURE ────────────────────────────────────────────────────────
   window.firebaseAuth is stubbed so getIdTokenResult returns chosen claims. That is
   the same boundary the F0-F3 fixture used: the thing under test is "given claims C
   and context X, does the gate admit", which is exactly the gate's contract. Nothing
   signs in, and no row licenses a statement about a real account. window.firebaseDB
   is deliberately left undefined so the Firestore role source is skipped and the
   claims under test are the only input.

   This is a CLIENT gate. It decides what to RENDER. Firestore rules and the admin
   callables remain the boundary that protects data, and are unchanged by F4.

   CONTROLS
   * R2 must ALLOW. Without a real admission, a gate that denied everything would
     score every DENY row as a pass and the run would prove nothing.
   * R7 forges the sessionStorage mirror on a NON-admin and must still be denied,
     which is what separates "a context selector" from "an authorization token".
*/

const BASE = 'http://127.0.0.1:8901/404.html';

export default async function run(page) {
  await page.addInitScript(() => {
    const q = new URLSearchParams(location.search);
    const claims = {};
    (q.get('claims') || '').split(',').filter(Boolean).forEach((c) => { claims[c] = true; });
    localStorage.setItem('loggedIn', 'true');
    localStorage.setItem('sokoniUser', JSON.stringify({
      uid: 'fx-admin', name: 'Fixture', roles: ['buyer'], activeRole: 'buyer',
    }));
    window.firebaseAuth = {
      currentUser: {
        uid: 'fx-admin',
        getIdTokenResult: function () { return Promise.resolve({ claims: claims }); },
      },
    };
    /* left undefined on purpose: skips the Firestore role source */
    window.firebaseDB = null;
  });

  const rows = [];
  const ck = (label, ok, detail) => rows.push({ label, ok, detail: detail || '' });

  /* Loads the two modules under test into a page that does not already carry them,
     then waits for the authority to finish verifying rather than for a timer. */
  async function boot(claims) {
    await page.goto(BASE + '?claims=' + encodeURIComponent(claims),
      { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ url: '/sokoni-permissions.js' });
    await page.addScriptTag({ url: '/sokoni-admin-entry.js' });
    /* page.evaluate and page.waitForFunction run in the ISOLATED world, which cannot
       see window.SokoniPermissions. Everything that must touch a main-world global
       goes through addScriptTag, and the answer comes back over the DOM, which both
       worlds share. Poll for the authority actually verifying rather than sleeping:
       a slow verification and an absent one are indistinguishable from a timer. */
    await page.addScriptTag({ content: `
      (function () {
        var n = 0;
        var P = window.SokoniPermissions;
        if (P && P.init) P.init();
        (function tick() {
          var p = window.SokoniPermissions;
          if (p && p.isVerified && p.isVerified() === true) {
            document.documentElement.setAttribute('data-boot',
              JSON.stringify({ verified: true, roles: p.getRoles() }));
            return;
          }
          if (++n > 200) {
            document.documentElement.setAttribute('data-boot',
              JSON.stringify({ verified: false, roles: p && p.getRoles ? p.getRoles() : [] }));
            return;
          }
          setTimeout(tick, 50);
        }());
      }());` });
    await page.waitForSelector('html[data-boot]', { timeout: 20000 }).catch(() => {});
    const raw = await page.getAttribute('html', 'data-boot');
    return raw ? JSON.parse(raw) : { verified: false, roles: [] };
  }

  /* Runs a script in the MAIN world and returns whatever it stamps on <html>. */
  async function probe(js) {
    await page.addScriptTag({ content:
      'document.documentElement.setAttribute("data-r", JSON.stringify((function(){'
      + js + '})()));' });
    return JSON.parse(await page.getAttribute('html', 'data-r'));
  }

  /* ── admin claim ── */
  const bootAdmin = await boot('admin');
  ck('RIG  the fixture verified an ADMIN claim',
    bootAdmin.verified === true && bootAdmin.roles.indexOf('admin') >= 0,
    'verified=' + bootAdmin.verified + ' roles=' + JSON.stringify(bootAdmin.roles));

  let r = await probe(`
    var P = window.SokoniPermissions;
    return { ctx: P.getAdminContext(), admin: P.requireAdminContext('admin'),
             sa: P.requireAdminContext('superAdmin') };`);
  ck('R1   admin claim, NO context -> /admin.html DENIED',
    r.admin.ok === false && r.admin.reason === 'context-not-entered',
    'reason=' + r.admin.reason);
  ck('R1b  the denial is offerable (canEnter), not a dead end',
    r.admin.canEnter === true, '');

  r = await probe(`
    var P = window.SokoniPermissions;
    var e = P.enterAdminContext('admin');
    return { enter: e, ctx: P.getAdminContext(),
             admin: P.requireAdminContext('admin'),
             sa: P.requireAdminContext('superAdmin') };`);
  ck('R2   CONTROL admin claim + entered context -> /admin.html ALLOWED',
    r.enter.ok === true && r.admin.ok === true, 'ctx=' + r.ctx);
  ck('R3   admin claim + entered -> /super-admin.html DENIED',
    r.sa.ok === false && r.sa.reason === 'no-claim', 'reason=' + r.sa.reason);

  /* THE INVARIANT: selecting a workspace role leaves the administrative surface. */
  r = await probe(`
    var P = window.SokoniPermissions;
    document.dispatchEvent(new CustomEvent('sokoniActiveRoleChanged',{detail:{role:'buyer'}}));
    return { ctx: P.getAdminContext(), admin: P.requireAdminContext('admin') };`);
  ck('R4   INVARIANT switching to a workspace role clears the context',
    r.ctx === null, 'ctx=' + r.ctx);
  ck('R5   after switching to buyer -> /admin.html DENIED',
    r.admin.ok === false, 'reason=' + r.admin.reason);

  /* The mirror must not survive a claim it no longer matches. */
  r = await probe(`
    var P = window.SokoniPermissions;
    sessionStorage.setItem('sokoniAdminContext','superAdmin');
    return { ctx: P.getAdminContext(), sa: P.requireAdminContext('superAdmin') };`);
  ck('R6   forged mirror claiming superAdmin on an ADMIN account -> refused',
    r.ctx === null && r.sa.ok === false, 'ctx=' + r.ctx + ' reason=' + r.sa.reason);

  /* ── no admin claim at all ── */
  const bootBuyer = await boot('');
  ck('RIG  the fixture verified a NON-admin account',
    bootBuyer.verified === true && bootBuyer.roles.indexOf('admin') < 0,
    'roles=' + JSON.stringify(bootBuyer.roles));

  r = await probe(`
    var P = window.SokoniPermissions;
    sessionStorage.setItem('sokoniAdminContext','admin');
    return { ctx: P.getAdminContext(), enter: P.enterAdminContext('admin'),
             admin: P.requireAdminContext('admin') };`);
  ck('R7   CONTROL forged mirror on a NON-admin grants nothing',
    r.ctx === null && r.admin.ok === false && r.admin.reason === 'no-claim',
    'ctx=' + r.ctx + ' reason=' + r.admin.reason);
  ck('R8   a non-admin cannot enter the context',
    r.enter.ok === false && r.enter.reason === 'no-claim', 'reason=' + r.enter.reason);

  /* ── superAdmin ── */
  const bootSA = await boot('superAdmin');
  ck('RIG  the fixture verified a SUPER ADMIN claim',
    bootSA.roles.indexOf('superAdmin') >= 0, 'roles=' + JSON.stringify(bootSA.roles));

  r = await probe(`
    var P = window.SokoniPermissions;
    var e = P.enterAdminContext('admin');    /* no 'admin' claim, only superAdmin */
    return { enter: e, ctx: P.getAdminContext(),
             admin: P.requireAdminContext('admin'),
             sa: P.requireAdminContext('superAdmin') };`);
  ck('R9   superAdmin entering the Admin surface resolves to superAdmin context',
    r.enter.ok === true && r.ctx === 'superAdmin', 'ctx=' + r.ctx);
  ck('R10  superAdmin -> /admin.html ALLOWED (higher surface reaches the lower)',
    r.admin.ok === true, 'reason=' + r.admin.reason);
  ck('R11  superAdmin -> /super-admin.html ALLOWED', r.sa.ok === true,
    'reason=' + r.sa.reason);

  const passed = rows.filter((x) => x.ok).length;
  return { passed, failed: rows.length - passed, rows };
}
