/* VERIFY — the on-screen crash panel is inert by default, reachable when asked,
   and reports a REAL previous-run record rather than a blank.
   ==========================================================================
   Run against a served copy of the worktree:
     node <browser-automation>/browser.mjs http://127.0.0.1:8791/pos.html \
       --script scripts/browser/verify-pos-crash-panel.mjs

   WHY THE CONTROL MATTERS. A panel that always says "no previous run recorded"
   is indistinguishable from one that cannot read the record at all — and it
   would send the phone investigation back to square one. So the run SEEDS an
   incomplete previous run and requires the panel to name its phase and last
   stage. Then it clears it and requires the honest empty answer.
========================================================================== */
export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ ok, label, detail: String(detail ?? '') });
  await page.setViewportSize({ width: 390, height: 844 });

  const panel = () => page.locator('#sk-crash-panel');
  const text = async () => (await panel().innerText().catch(() => '')) || '';

  /* Mirror a REAL merchant device: setup already complete, so the first-run
     guard never fires. Without this the rig lands on pos-setup.html, which does
     not load the breadcrumb script, and every assertion about the panel fails
     for a reason that has nothing to do with the panel. */
  await page.addInitScript(() => {
    try {
      localStorage.setItem('sokoni_setup_complete', '1');
      localStorage.setItem('sokoni_merchant_id', 'rig-merchant');
    } catch (e) { /* private mode */ }
  });

  /* ── OFF ─────────────────────────────────────────────────────────────── */
  await page.goto('http://127.0.0.1:8791/pos.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  ck('C1  OFF  no panel is rendered', (await panel().count()) === 0,
    'panels=' + (await panel().count()));

  /* CONTROL: the breadcrumb script really is running, so C1 means "gated off"
     rather than "the script never loaded". */
  const armed = await page.evaluate(() => !!localStorage.getItem('sokoni_crash_breadcrumbs'));
  ck('C2  CONTROL breadcrumbs are being written regardless',
    armed === true, 'sokoni_crash_breadcrumbs present=' + armed);

  /* ── seed an incomplete previous run, as a killed tab would leave ──────
     Seeded and rendered WITHOUT navigating. The breadcrumb script rewrites
     `sokoni_crash_previous` on every load that fails to reach 'ready', so a
     seed followed by a navigation is overwritten before the panel reads it —
     the instrument doing its job defeated the earlier version of this test.
     Rendering in place tests the panel's logic deterministically. */
  await page.goto('http://127.0.0.1:8791/pos.html?diag=crash', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.evaluate(() => { var b = document.getElementById('sk-crash-panel'); if (b) b.remove(); });

  await page.evaluate(() => {
    localStorage.setItem('sokoni_crash_previous', JSON.stringify({
      phase: 'FIREBASE', lastStage: 'firebase:auth-init', sessionId: 'seeded123',
      iosVersion: '17.4', standalone: true, deviceMemory: 2,
      scripts: [{ ok: true }, { ok: true }, { ok: false }],
      stages: [
        { seq: 1, stage: 'breadcrumbs-installed', started: 2, finished: 20, heapMB: 8 },
        { seq: 2, stage: 'scripts:parse', started: 20, finished: 900, heapMB: 140 },
        { seq: 3, stage: 'firebase:auth-init', started: 900, finished: null, heapMB: 388 },
      ],
    }));
  });

  await page.addScriptTag({ content: 'window.sokoniCrashPanel && window.sokoniCrashPanel();' });
  await page.waitForTimeout(900);

  ck('C3  ON   the panel renders', (await panel().count()) === 1, 'panels=' + (await panel().count()));
  const t = await text();
  ck('C4  ON   it names the PHASE the previous run died in',
    /PREVIOUS RUN DIED IN PHASE: FIREBASE/.test(t), (t.split('\n')[0] || '').slice(0, 60));
  ck('C5  ON   it names the LAST STAGE — the crash boundary',
    /firebase:auth-init/.test(t), 'boundary named');
  ck('C6  ON   it reports memory, which is what distinguishes an OOM kill',
    /heap 388 MB/.test(t) && /deviceMemory 2 GB/.test(t), 'heap + deviceMemory present');
  ck('C7  ON   it marks the stage that never finished',
    /did not finish|NEVER FINISHED/.test(t), 'unfinished stage flagged');
  ck('C8  ON   PWA/standalone state is reported',
    /standalone   true/.test(t), 'standalone reported — lifecycles differ from a browser tab');

  /* ── the guard must not redirect a diagnostic URL away ───────────────── */
  ck('C9  the first-run guard did not replace the diagnostic page',
    page.url().includes('diag=crash') && !page.url().includes('pos-setup'),
    'landed=' + page.url().split('/').pop());

  /* ── NEGATIVE CONTROL: with no record it must say so, not fabricate ──── */
  await page.evaluate(() => { localStorage.removeItem('sokoni_crash_previous');
    var b = document.getElementById('sk-crash-panel'); if (b) b.remove(); });
  await page.addScriptTag({ content: 'window.sokoniCrashPanel && window.sokoniCrashPanel();' });
  await page.waitForTimeout(900);
  const empty = await text();
  ck('C10 CONTROL with no record it reports NO previous run rather than inventing one',
    /NO INCOMPLETE PREVIOUS RUN/.test(empty) && !/DIED IN PHASE/.test(empty),
    (empty.split('\n')[0] || '').slice(0, 60) + '  | guarded against a panel that always says the same thing');

  const passed = rows.filter((r) => r.ok).length;
  return {
    verdict: passed + '/' + rows.length + ' passed',
    failed: rows.filter((r) => !r.ok).map((r) => r.label + '  [' + r.detail + ']'),
    rows: rows.map((r) => (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '  [' + r.detail + ']'),
  };
}
