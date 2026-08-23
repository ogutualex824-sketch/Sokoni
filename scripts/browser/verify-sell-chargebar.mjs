/* VERIFY — the Quick Sell charge bar stays on screen while products scroll.
   ==========================================================================
   Run against a served copy of the worktree:
     node <browser-automation>/browser.mjs http://127.0.0.1:8791/merchant-v2.html \
       --script scripts/browser/verify-sell-chargebar.mjs

   WHY IT MOUNTS INTO THE REAL PANEL
   The module's own layout is correct in isolation — .msl is a full-height flex
   column, .msl-body is the flex:1 scroller, .msl-bar is flex:0 0 auto. A prior
   pass certified exactly that and concluded "already correct, no product change".

   The defect is not in the module, it is in what CONTAINS it: `.panel.show`
   is display:block with auto height, so `.msl{height:100%}` resolves against an
   auto-height ancestor and becomes auto. The column then grows to content, the
   body scroller never engages, and the bar leaves the viewport.

   So this mounts into the real `.panel` chain rather than a synthetic host. A
   synthetic host would recreate the constrained case and certify the bug away —
   which is how the previous pass reported green while a phone had to scroll to
   find Charge.

   IT ALSO POPULATES THE CART. `.msl-bar.empty{display:none}` hides the bar when
   the cart is empty, so a run that never adds an item measures a hidden element
   and proves nothing.
========================================================================== */
const VIEWPORTS = [
  { name: '390x844', w: 390, h: 844 },
  { name: '412x915', w: 412, h: 915 },
];

/* Runs in the PAGE's main world (injected via addScriptTag), so it can reach
   window.SokoniMerchantSell. Hands its result back on document.body.dataset,
   which the isolated world can read. */
function measureInPage() {
  var out = function (o) { document.body.dataset.sellDiag = JSON.stringify(o); };
  try {
    var M = window.SokoniMerchantSell, md = window.SokoniMerchantData;
    if (!M || !md) return out({ error: 'module absent: M=' + !!M + ' md=' + !!md });

    /* Stub the data authority ONLY — the LAYOUT is under test, and a real fetch
       would need auth this harness must never fake. */
    md.listProducts = function () {
      var rows = [];
      for (var i = 0; i < 40; i++) rows.push({
        id: 'p' + i, productId: 'p' + i, name: 'Test product ' + i,
        price: 100 + i, stock: 50, image: '',
      });
      return Promise.resolve(rows);
    };

    /* Build the host exactly as the shell does: a .panel.show wrapper, so the
       real container chain — and its display:block — is what gets measured. */
    var panel = document.getElementById('panel-sell');
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'panel';
      panel.id = 'panel-sell';
      (document.querySelector('main') || document.body).appendChild(panel);
    }
    /* Mirror showOnly(): the shell displays exactly ONE panel. Appending a new
       panel while other content stays visible above it pushes the module down
       the document and reads as "the bar is off screen" when the real cause is
       the harness. Hide everything else first. */
    [].forEach.call(document.querySelectorAll('.panel'), function (p) {
      if (p !== panel) p.classList.remove('show');
    });
    [].forEach.call(document.querySelectorAll('.main > *'), function (n) {
      if (n !== panel && !n.classList.contains('panel')) n.style.display = 'none';
    });
    window.scrollTo(0, 0);

    panel.classList.add('show');
    panel.innerHTML = '<div id="native-sell"></div>';
    var host = panel.querySelector('#native-sell');

    M.mount(host, {
      scope: { ok: true, shopId: 'testshop', sellerUid: 'testuid', capabilities: ['sell'] },
      db: null, shopName: 'Test Shop', origin: location.origin, onToast: function () {},
    });

    setTimeout(function () {
      /* Put something in the cart, or .msl-bar.empty hides the bar. */
      var card = host.querySelector('.msl-card');
      if (card) card.click();

      setTimeout(function () {
        var body = host.querySelector('.msl-body');
        var bar = host.querySelector('.msl-bar');
        var msl = host.querySelector('.msl');
        if (!bar || !body) return out({ error: 'bar/body missing', hasBar: !!bar, hasBody: !!body });

        var before = bar.getBoundingClientRect();
        var barHidden = getComputedStyle(bar).display === 'none';

        window.scrollTo(0, document.documentElement.scrollHeight);
        body.scrollTop = body.scrollHeight;

        setTimeout(function () {
          var after = bar.getBoundingClientRect();
          out({
            vh: window.innerHeight,
            mslHeight: Math.round(msl ? msl.getBoundingClientRect().height : -1),
            bodyScrollable: body.scrollHeight > body.clientHeight + 4,
            docScrolls: document.documentElement.scrollHeight > window.innerHeight + 4,
            barHidden: barHidden,
            cartCount: (host.querySelector('.msl-bar .n') || {}).textContent || '',
            beforeTop: Math.round(before.top), beforeBottom: Math.round(before.bottom),
            afterTop: Math.round(after.top), afterBottom: Math.round(after.bottom),
            onScreenBefore: before.bottom > 0 && before.top < window.innerHeight,
            onScreenAfter: after.bottom > 0 && after.top < window.innerHeight,
          });
        }, 500);
      }, 800);
    }, 1500);
  } catch (e) { out({ error: String((e && e.message) || e) }); }
}

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ ok, label, detail: String(detail ?? '') });
  const out = [];

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto('http://127.0.0.1:8791/merchant-v2.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);

    /* MAIN WORLD, via addScriptTag. page.evaluate runs in an ISOLATED world that
       shares the DOM but not window globals, so it can never see
       SokoniMerchantSell — an earlier version reported "module absent" for
       exactly that reason and would have been read as a product defect. The
       result is handed back through a DOM attribute, which IS shared. */
    await page.addScriptTag({ content: `(${measureInPage.toString()})();` });
    await page.waitForFunction(() => document.body.dataset.sellDiag !== undefined, null, { timeout: 30000, polling: 300 })
      .catch(() => {});
    const measured = JSON.parse(await page.evaluate(() => document.body.dataset.sellDiag || '{"error":"no result"}'));

    out.push({ viewport: vp.name, measured });

    if (measured.error) {
      ck('S1 [' + vp.name + '] the module mounted', false, measured.error);
      continue;
    }

    ck('S1 [' + vp.name + '] CONTROL the cart is populated, so the bar is not display:none',
      !measured.barHidden,
      'barHidden=' + measured.barHidden + ' cart="' + measured.cartCount + '"' +
      '  | .msl-bar.empty{display:none} would make this measure a hidden node');

    ck('S2 [' + vp.name + '] the product list scrolls INSIDE its own body',
      measured.bodyScrollable,
      'bodyScrollable=' + measured.bodyScrollable + ' docScrolls=' + measured.docScrolls +
      '  | if the document scrolls instead, the panel has no definite height');

    ck('S3 [' + vp.name + '] the charge bar is on screen BEFORE scrolling',
      measured.onScreenBefore, 'top=' + measured.beforeTop + ' bottom=' + measured.beforeBottom +
      ' vh=' + measured.vh);

    ck('S4 [' + vp.name + '] the charge bar is STILL on screen after scrolling to the end',
      measured.onScreenAfter, 'top=' + measured.afterTop + ' bottom=' + measured.afterBottom +
      ' vh=' + measured.vh + '  | this is the reported defect: Charge has to be hunted for');
  }

  const passed = rows.filter((r) => r.ok).length;
  return {
    verdict: passed + '/' + rows.length + ' passed',
    failed: rows.filter((r) => !r.ok).map((r) => r.label + '  [' + r.detail + ']'),
    measured: out,
  };
}
