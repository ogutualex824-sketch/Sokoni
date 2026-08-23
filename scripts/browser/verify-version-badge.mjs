/* VERIFY — the build indicator is inert when off, and tells the truth when on.
   ==========================================================================
   Run against a served copy of the worktree:
     node <browser-automation>/browser.mjs http://127.0.0.1:8791/index.html \
       --script scripts/browser/verify-version-badge.mjs

   THE CONTROL THAT MATTERS. "UP TO DATE" is worthless if the badge can only ever
   say that. So the run rewrites version.json's response to a DIFFERENT cache
   version and requires the verdict to flip to "THIS DEVICE IS BEHIND". A badge
   that cannot report a stale device is exactly the instrument we already had:
   one that reports nothing useful and lets the answer default to "try
   refreshing".
========================================================================== */
export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ ok, label, detail: String(detail ?? '') });

  await page.setViewportSize({ width: 390, height: 844 });

  const fetched = [];
  page.on('request', (r) => { if (/sokoni-version-badge\.js/.test(r.url())) fetched.push(r.url()); });

  let served = null;

  const badge = () => page.locator('#sk-version-badge');
  const text = async () => (await badge().innerText().catch(() => '')) || '';

  /* ── OFF ─────────────────────────────────────────────────────────────── */
  await page.goto('http://127.0.0.1:8791/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  ck('V1  OFF  the badge script is never fetched', fetched.length === 0, 'fetches=' + fetched.length);
  ck('V2  OFF  nothing is rendered', (await badge().count()) === 0, 'badges=' + (await badge().count()));

  /* CONTROL: sw-register really did load, so V1/V2 mean "gated off" rather than
     "the entry point never ran". */
  const swRegRan = await page.evaluate(() =>
    !!Array.from(document.scripts).find((s) => /sw-register\.js/.test(s.src || '')));
  ck('V3  CONTROL sw-register.js is present, so the gate was actually evaluated',
    swRegRan, 'without this, V1/V2 could pass because nothing ran at all');

  /* ── ON, in a context with SERVICE WORKERS BLOCKED ───────────────────────
     Playwright's page.route does NOT intercept requests a service worker makes.
     With the real worker active it fetched version.json itself, the stub never
     applied, and the badge correctly reported the real state while the test
     believed it was seeing a forged one — a control that silently tests nothing.

     So the controls run with workers blocked and a SEEDED cache instead. That
     exercises the badge's real comparison logic, including the suffix
     normalisation (`-static`) that made the first version call every healthy
     device BEHIND. */
  const ctx = await page.context().browser().newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'block',
  });
  const p2 = await ctx.newPage();
  const badge2 = () => p2.locator('#sk-version-badge');
  const text2 = async () => (await badge2().innerText().catch(() => '')) || '';

  const SEEDED = 'sokoni-20200101000000-v1';
  await p2.addInitScript((name) => {
    /* Seed a SUFFIXED cache, exactly as the worker names them. */
    try { caches.open(name + '-static'); } catch (e) { /* ignore */ }
  }, SEEDED);

  await p2.route('**/version.json*', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ cacheVersion: served, commitShort: 'abc1234', branch: 'test' }),
  }));

  served = SEEDED;                     /* deployed == running */
  await p2.goto('http://127.0.0.1:8791/index.html?diag=version', { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(3500);

  ck('V5  ON   it renders', (await badge2().count()) === 1, 'badges=' + (await badge2().count()));

  const match = await text2();
  const runningNow = ((match.match(/running\s+(\S+)/) || [])[1] || '').trim();
  ck('V5b ON   the SUFFIXED cache key is normalised before comparing',
    runningNow === SEEDED, 'running=' + (runningNow || '(none)') +
    '  | the worker opens ' + SEEDED + '-static; unnormalised this reads as BEHIND on every healthy device');
  ck('V6  ON   a matching build reports UP TO DATE',
    /UP TO DATE/.test(match), (match.split('\n')[0] || '').slice(0, 60));
  ck('V7  ON   it reports the display mode and SW state',
    /mode\s/.test(match) && /sw\s/.test(match),
    'standalone vs browser tab is the usual reason one updates and the other does not');

  /* ── THE CONTROL: the SAME handler now serves a NEWER version ───────── */
  served = 'sokoni-20990101000000-v999';
  await p2.waitForTimeout(6500);       /* the badge re-renders on its own interval */
  const behind = await text2();

  ck('V8  CONTROL a device on an older build is reported as BEHIND',
    /THIS DEVICE IS BEHIND/.test(behind), (behind.split('\n')[0] || '').slice(0, 60) +
    '  | if this fails, "UP TO DATE" proves nothing');
  ck('V9  CONTROL and it names both versions so the gap is legible',
    behind.includes(SEEDED) && /v999/.test(behind),
    'running vs deployed must both be visible, not just a verdict');

  ck('V10 the Update control is present', (await p2.locator('#sk-version-badge button').count()) >= 1,
    'buttons=' + (await p2.locator('#sk-version-badge button').count()));

  await ctx.close();

  const passed = rows.filter((r) => r.ok).length;
  return {
    verdict: passed + '/' + rows.length + ' passed',
    failed: rows.filter((r) => !r.ok).map((r) => r.label + '  [' + r.detail + ']'),
    rows: rows.map((r) => (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '  [' + r.detail + ']'),
  };
}
