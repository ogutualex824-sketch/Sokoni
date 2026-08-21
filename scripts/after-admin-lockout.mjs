/* PROOF — the poisoned-init administrator lockout.
   ==========================================================================
   Run:
     node <scratchpad>/serve.js <worktree> 8901
     node <browser-skill>/browser.mjs "http://127.0.0.1:8901/404.html" \
          --script ./scripts/after-admin-lockout.mjs

   THE DEFECT, shipped live in Release 3A (224915d) and caused by F4 (e7dd99e):

     sokoni-permissions.js  _run() calls init() at DOMContentLoaded
     init()                 caches _initPromise on the FIRST call
     _rolesFromFirebase()   `if (!auth.currentUser) return null`

   Firebase resolves currentUser asynchronously, AFTER DOMContentLoaded. So init()
   almost always ran with no user, returned null, and left _claimsVerified and
   _verifiedThisLoad false — with that outcome cached for the rest of the page load.

   Nothing depended on it until F4 gave requireAdminContext() a real isVerified()
   check. Then it became a hard lockout: EVERY administrator, on EVERY administrative
   surface, saw

       "Could not verify your access — Your roles could not be confirmed"

   regardless of their claims. The guard was right to fail closed. The state it
   consulted was simply never allowed to become true.

   WHAT THIS ASSERTS
   The real ordering, not a convenient one: permissions initialises with NO auth,
   and a user appears only afterwards. The authority must then re-read the token
   rather than stay poisoned.

   CONTROLS
   * The poisoning must actually occur, or the rest of the run proves nothing —
     if init() somehow verified without a user, there was no lockout to fix.
   * A signed-OUT visitor must still be refused, so the fix cannot be mistaken for
     "verify anyone who asks".
   ==========================================================================*/

const BASE = 'http://127.0.0.1:8901/404.html';

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ label, ok, detail: detail || '' });

  async function boot(withUserAfter) {
    await page.addInitScript(() => {
      localStorage.setItem('loggedIn', 'true');
      localStorage.setItem('sokoniUser', JSON.stringify({ uid: 'fx', roles: ['buyer'] }));
      /* auth deliberately ABSENT at load — this is the poisoning */
      window.firebaseAuth = null;
      window.firebaseDB = null;
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ url: '/sokoni-permissions.js' });
    await page.addScriptTag({ url: '/sokoni-admin-entry.js' });
    await page.addScriptTag({ content: 'SokoniPermissions.init();' });
    await page.waitForTimeout(700);
  }

  /* ── the poisoning itself ── */
  await boot();
  await page.addScriptTag({ content:
    'document.documentElement.setAttribute("data-a", JSON.stringify({'
    + 'verified: SokoniPermissions.isVerified() }));' });
  const a = JSON.parse(await page.getAttribute('html', 'data-a'));
  ck('CONTROL  init() with no currentUser leaves the authority UNVERIFIED',
    a.verified === false,
    a.verified === false ? 'the lockout condition is real' : 'no lockout to fix — rows below are void');

  /* ── auth resolves afterwards, as it really does ── */
  await page.addScriptTag({ content: `
    window.firebaseAuth = { currentUser: { uid: 'fx',
      getIdTokenResult: function () { return Promise.resolve({ claims: { admin: true } }); } } };
    SokoniAdminEntry.guard('admin').then(function (r) {
      document.documentElement.setAttribute('data-g', JSON.stringify({
        ok: r.ok, reason: r.reason || null,
        verified: SokoniPermissions.isVerified(),
        roles: SokoniPermissions.getRoles() }));
    });` });
  await page.waitForSelector('html[data-g]', { timeout: 20000 }).catch(() => {});
  const g = JSON.parse((await page.getAttribute('html', 'data-g')) || '{}');

  ck('L1  the authority re-verifies once a real user appears',
    g.verified === true, 'verified=' + g.verified + ' roles=' + JSON.stringify(g.roles));
  ck('L2  the admin claim is now SEEN',
    Array.isArray(g.roles) && g.roles.indexOf('admin') >= 0, JSON.stringify(g.roles));
  ck('L3  no longer refused as authority-unavailable',
    g.reason !== 'authority-unavailable', 'reason=' + g.reason);
  ck('L4  the denial is context-not-entered — a real decision, not a lockout',
    g.reason === 'context-not-entered' || g.ok === true, 'reason=' + g.reason);

  /* ── the fix must not admit a signed-out visitor ── */
  await page.addInitScript(() => {
    try { localStorage.removeItem('loggedIn'); } catch (e) {}
    window.firebaseAuth = null;
    window.firebaseDB = null;
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: '/sokoni-permissions.js' });
  await page.addScriptTag({ url: '/sokoni-admin-entry.js' });
  await page.addScriptTag({ content: `
    SokoniAdminEntry.guard('admin').then(function (r) {
      document.documentElement.setAttribute('data-s', JSON.stringify({
        ok: r.ok, reason: r.reason || null,
        title: (document.querySelector('#sk-admin-deny h1') || {}).textContent || null }));
    });` });
  await page.waitForSelector('html[data-s]', { timeout: 20000 }).catch(() => {});
  const s = JSON.parse((await page.getAttribute('html', 'data-s')) || '{}');
  ck('CONTROL  a signed-OUT visitor is still refused',
    s.ok === false, 'reason=' + s.reason);
  ck('L5  a signed-out visitor is told to SIGN IN, not to check their connection',
    s.reason === 'signed-out' && /Sign in/i.test(s.title || ''),
    'reason=' + s.reason + ' title=' + s.title);

  const passed = rows.filter((r) => r.ok).length;
  return { passed, failed: rows.length - passed, rows };
}
