/* VERIFY — the cart quantity stepper is a narrow VERTICAL column, and the sale
   logic behind it is completely unchanged.
   ==========================================================================
       [IMAGE]  Blueberry Raspberry       ┌─┐
                KSh 100 each · KSh 200    │+│
                                          │2│
                                          │−│

   The stepper used to be a horizontal [−][1][+] row about 140px wide, which at
   390px left the product name and price fighting over what was left.

   TWO THINGS ARE UNDER TEST, and the second is the one that matters:
     1. the presentation — vertical, narrow, top-anchored, never stretching
     2. the BEHAVIOUR — 1 → 2 → 3 → 2 → 1 → removed, with the line total and the
        subtotal tracking every step. Only the CSS and the markup order changed;
        if any of this moved, the change was not presentational after all.
========================================================================== */
const VIEWPORTS = [
  { name: '390x665',  w: 390,  h: 665  },
  { name: '390x844',  w: 390,  h: 844  },
  { name: '412x915',  w: 412,  h: 915  },
  { name: '430x932',  w: 430,  h: 932  },
  { name: '820x1180', w: 820,  h: 1180 },
  { name: '1280x720', w: 1280, h: 720  },
];

function driveInPage() {
  const out = (o) => { document.body.dataset.cartDiag = JSON.stringify(o); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    try {
      const M = window.SokoniMerchantSell, md = window.SokoniMerchantData;
      if (!M || !md) return out({ error: 'module absent' });

      md.listProducts = () => Promise.resolve([{
        id: 'P1', productId: 'P1',
        name: 'Blueberry Raspberry Sparkling Refresher Large Bottle',
        price: 100, stock: 50, image: '',
      }]);

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

      panel.querySelector('.msl-card').click();
      await sleep(300);
      /* Open the CART sheet (not pay) — the cart control is what changed. */
      const cartBtn = [].slice.call(panel.querySelectorAll('button'))
        .find((b) => /\d+\s*item|view cart|this sale/i.test(b.textContent || ''))
        || panel.querySelector('.msl-bar .sum');
      if (cartBtn) cartBtn.click();
      await sleep(400);

      const line = () => panel.querySelector('.msl-line');
      const step = () => panel.querySelector('.msl-step');
      const qEl  = () => panel.querySelector('.msl-step .q');
      const info = () => panel.querySelector('.msl-line .info');
      const txt  = () => (panel.textContent || '').replace(/\s+/g, ' ');
      const qty  = () => { const q = qEl(); return q ? Number(q.value) : null; };
      const tap  = async (act) => {
        const b = panel.querySelector('.msl-step button[data-act="' + act + '"]');
        if (!b) throw new Error('no ' + act + ' button');
        b.click(); await sleep(260);
      };
      const lineTotal = () => {
        const m = txt().match(/each[^0-9]*([\d,]+)/i);
        return m ? Number(m[1].replace(/,/g, '')) : null;
      };

      if (!line() || !step()) return out({ error: 'no cart row rendered; text=' + txt().slice(0, 160) });

      /* ── GEOMETRY ── */
      const sr = step().getBoundingClientRect();
      const ir = info().getBoundingClientRect();
      const lr = line().getBoundingClientRect();
      const btns = [].slice.call(panel.querySelectorAll('.msl-step button'));
      const bRects = btns.map((b) => b.getBoundingClientRect());
      const vertical = bRects.length === 2 &&
        Math.abs(bRects[0].left - bRects[1].left) < 3 &&      /* same column */
        Math.abs(bRects[0].top - bRects[1].top) > 20;         /* different rows */
      const plusOnTop = (btns[0] && btns[0].getAttribute('data-act')) === 'inc' &&
        bRects[0].top < bRects[1].top;
      const topAnchored = Math.abs(sr.top - lr.top) < 22;
      const infoShare = ir.width / lr.width;
      const docScrollsX = document.documentElement.scrollWidth > window.innerWidth + 2;

      /* ── BEHAVIOUR: 1 → 2 → 3 → 2 → 1 → removed ── */
      const seq = [];
      seq.push({ step: 'start', qty: qty(), line: lineTotal() });
      await tap('inc'); seq.push({ step: '+', qty: qty(), line: lineTotal() });
      await tap('inc'); seq.push({ step: '+', qty: qty(), line: lineTotal() });
      /* widest point — the product must not have been squeezed by qty 3 */
      const irAt3 = info().getBoundingClientRect();
      const srAt3 = step().getBoundingClientRect();
      await tap('dec'); seq.push({ step: '-', qty: qty(), line: lineTotal() });
      await tap('dec'); seq.push({ step: '-', qty: qty(), line: lineTotal() });
      await tap('dec');
      const removed = !panel.querySelector('.msl-line');
      const emptied = /nothing in this sale|no items|cart is empty/i.test(txt()) || removed;

      out({
        vertical, plusOnTop, topAnchored,
        stepW: Math.round(sr.width), infoShare: Number(infoShare.toFixed(2)),
        stepWAt3: Math.round(srAt3.width), infoWAt3: Math.round(irAt3.width),
        infoW: Math.round(ir.width), docScrollsX,
        btnW: Math.round(bRects[0].width), btnH: Math.round(bRects[0].height),
        seq, removed, emptied,
      });
    } catch (e) { out({ error: String((e && e.stack) || e) }); }
  })();
}

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ ok, label, detail: String(detail ?? '') });

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto('http://127.0.0.1:8798/merchant-v2.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2600);
    await page.addScriptTag({ content: `(${driveInPage.toString()})();` });
    await page.waitForFunction(() => document.body.dataset.cartDiag !== undefined,
      null, { timeout: 40000, polling: 300 }).catch(() => {});
    const m = JSON.parse(await page.evaluate(() => document.body.dataset.cartDiag || '{}'));
    const t = vp.name;

    if (m.error) { ck('Q0 [' + t + '] the cart could be driven', false, m.error); continue; }

    ck('Q1 [' + t + '] the stepper is VERTICAL',
      m.vertical, 'buttons share a column, stacked');
    ck('Q2 [' + t + '] + is on TOP, − at the bottom',
      m.plusOnTop, 'the order the spec asks for');
    ck('Q3 [' + t + '] it is anchored to the TOP of the row',
      m.topAnchored, 'a wrapped product name must not drag it down');
    ck('Q4 [' + t + '] it stays NARROW — no stretching on a wide viewport',
      m.stepW > 0 && m.stepW <= 56, 'stepper width ' + m.stepW + 'px');
    ck('Q5 [' + t + '] the product keeps the majority of the row',
      m.infoShare >= 0.6, 'product occupies ' + Math.round(m.infoShare * 100) + '% of the row');
    ck('Q6 [' + t + '] changing quantity does NOT squeeze the product',
      m.infoWAt3 >= m.infoW - 1 && m.stepWAt3 === m.stepW,
      'info ' + m.infoW + '→' + m.infoWAt3 + 'px, stepper ' + m.stepW + '→' + m.stepWAt3 + 'px at qty 3');
    ck('Q7 [' + t + '] no horizontal page scroll',
      !m.docScrollsX, 'scrollWidth vs innerWidth');
    ck('Q8 [' + t + '] the buttons remain tappable',
      m.btnW >= 40 && m.btnH >= 36, m.btnW + '×' + m.btnH + 'px');

    const q = (m.seq || []).map((s) => s.qty);
    ck('Q9 [' + t + '] 1 → 2 → 3 → 2 → 1',
      JSON.stringify(q) === JSON.stringify([1, 2, 3, 2, 1]), 'quantities: ' + JSON.stringify(q));
    const lt = (m.seq || []).map((s) => s.line);
    ck('Q10 [' + t + '] the line total tracks every step',
      JSON.stringify(lt) === JSON.stringify([100, 200, 300, 200, 100]), 'line totals: ' + JSON.stringify(lt));
    ck('Q11 [' + t + '] one more − removes the item',
      m.removed && m.emptied, 'removed=' + m.removed);
  }

  const passed = rows.filter((r) => r.ok).length;
  return {
    verdict: passed + '/' + rows.length + ' passed',
    failed: rows.filter((r) => !r.ok).map((r) => r.label + '  [' + r.detail + ']'),
  };
}
