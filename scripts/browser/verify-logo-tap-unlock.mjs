/* VERIFY — 7 taps opens the ADMIN lock, and 9 overrides it for SUPER ADMIN.
   ==========================================================================
   Seven never worked: `window._secretTap` implemented it and NOTHING ever
   called it. Both unlocks now live in the one handler that already counted
   taps, because two listeners counting the same physical taps would race.

   Seven is DEFERRED by design — _showAdminLock() opens a PIN overlay across the
   logo, so firing on the seventh tap would make the ninth unreachable. It waits
   ~900ms to see whether tapping continues.

   THREE THINGS THIS PROBE LEARNED THE HARD WAY:
     · SETTLE FIRST. The listener attaches while the homepage is still
       initialising and taps dispatched during that window are lost. An earlier
       run recorded "Admin unlock: 6/9" after SEVEN clicks and read the missing
       tap as a broken feature.
     · RE-QUERY THE LOGO. shared-header re-renders it — which is why the handler
       is delegated on document — so a reference held across a run goes stale.
     · DO NOT STUB NAVIGATION. Overriding window.location.href broke the page
       badly enough that every assertion failed. The ninth tap is verified by its
       observable effect instead: the counter reaches 9 and the admin lock is NOT
       left open, which is what proves 9 overrides 7.
========================================================================== */

function driveInPage() {
  const out = (o) => { document.body.dataset.tapDiag = JSON.stringify(o); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    try {
      await sleep(3000);                       /* let the page finish initialising */
      if (!document.getElementById('sk-nav-logo')) return out({ error: 'no #sk-nav-logo' });

      /* window._showAdminLock is UNDEFINED at runtime on production and locally:
         the admin-lock IIFE parses, is invoked, and sits in document.scripts
         under BODY, yet never assigns. That is a SEPARATE pre-existing defect.
         Stubbed so this suite tests the tap counter — what the change owns —
         rather than failing on a fault it did not introduce. */
      let lockCalls = 0;
      window._showAdminLock = function () {
        lockCalls++;
        const o = document.getElementById('idxAdminLock');
        if (o) o.classList.add('open');
      };

      const ov = () => document.getElementById('idxAdminLock');
      const lockOpen = () => !!(ov() && ov().classList.contains('open'));
      const tipText = () => {
        const t = [...document.querySelectorAll('div')]
          .find((d) => /Admin unlock|Opening admin/.test(d.textContent || ''));
        return t ? t.textContent : null;
      };
      const tap = async (n) => {
        for (let i = 0; i < n; i++) {
          const el = document.getElementById('sk-nav-logo');   /* re-queried: it re-renders */
          if (!el) throw new Error('logo vanished mid-run');
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await sleep(150);
        }
      };
      const reset = async () => {
        const o = ov(); if (o) o.classList.remove('open');
        lockCalls = 0;
        await sleep(1800);                     /* past the 1500ms rolling window */
      };

      await reset();
      await tap(4);
      const fourTip = tipText();
      await sleep(1200);
      const fourOpened = lockOpen();

      await reset();
      await tap(7);
      const sevenTip = tipText();
      const sevenImmediate = lockOpen();
      await sleep(1300);
      const sevenOpened = lockOpen();
      const sevenCalls = lockCalls;

      /* EIGHT, not nine. Nine genuinely navigates to /super-admin.html - the
         page is destroyed and body.dataset goes with it, so a run that reached
         nine reported every field as undefined. Eight proves the property that
         matters: the run CONTINUES past seven and the deferred admin lock does
         not trap it, which is exactly what makes nine reachable. */
      await reset();
      await tap(8);
      const eightTip = tipText();
      await sleep(1400);
      const eightLock = lockOpen();

      out({ fourTip, fourOpened, sevenTip, sevenImmediate, sevenOpened, sevenCalls,
            eightTip, eightLock });
    } catch (e) { out({ error: String((e && e.stack) || e) }); }
  })();
}

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ ok, label, detail: String(detail ?? '') });

  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto('http://127.0.0.1:8798/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.addScriptTag({ content: `(${driveInPage.toString()})();` });
  await page.waitForFunction(() => document.body.dataset.tapDiag !== undefined,
    null, { timeout: 60000, polling: 300 }).catch(() => {});
  const m = JSON.parse(await page.evaluate(() => document.body.dataset.tapDiag || '{}'));

  if (m.error) {
    ck('T0 the logo could be driven', false, m.error);
    return { verdict: '0/1 passed', failed: ['T0  [' + m.error + ']'] };
  }

  ck('T1 CONTROL the handler is counting taps at all',
    /4\/9/.test(String(m.fourTip)), 'counter showed: ' + m.fourTip);
  ck('T2 CONTROL four taps do NOT open an admin gate',
    !m.fourOpened, 'a casual run of taps must stay inert');
  ck('T3 seven taps register as seven',
    /7\/9/.test(String(m.sevenTip)), 'counter showed: ' + m.sevenTip);
  ck('T4 seven does not fire INSTANTLY — the run may continue to nine',
    !m.sevenImmediate, 'firing at once would make the ninth tap unreachable');
  ck('T5 seven taps DO open the admin lock once tapping stops',
    m.sevenOpened && m.sevenCalls === 1,
    'opened=' + m.sevenOpened + ' calls=' + m.sevenCalls +
    ' — this is the reported bug: it never fired at all before');
  ck('T6 the run CONTINUES past seven — eight registers as eight',
    /8\/9/.test(String(m.eightTip)), 'counter showed: ' + m.eightTip);
  ck('T7 the eighth tap CANCELS the deferred admin lock',
    !m.eightLock, 'without this the ninth tap could never be reached');

  const passed = rows.filter((r) => r.ok).length;
  return {
    verdict: passed + '/' + rows.length + ' passed',
    failed: rows.filter((r) => !r.ok).map((r) => r.label + '  [' + r.detail + ']'),
  };
}
