/* BEFORE-PROOF — F4: Admin / Super Admin surface gate and controls.

   Run:
     node <scratchpad>/serve.js <worktree> 8901
     node <browser-skill>/browser.mjs "http://127.0.0.1:8901/404.html" \
          --script ./scripts/before-admin-surface-gate.mjs

   WHY THIS NEEDS NO CREDENTIALS
   Every row below is what an UNAUTHENTICATED browser can do. Nothing here signs
   in, forges a token, or mints a claim. sessionStorage is written the way any
   visitor can write it from their own devtools — that is the point of G1/G2:
   a gate that a visitor can satisfy by typing one line is not a gate.

   THE INVARIANT UNDER TEST
     activeRole != authorized role  ->  denied, activeRole unchanged, user stays put

   admin.html verifies the Firebase admin claim once (line ~2332) and then records
   sessionStorage 'sokoniAdminUnlocked'. On the NEXT load a top-level block
   (line ~2598) reads that key and reveals #adminDash — and line ~6368 calls
   loadAll() — WITHOUT re-verifying the claim. G1/G2 measure that.

   WHAT A FAILING G1 DOES AND DOES NOT MEAN
   Revealing the dashboard shell is not the same as reading data: Firestore rules
   and the adminOsDispatch callables still gate every value. So G2 records what was
   actually REQUESTED and what actually RENDERED rather than inferring a breach
   from a visible container. An empty table is not proof of a successful denial —
   it may simply be a page that asked for nothing yet.

   CONTROLS
   * C1 must PASS today: a clean session shows the lock and hides the dashboard.
     Without it, a page that failed to render anything would score as "denied" on
     every row and the run would prove nothing.
   * G4 must PASS today: admin-os.html redirects an unauthenticated visitor, which
     shows the rig can observe a gate that DOES work.
*/

