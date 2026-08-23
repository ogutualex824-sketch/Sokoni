/* VERIFY — two devices, one till.
   ==========================================================================
   A sale rung up on the phone decrements canonical products.stock on the
   server. This proves the OTHER device reflects that without a reload, that
   the listener is released on teardown, and that a live failure is SAID rather
   than left showing stale numbers that look current.

   The fake sits outside the boundary under test: it stands in for Firestore's
   onSnapshot and nothing else. Everything downstream of it — the mapping, the
   deferral while a payment sheet is open, the teardown — is the real module.
========================================================================== */

function driveInPage() {
  const out = (o) => { document.body.dataset.rtDiag = JSON.stringify(o); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    try {
      const M = window.SokoniMerchantSell, md = window.SokoniMerchantData;
      if (!M || !md) return out({ error: 'module absent' });
      if (typeof md.subscribeProducts !== 'function')
        return out({ error: 'SokoniMerchantData.subscribeProducts missing' });

      let push = null, unsubCalls = 0, listeners = 0;
      const rows = (stock) => [
        { id: 'P1', name: 'Sugar 2kg', price: 300, stock, shopId: 'rig' },
      ];

      const db = {
        queryProducts: () => Promise.resolve(rows(9)),
        /* Stands in for Firestore. Hands back an unsubscribe we can count. */
        subscribeProducts: (spec, onRows, onErr) => {
          listeners++;
          push = onRows; window.__rtErr = onErr;
          return () => { unsubCalls++; push = null; };
        },
      };

      const panel = document.getElementById('panel-sell') || (() => {
        const d = document.createElement('div');
        d.className = 'panel'; d.id = 'panel-sell';
        (document.querySelector('.main') || document.body).appendChild(d);
        return d;
      })();
      panel.classList.add('show', 'panel-scroll');
      panel.innerHTML = '';

      const ui = M.mount(panel, {
        scope: { ok: true, shopId: 'rig', sellerUid: 'rig' },
        db, shopName: 'Rig', onToast: () => {},
      });
      await sleep(1400);

      const txt = () => (panel.textContent || '').replace(/\s+/g, ' ');
      /* Read the stock ELEMENT, not the card's textContent. textContent runs the
         price and the stock together — "300" + "9" parsed as 3009 — so the first
         version of this probe reported a number the screen never showed. */
      const stockShown = () => {
        const el = panel.querySelector('.msl-card .st');
        if (!el) return null;
        const m = (el.textContent || '').match(/(\d+)/);
        return m ? Number(m[1]) : null;
      };

      const initial = stockShown();
      const subscribed = listeners === 1 && typeof push === 'function';

      /* ── THE OTHER DEVICE SELLS ── the server's stock drops to 6. */
      if (push) push(rows(6));
      await sleep(500);
      const afterRemote = stockShown();

      /* ── ONE listener per mount, not one per repaint ── */
      const stillOne = listeners === 1;

      /* ── while a payment sheet is open, the repaint is DEFERRED ── */
      const card = panel.querySelector('.msl-card');
      if (card) card.click();
      await sleep(300);
      const charge = [].slice.call(panel.querySelectorAll('button'))
        .find((b) => /charge/i.test(b.textContent || ''));
      if (charge) charge.click();
      await sleep(400);
      const sheetOpen = !!panel.querySelector('.msl-sheet');
      if (push) push(rows(2));
      await sleep(400);
      const sheetSurvived = !!panel.querySelector('.msl-sheet');

      /* closing it paints the newest figures */
      const back = [].slice.call(panel.querySelectorAll('[data-act="close-sheet"]'))[0];
      if (back) back.click();
      await sleep(500);
      const afterClose = stockShown();

      /* ── a live failure must be SAID ──
         Close the CART sheet too first. "Back to cart" leaves a sheet open, so
         the deferral rule still applies and the notice is correctly withheld —
         the first version of this probe read that as a missing notice when the
         module was behaving exactly as designed. */
      const closeAll = [].slice.call(panel.querySelectorAll('[data-act="close-sheet"]'))[0];
      if (closeAll) closeAll.click();
      await sleep(400);
      const fullyClosed = !panel.querySelector('.msl-sheet');

      if (window.__rtErr) window.__rtErr(new Error('permission-denied'));
      await sleep(400);
      const saysStale = /live stock updates stopped/i.test(txt());

      /* ── teardown releases the listener ── */
      try { ui && ui.destroy && ui.destroy(); } catch (_) {}
      const released = unsubCalls === 1;

      out({ initial, subscribed, afterRemote, stillOne, sheetOpen, sheetSurvived,
            afterClose, saysStale, released, listeners, unsubCalls, fullyClosed });
    } catch (e) { out({ error: String((e && e.stack) || e) }); }
  })();
}

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ ok, label, detail: String(detail ?? '') });

  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto('http://127.0.0.1:8798/merchant-v2.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await page.addScriptTag({ content: `(${driveInPage.toString()})();` });
  await page.waitForFunction(() => document.body.dataset.rtDiag !== undefined,
    null, { timeout: 40000, polling: 300 }).catch(() => {});
  const m = JSON.parse(await page.evaluate(() => document.body.dataset.rtDiag || '{}'));

  if (m.error) {
    ck('R0 the surface could be driven', false, m.error);
    return { verdict: '0/1 passed', failed: ['R0  [' + m.error + ']'] };
  }

  ck('R1 the till subscribes to canonical stock on mount',
    m.subscribed, 'listeners=' + m.listeners);
  ck('R2 CONTROL it shows the loaded figure first',
    m.initial === 9, 'initial=' + m.initial);
  ck('R3 a sale on ANOTHER device updates this one with no reload',
    m.afterRemote === 6, '9 → ' + m.afterRemote + ' (this is the whole slice)');
  ck('R4 ONE listener per mount, not one per repaint',
    m.stillOne, 'listeners=' + m.listeners + ' — a listener per paint would bill reads forever');
  ck('R5 CONTROL the payment sheet actually opened',
    m.sheetOpen, 'the deferral test below is meaningless without it');
  ck('R6 a live update does NOT rebuild the sheet under the cashier\'s thumb',
    m.sheetSurvived, 'the server re-checks stock at completion anyway');
  ck('R7 closing the sheet shows the newest figures',
    m.afterClose === 2, 'deferred rows applied: ' + m.afterClose);
  ck('R8 CONTROL the sheet is fully closed before the notice is expected',
    m.fullyClosed, 'a sheet still open correctly WITHHOLDS the repaint');
  ck('R9 a live listener that FAILS says so rather than showing stale stock',
    m.saysStale, 'silent staleness that looks current is the worst outcome');
  ck('R10 teardown releases the listener exactly once',
    m.released, 'unsubCalls=' + m.unsubCalls + ' — an orphan socket bills reads for a dead panel');

  const passed = rows.filter((r) => r.ok).length;
  return {
    verdict: passed + '/' + rows.length + ' passed',
    failed: rows.filter((r) => !r.ok).map((r) => r.label + '  [' + r.detail + ']'),
  };
}
