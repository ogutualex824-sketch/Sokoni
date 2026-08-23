/* VERIFY — POS stable boot: a signed-in merchant is not re-registered, and the
   build row is a deterministic state machine.
   ==========================================================================
   Run against a served copy of the worktree:
     node <browser-automation>/browser.mjs http://127.0.0.1:8791/pos.html \
       --script scripts/browser/verify-pos-boot-state.mjs

   TWO PROVEN DEFECTS ARE UNDER TEST — no speculative crash fix is included, and
   the sale/payment engine is untouched.

     1 the first-run guard consulted ONLY device storage, so a configured
       merchant on a NEW PHONE was redirected into business setup. localStorage
       absence means "new browser", not "new business".
     2 the build row ran once at parse and failed silently, so "no update" could
       be both displayed and wrong, and a failed check was indistinguishable from
       one still in progress.

   Every check carries its opposite: a signed-OUT fresh device must STILL be sent
   to setup, or the fix would simply have disabled the wizard.
========================================================================== */
const VIEWPORTS = [
  { name: '390x844', w: 390, h: 844 },
  { name: '412x915', w: 412, h: 915 },
  { name: '1280x720', w: 1280, h: 720 },
];

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ ok, label, detail: String(detail ?? '') });
  const browser = page.context().browser();

  const land = async (ctx, seed) => {
    const p = await ctx.newPage();
    if (seed) await p.addInitScript(seed);
    await p.goto('http://127.0.0.1:8791/pos.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await p.waitForTimeout(3000);
    const url = p.url();
    return { p, url, wentToSetup: /pos-setup/.test(url) };
  };

  /* ── 1. SIGNED OUT + fresh device -> the wizard MUST still happen ─────── */
  let ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let r = await land(ctx, null);
  ck('P1  CONTROL a signed-OUT fresh device still goes to setup',
    r.wentToSetup, 'landed=' + r.url.split('/').pop() +
    '  | if this fails the fix has merely disabled the wizard');
  await r.p.close(); await ctx.close();

  /* ── 2. SIGNED IN + fresh device -> must NOT be re-registered ─────────── */
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  r = await land(ctx, () => {
    try { localStorage.setItem('loggedIn', 'true'); } catch (e) {}
  });
  ck('P2  a SIGNED-IN merchant on a new device is NOT sent to business setup',
    !r.wentToSetup, 'landed=' + r.url.split('/').pop() +
    '  | localStorage absence means new BROWSER, not new BUSINESS');
  await r.p.close(); await ctx.close();

  /* the other established marker, since auth-guard.js accepts either */
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  r = await land(ctx, () => {
    try { localStorage.setItem('sokoniUser', JSON.stringify({ uid: 'u1', name: 'Alex' })); } catch (e) {}
  });
  ck('P3  the sokoniUser marker is honoured too, not just loggedIn',
    !r.wentToSetup, 'landed=' + r.url.split('/').pop() + '  | same markers auth-guard.js uses');
  await r.p.close(); await ctx.close();

  /* ── 3. the device flag still works on its own ────────────────────────── */
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  r = await land(ctx, () => {
    try { localStorage.setItem('sokoni_setup_complete', '1'); } catch (e) {}
  });
  ck('P4  an already-set-up device still boots POS directly',
    !r.wentToSetup, 'landed=' + r.url.split('/').pop() + '  | existing behaviour preserved');
  await r.p.close(); await ctx.close();

  /* ── 4. the build row, across viewports ───────────────────────────────── */
  for (const vp of VIEWPORTS) {
    const c = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const p = await c.newPage();
    await p.addInitScript(() => { try { localStorage.setItem('loggedIn', 'true'); } catch (e) {} });
    await p.goto('http://127.0.0.1:8791/pos.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await p.waitForTimeout(4500);

    const txt = await p.locator('#pos-build-info').innerText().catch(() => '(absent)');
    const settled = /up to date|update available|unable to check/i.test(txt);
    ck('P5 [' + vp.name + '] the build row SETTLES on a real state',
      settled, 'text="' + txt.slice(0, 70) + '"  | never left standing on "Checking…"');

    /* A failure must be reported as a failure, with a way back.
       MAIN WORLD via addScriptTag: page.evaluate runs in an isolated world that
       shares the DOM but not window globals, so deleting sokoniBuildInfo there
       left the real global untouched and this control silently tested nothing —
       it then "passed" on one viewport by coincidence, which is exactly how a
       vacuous check hides. */
    await p.addScriptTag({ content:
      'try { delete window.sokoniBuildInfo; } catch (e) { window.sokoniBuildInfo = undefined; }' +
      'window._posShowBuild && window._posShowBuild();' });
    await p.waitForTimeout(1500);
    const failTxt = await p.locator('#pos-build-info').innerText().catch(() => '');
    ck('P6 [' + vp.name + '] CONTROL a broken check says UNABLE TO CHECK, not "up to date"',
      /unable to check/i.test(failTxt) && !/up to date/i.test(failTxt),
      'text="' + failTxt.slice(0, 60) + '"  | silence here is what made a stale reading look healthy');
    ck('P7 [' + vp.name + '] ...and offers a retry',
      (await p.locator('#pos-build-retry').count()) === 1,
      'retry control present');

    await p.close(); await c.close();
  }

  const passed = rows.filter((r) => r.ok).length;
  return {
    verdict: passed + '/' + rows.length + ' passed',
    failed: rows.filter((r) => !r.ok).map((r) => r.label + '  [' + r.detail + ']'),
    rows: rows.map((r) => (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '  [' + r.detail + ']'),
  };
}