const ORIGIN = 'http://127.0.0.1:8901';

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ label, ok, detail: detail || '' });

  /* Telemetry and metric beacons fire on EVERY page and say nothing about admin
     data. Counting them made G2 fail on a page that had requested nothing
     administrative — the instrument, not the product. */
  const NOISE = /_sokoniTelemetry|recordMetric|generate_204|\/api\/diag/;
  const net = [];
  page.on('request', (r) => {
    const u = r.url();
    if (NOISE.test(u)) return;
    if (/firestore\.googleapis|cloudfunctions\.net|\/api\//.test(u)) net.push(u.slice(0, 120));
  });

  /* Never judge a page without asserting where it actually landed: a gate that
     redirects and a page that failed to render look identical from the DOM. */
  const landed = () => page.evaluate(() => location.pathname + location.search);

  /* ── C1 CONTROL: clean session must show the lock ── */
  await page.goto(ORIGIN + '/admin.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const clean = await page.evaluate(() => {
    const vis = (id) => {
      const el = document.getElementById(id);
      if (!el) return 'absent';
      return getComputedStyle(el).display === 'none' ? 'hidden' : 'visible';
    };
    return { lock: vis('adminLock'), dash: vis('adminDash') };
  });
  const cleanAt = await landed();
  const cleanRedirected = cleanAt.indexOf('admin.html') < 0;
  ck('RIG  where a clean anonymous load of /admin.html actually lands',
    true, 'landed=' + cleanAt + '  lock=' + clean.lock + ' dash=' + clean.dash);
  ck('C1   CONTROL anonymous visitor does NOT get the admin dashboard',
    cleanRedirected || (clean.lock === 'visible' && clean.dash === 'hidden'),
    cleanRedirected ? 'redirected to ' + cleanAt
      : 'lock=' + clean.lock + ' dash=' + clean.dash);

  /* ── G1/G2: the forged unlock. One line any visitor can type. ── */
  net.length = 0;
  await page.evaluate(() => {
    sessionStorage.setItem('sokoniAdminUnlocked', '1');
    sessionStorage.setItem('sokoniAdminTs', String(Date.now()));
  });
  await page.goto(ORIGIN + '/admin.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  const forged = await page.evaluate(() => {
    const vis = (id) => {
      const el = document.getElementById(id);
      if (!el) return 'absent';
      return getComputedStyle(el).display === 'none' ? 'hidden' : 'visible';
    };
    const body = document.getElementById('usersBody');
    return {
      lock: vis('adminLock'),
      dash: vis('adminDash'),
      signedIn: !!(window.firebaseAuth && window.firebaseAuth.currentUser),
      /* what actually rendered — an empty table is not a denial */
      userRows: body ? body.querySelectorAll('tr').length : -1,
      usersText: body ? (body.textContent || '').trim().slice(0, 90) : null,
    };
  });
  const forgedAt = await landed();
  const forgedRedirected = forgedAt.indexOf('admin.html') < 0;
  ck('RIG  the probe really is unauthenticated (no currentUser)',
    forged.signedIn === false, 'signedIn=' + forged.signedIn);
  ck('RIG  where the forged-unlock load lands',
    true, 'landed=' + forgedAt + '  lock=' + forged.lock + ' dash=' + forged.dash);
  ck('G1   forged sessionStorage unlock -> dashboard NOT revealed',
    forgedRedirected || forged.dash === 'hidden',
    forgedRedirected ? 'redirected to ' + forgedAt
      : 'lock=' + forged.lock + ' dash=' + forged.dash);
  ck('G2   forged unlock -> no admin data request is attempted',
    net.length === 0, net.length + ' request(s): ' + net.slice(0, 2).join(' | '));
  ck('G2b  forged unlock -> no user records render',
    forged.userRows <= 1, 'rows=' + forged.userRows + ' text=' + forged.usersText);

  /* ── G3: super-admin.html, unauthenticated ── */
  await page.goto(ORIGIN + '/super-admin.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const sa = await page.evaluate(() => ({
    landed: location.pathname,
    bodyChars: (document.body.textContent || '').trim().length,
    hasConsole: !!document.querySelector('.sa-topbar, .signout-btn'),
  }));
  ck('G3   super-admin.html does not present its console to an anonymous visitor',
    sa.landed.indexOf('super-admin') < 0 || sa.hasConsole === false,
    'landed=' + sa.landed + ' console=' + sa.hasConsole);

  /* ── G4 CONTROL: a gate that DOES work, so a null result is distinguishable ── */
  await page.goto(ORIGIN + '/admin-os.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const aos = await page.evaluate(() => location.pathname);
  ck('G4   CONTROL admin-os.html redirects an anonymous visitor to login',
    /login/.test(aos), 'landed=' + aos);

  /* ── S: the controls the surface is supposed to offer ── */
  /* superadmin.html was a FOURTH administrative surface, outside the F4 model: it
     gated on the claim alone and admitted `admin` where its hyphenated sibling
     required `superAdmin`. It was measured here while the duplicate-surface question
     was open, and RETIRED once that was settled — see
     docs/ADMIN_SURFACE_RECONCILIATION.md and the after-proof
     scripts/after-superadmin-retirement.js, which asserts zero remaining references.

     It is dropped from this loop rather than left in: a deleted page 404s, and four
     rows failing because a fetch returned "Not Found" would look like four defects.
     There are now three administrative surfaces, all under one model. */
  for (const f of ['admin.html', 'super-admin.html']) {
    const src = await page.evaluate(async (u) => {
      const r = await fetch(u, { cache: 'no-store' });
      return r.text();
    }, ORIGIN + '/' + f);
    /* A control can arrive three ways, and a FILE-SCOPED grep sees only one of them:
         - written into the page itself
         - injected by the shared header (pages not in EXCLUDED and without
           data-no-header, e.g. admin.html)
         - mounted by sokoni-admin-entry.js (pages that ARE header-less, e.g.
           super-admin.html)
       The first version of these rows searched the file only, and so reported that
       admin.html had no role switcher when the injected header gives it one. Ask
       whether the surface OFFERS the control, not where the bytes live. */
    const viaEntry = /sokoni-admin-entry\.js/.test(src);
    const viaHeader = /shared-header\.js/.test(src) && !/data-no-header=["']true["']/.test(src);

    /* Match a CALL, not the words. /Sign\s*Out/i also matched admin.html's prose
       "Sign out and back in to activate admin access", which would have reported a
       control the page does not have. */
    ck('S1   ' + f + ' offers a Sign out control',
      /\bsignOut\s*\(/.test(src) || viaEntry || viaHeader,
      'own=' + /\bsignOut\s*\(/.test(src) + ' entry=' + viaEntry + ' header=' + viaHeader);
    /* Likewise an anchor a person can press, not `link: 'index.html'` sitting in a
       data structure. Require the href AND a Home/Intro label on the same element. */
    ck('S2   ' + f + ' offers an Intro/Home control pointing at index.html',
      /<a[^>]+href=["'](?:\/|index\.html)["'][^>]*>(?:(?!<\/a>)[\s\S]){0,120}?(?:Home|Intro)/i
        .test(src) || viaEntry || viaHeader, 'entry=' + viaEntry + ' header=' + viaHeader);
    ck('S3   ' + f + ' offers role switching through the canonical authority',
      /_skSwitchRole/.test(src) || viaEntry || viaHeader,
      'entry=' + viaEntry + ' header=' + viaHeader);
    ck('S5   ' + f + ' gates on the administrative CONTEXT, not the claim alone',
      /SokoniAdminEntry\.guard|requireAdminContext/.test(src)
      || (f === 'admin-os.html'), '');
    ck('S4   ' + f + ' carries no PIN / second credential prompt',
      !/_promptSuperPass|3026|lockPwInput/.test(src), '');
  }

  const passed = rows.filter((r) => r.ok).length;
  return { passed, failed: rows.length - passed, rows };
}
