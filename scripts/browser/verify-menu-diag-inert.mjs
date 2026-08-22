/* VERIFY — the full-viewport-layer diagnostic is inert when off, and TELLS THE
   TRUTH when on.
   ==========================================================================
   Run:  node <browser-automation>/browser.mjs http://127.0.0.1:8791/product \
           --script scripts/browser/verify-menu-diag-inert.mjs

   Serve the worktree first, because the drawer and the overlay are built by
   sokoni-ui-extras.js and file:// blocks the module graph that loads it.

   WHY THE CONTROLS ARE SHAPED THIS WAY
   "The drawer is parked off-screen" is worthless on its own — an instrument
   that can only ever print that is indistinguishable from one that is broken.

   The strongest available control needs no synthetic state at all: on a fresh
   profile the product page really is behind #_sokoniPrivacyBanner, a fixed
   390x844 rgba(0,0,0,0.66) consent scrim at z-index 300001. So the run starts
   by requiring the instrument to NAME that layer unprompted, then dismisses
   consent and requires the verdict to clear. A drawer-only version of this
   file printed "layers parked away (expected)" in exactly that state, which is
   the false exoneration these checks exist to catch.

   Attribution is then proved separately: a real tap, followed by the real
   class writes the product's own opener makes, joined in one log line.
========================================================================== */
export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ ok, label, detail: String(detail ?? '') });

  await page.setViewportSize({ width: 390, height: 844 });

  const fetched = [];
  page.on('request', (r) => { if (/sokoni-menu-diag\.js/.test(r.url())) fetched.push(r.url()); });

  const panel = () => page.locator('#sk-menu-diag');
  const readout = async () => (await panel().innerText().catch(() => '')) || '';
  const verdictOf = (t) => (t.split('\n')[1] || '').slice(0, 76);
  const lineOf = (t, p) => (t.split('\n').find((l) => l.startsWith(p)) || '');

  /* ── OFF: the page must pay nothing ─────────────────────────────────── */
  await page.goto('http://127.0.0.1:8791/product', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  ck('D1  OFF  the diagnostic is never fetched', fetched.length === 0, 'fetches=' + fetched.length);
  ck('D2  OFF  no readout is rendered', (await panel().count()) === 0,
    'panels=' + (await panel().count()));

  /* CONTROL for D1/D2: the layers really do exist here, so those two passes
     mean "off", not "there was nothing on this page anyway". */
  const drawerOff = await page.locator('#mobileMenu').count();
  ck('D3  CONTROL the drawer exists regardless of the diagnostic',
    drawerOff === 1, '#mobileMenu count=' + drawerOff +
    '  | without this, D1/D2 could pass on an empty page');

  /* ── ON, on a profile that has NOT answered consent ─────────────────── */
  await page.goto('http://127.0.0.1:8791/product?diag=menu', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  ck('D4  ON   the diagnostic is fetched exactly once', fetched.length === 1, 'fetches=' + fetched.length);
  ck('D5  ON   the readout renders', (await panel().count()) === 1, 'panels=' + (await panel().count()));

  const scrimUp = await readout();
  ck('D6  ON   it watches all three layers, not just the drawer',
    /"#_sokoniPrivacyBanner"/.test(scrimUp) && /"#menuOverlay"/.test(scrimUp) && /"#mobileMenu"/.test(scrimUp),
    'a drawer-only build reported "expected" while a black scrim covered the page');

  ck('D7  ON   observers attached lazily to JS-built elements',
    /#mobileMenu APPEARED/.test(scrimUp) && /#menuOverlay APPEARED/.test(scrimUp),
    'an unattached observer prints an empty change log that looks like "nothing happened"');

  /* THE CONTROL THAT NEEDS NO SYNTHETIC STATE. */
  ck('D8  CONTROL it names the consent scrim as covering, unprompted',
    /COVERING THE PAGE/.test(scrimUp) && /_sokoniPrivacyBanner/.test(verdictOf(scrimUp)),
    verdictOf(scrimUp) + '  | real layer, real state, nothing forced');

  ck('D9  CONTROL and reports what is under the centre inside it',
    /under viewport centre:/.test(scrimUp) && !/sk-menu-diag/.test(lineOf(scrimUp, 'under viewport centre:')),
    lineOf(scrimUp, 'under viewport centre:').slice(0, 76) +
      '  | the readout must never be the thing it measures');

  /* ── dismiss consent: the verdict must CLEAR ────────────────────────── */
  const btn = page.locator('#_sokoniPrivacyBanner button').first();
  if (await btn.count()) await btn.click({ force: true }).catch(() => {});
  await page.waitForTimeout(1400);
  const scrimGone = await readout();
  ck('D10 CONTROL answering consent clears the verdict',
    !/COVERING THE PAGE/.test(scrimGone) && /COVERING THE PAGE/.test(scrimUp),
    verdictOf(scrimGone) + '  | guarded on D8 having fired, or this passes vacuously');

  /* ── attribution: a real tap joined to a real state change ──────────── */
  const bait = page.locator('h1').first();
  let expectedTap = null;
  if ((await bait.count()) > 0) {
    const b = await bait.boundingBox().catch(() => null);
    if (b) {
      /* Ask the page what is actually on top where we are about to tap,
         rather than assuming the tap lands on what we aimed at. */
      expectedTap = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el ? { tag: el.tagName.toLowerCase(), id: el.id || null } : null;
      }, [b.x + b.width / 2, b.y + b.height / 2]);
    }
    await bait.click({ force: true }).catch(() => {});
  }
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    document.getElementById('mobileMenu').classList.add('active-menu');
    const o = document.getElementById('menuOverlay');
    if (o) o.classList.add('active');
    document.body.style.overflow = 'hidden';
  });
  await page.waitForTimeout(1200);
  const opened = await readout();

  ck('D11 CONTROL an open drawer flips the verdict to COVERING',
    /COVERING THE PAGE/.test(opened) && /#mobileMenu/.test(verdictOf(opened)),
    verdictOf(opened));

  const tapLine = (opened.split('\n').filter((l) => /last tap/.test(l)).slice(-1)[0] || '');
  const namedRight = !!expectedTap && (expectedTap.id
    ? tapLine.includes('"id":"' + expectedTap.id + '"')
    : tapLine.includes('"tag":"' + expectedTap.tag + '"'));
  ck('D12 CONTROL the log joins the state change to the TAP that preceded it',
    /last tap/.test(tapLine) && namedRight,
    'on top was ' + JSON.stringify(expectedTap) + ' | logged: ' +
      tapLine.slice(Math.max(0, tapLine.indexOf('last tap'))).slice(0, 110));

  ck('D13 CONTROL the scroll lock the opener sets is visible',
    /scroll lock: body=hidden/.test(opened), lineOf(opened, 'scroll lock:').slice(0, 60));

  await page.evaluate(() => {
    document.getElementById('mobileMenu').classList.remove('active-menu');
    const o = document.getElementById('menuOverlay');
    if (o) o.classList.remove('active');
    document.body.style.overflow = '';
  });
  await page.waitForTimeout(1200);
  const closed = await readout();
  ck('D14 CONTROL closing flips the verdict back',
    !/COVERING THE PAGE/.test(closed) && /COVERING THE PAGE/.test(opened),
    verdictOf(closed) + '  | guarded on D11 having fired');

  const passed = rows.filter((r) => r.ok).length;
  return {
    verdict: passed + '/' + rows.length + ' passed',
    failed: rows.filter((r) => !r.ok).map((r) => r.label + '  [' + r.detail + ']'),
    rows: rows.map((r) => (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '  [' + r.detail + ']'),
  };
}
