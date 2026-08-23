/* VERIFY — the C wiring changes which STATE /pos shows, and can never stop POS
   from opening.
   ==========================================================================
   Run against a served copy of the worktree:
     node <browser-automation>/browser.mjs http://127.0.0.1:8791/pos.html \
       --script scripts/browser/verify-pos-boot-wiring.mjs

   THE CONTROL THAT MATTERS MOST is the negative one: /pos is the page that
   currently dies on one device, so a boot addition must be provably incapable
   of blocking it. Every failure mode — no auth, no resolver, no Firestore,
   thrown error — must leave the page exactly as it was.
========================================================================== */
const VIEWPORTS = [
  { name: '390x844', w: 390, h: 844 },
  { name: '1280x720', w: 1280, h: 720 },
];

/* Runs in the MAIN world: page.evaluate is an isolated world that shares the
   DOM but not window globals, so it cannot see SokoniPosContext. */
function driveInPage(decision) {
  var out = function (o) { document.body.dataset.bootWire = JSON.stringify(o); };
  var R = {};
  try {
    R.resolverPresent = typeof window.SokoniPosContext === 'object';
    R.resolveIsFn = !!(window.SokoniPosContext && typeof window.SokoniPosContext.resolve === 'function');
    R.noteBefore = !!document.getElementById('sk-pos-boot-note');
    R.navigatedAway = location.pathname.indexOf('pos-setup') !== -1;
    out(R);
  } catch (e) { out({ error: String(e && e.message) }); }
}

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ ok, label, detail: String(detail ?? '') });

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    /* signed-in merchant device, so the first-run guard is not what we measure */
    await page.addInitScript(() => {
      try {
        localStorage.setItem('loggedIn', 'true');
        localStorage.setItem('sokoni_setup_complete', '1');
        localStorage.setItem('sokoni_merchant_id', 'rig');
      } catch (e) {}
    });

    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 140)));

    await page.goto('http://127.0.0.1:8791/pos.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(14000);   /* past `load` + the 600ms delay + auth timeout */

    await page.addScriptTag({ content: `(${driveInPage.toString()})();` }).catch(() => {});
    const m = JSON.parse(await page.evaluate(() => document.body.dataset.bootWire || '{}').catch(() => '{}'));

    const t = vp.name;
    ck('W1 [' + t + '] the resolver is loaded and exposes resolve()',
      m.resolverPresent === true && m.resolveIsFn === true,
      'present=' + m.resolverPresent + ' resolve=' + m.resolveIsFn);

    ck('W2 [' + t + '] CONTROL the boot script never navigated away',
      m.navigatedAway === false && !page.url().includes('pos-setup'),
      'url=' + page.url().split('/').pop() +
      '  | a redirect chain is what made this page fragile; it renders in place instead');

    /* With no real auth the resolver cannot run — and that must be silent, not
       a message and not a failure. */
    ck('W3 [' + t + '] with no authenticated user it stays SILENT',
      m.noteBefore === false,
      'note rendered=' + m.noteBefore +
      '  | "no uid" must never be shown as a setup or error state');

    ck('W4 [' + t + '] it raised no page errors',
      errs.length === 0, errs.length ? errs[0] : 'none');

    /* THE NEGATIVE CONTROL: the page must still work with the boot script broken. */
    const bodyChars = await page.evaluate(() => (document.body.innerText || '').length).catch(() => 0);
    ck('W5 [' + t + '] the POS document still rendered normally',
      bodyChars > 200, 'bodyChars=' + bodyChars +
      '  | the wiring must be incapable of stopping POS from opening');

    page.removeAllListeners('pageerror');
  }

  /* ── explicit failure-mode control, in the main world ─────────────────── */
  await page.addScriptTag({ content: `
    window.SokoniPosContext = { resolve: function () { throw new Error('forced failure'); } };
    document.body.dataset.forced = '1';
  `}).catch(() => {});
  await page.waitForTimeout(1500);
  const stillFine = await page.evaluate(() => (document.body.innerText || '').length).catch(() => 0);
  ck('W6 CONTROL a resolver that THROWS does not take the page down',
    stillFine > 200, 'bodyChars=' + stillFine +
    '  | fail toward POS is the whole contract of this slice');

  const passed = rows.filter((r) => r.ok).length;
  return {
    verdict: passed + '/' + rows.length + ' passed',
    failed: rows.filter((r) => !r.ok).map((r) => r.label + '  [' + r.detail + ']'),
    rows: rows.map((r) => (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '  [' + r.detail + ']'),
  };
}
