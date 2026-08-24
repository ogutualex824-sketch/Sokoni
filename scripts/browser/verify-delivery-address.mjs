/* VERIFY — the delivery address field actually works.
   ==========================================================================
   The reported bug: typing a destination answered "Delivery addresses are
   unavailable on this device." That was the CORRECT message for a missing
   authority — SokoniBuyerLocations was never loaded into merchant-v2 — so the
   fix is to supply it, and this proves the message is gone and a real
   destination is now produced.
========================================================================== */

function driveInPage() {
  const out = (o) => { document.body.dataset.delDiag = JSON.stringify(o); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    try {
      const M = window.SokoniMerchantSell, md = window.SokoniMerchantData;
      if (!M || !md) return out({ error: 'module absent' });

      const present = {
        locations: typeof window.SokoniBuyerLocations,
        fulfilment: typeof window.SokoniFulfilment,
        shift: typeof window.SokoniShift,
        cash: typeof window.SokoniCash,
        receipt: typeof window.SokoniReceiptDoc,
      };

      md.listProducts = () => Promise.resolve([
        { id: 'P1', productId: 'P1', name: 'Sugar', price: 300, stock: 20, image: '' },
      ]);

      const panel = document.getElementById('panel-sell') || (() => {
        const d = document.createElement('div');
        d.className = 'panel'; d.id = 'panel-sell';
        (document.querySelector('.main') || document.body).appendChild(d);
        return d;
      })();
      panel.classList.add('show', 'panel-scroll');
      panel.innerHTML = '';
      M.mount(panel, { scope: { ok: true, shopId: 'rig', sellerUid: 'rig' },
                       db: null, shopName: 'Rig', onToast: () => {} });
      await sleep(1300);

      const txt = () => (panel.textContent || '').replace(/\s+/g, ' ');
      const fire = (el, t) => el.dispatchEvent(new Event(t, { bubbles: true }));

      panel.querySelector('.msl-card').click(); await sleep(300);
      [].slice.call(panel.querySelectorAll('button'))
        .find((b) => /charge/i.test(b.textContent || '')).click();
      await sleep(400);

      /* Choose Deliver it */
      const del = [].slice.call(panel.querySelectorAll('[data-act="ful"]'))
        .find((b) => b.getAttribute('data-f') === 'delivery');
      if (!del) return out({ error: 'no delivery option', present });
      del.click(); await sleep(350);

      const field = panel.querySelector('#msl-dest');
      const hasField = !!field;
      if (!field) return out({ error: 'no destination field', present, snippet: txt().slice(0, 200) });

      field.value = 'Kilimani, Ngong Road, Nairobi';
      fire(field, 'input');
      await sleep(450);

      const t = txt();
      const saysUnavailable = /unavailable on this device/i.test(t);
      const acceptedDest = /going to/i.test(t);

      /* Complete sale must be reachable for a delivery WITH a destination. */
      const completeBtn = [].slice.call(panel.querySelectorAll('button'))
        .find((b) => /complete sale/i.test(b.textContent || ''));
      /* Cash not yet entered, so it is legitimately disabled — what matters is
         that the DESTINATION no longer blocks it. */
      const destBlocks = /not enough to deliver|somewhere to go/i.test(t);

      out({ present, hasField, saysUnavailable, acceptedDest, destBlocks,
            hasComplete: !!completeBtn, snippet: t.slice(0, 260) });
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
  await page.waitForFunction(() => document.body.dataset.delDiag !== undefined,
    null, { timeout: 40000, polling: 300 }).catch(() => {});
  const m = JSON.parse(await page.evaluate(() => document.body.dataset.delDiag || '{}'));

  const p = m.present || {};
  ck('D1 SokoniBuyerLocations is present at runtime',
    p.locations === 'object', 'typeof = ' + p.locations);
  ck('D2 SokoniFulfilment is present at runtime',
    p.fulfilment === 'object', 'typeof = ' + p.fulfilment);
  ck('D3 SokoniShift is present at runtime',
    p.shift === 'object', 'typeof = ' + p.shift);
  ck('D4 CONTROL the two that already worked are still present',
    p.cash === 'object' && p.receipt === 'object',
    'cash=' + p.cash + ' receipt=' + p.receipt);

  if (m.error) {
    ck('D5 the delivery flow could be driven', false, m.error);
  } else {
    ck('D5 choosing Deliver it offers a destination field',
      m.hasField, 'the field the merchant types into');
    ck('D6 the reported bug is GONE — no "unavailable on this device"',
      !m.saysUnavailable, m.saysUnavailable ? 'STILL SAYS IT: ' + m.snippet : 'message absent');
    ck('D7 a typed destination is ACCEPTED and echoed back',
      m.acceptedDest, m.snippet);
    ck('D8 the destination no longer blocks completing the sale',
      !m.destBlocks, 'a delivery with an address is chargeable');
  }

  const passed = rows.filter((r) => r.ok).length;
  return {
    verdict: passed + '/' + rows.length + ' passed',
    failed: rows.filter((r) => !r.ok).map((r) => r.label + '  [' + r.detail + ']'),
  };
}
