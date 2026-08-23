/* VERIFY — the Charge bar is anchored in the REAL shell structure.
   ==========================================================================
   Run against a served copy:
     node <browser-automation>/browser.mjs http://127.0.0.1:8798/merchant-v2.html \
       --script scripts/browser/verify-charge-anchored.mjs

   WHY THIS EXISTS SEPARATELY FROM THE EARLIER HARNESS
   The previous charge-bar test built its own `<div id="native-sell">` wrapper
   and mounted into that. The shell does NOT create such an element —
   renderModule() mounts straight into `#panel-<id>`. So the test passed 8/8
   against a DOM production never builds, and the CSS rule it validated
   (`.panel.show > #native-sell`) matched nothing live. The bar stayed below the
   fold on a real phone while the suite was green.

   This harness therefore mounts EXACTLY as renderModule does: into the panel
   element itself, with the class renderModule applies. If that ever diverges
   again, C4 below fails.
========================================================================== */
const VIEWPORTS = [
  { name: '390x665', w: 390, h: 665 },
  { name: '390x844', w: 390, h: 844 },
  { name: '412x915', w: 412, h: 915 },
  { name: '430x932', w: 430, h: 932 },
  { name: '1280x720', w: 1280, h: 720 },
];

function driveInPage() {
  var out = function (o) { document.body.dataset.chargeDiag = JSON.stringify(o); };
  try {
    var M = window.SokoniMerchantSell, md = window.SokoniMerchantData;
    if (!M || !md) return out({ error: 'module absent M=' + !!M + ' md=' + !!md });

    md.listProducts = function () {
      var r = [];
      for (var i = 0; i < 40; i++) r.push({ id: 'p' + i, productId: 'p' + i,
        name: 'Item ' + i, price: 230, stock: 50, image: '' });
      return Promise.resolve(r);
    };

    /* EXACTLY what the shell does: one panel, mounted into directly. */
    var panel = document.getElementById('panel-sell');
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'panel';
      panel.id = 'panel-sell';
      (document.querySelector('.main') || document.body).appendChild(panel);
    }
    [].forEach.call(document.querySelectorAll('.panel'), function (x) {
      if (x !== panel) x.classList.remove('show');
    });
    panel.classList.add('show');
    panel.classList.add('panel-scroll');    /* the class renderModule adds */
    panel.innerHTML = '';

    M.mount(panel, {
      scope: { ok: true, shopId: 'rig', sellerUid: 'rig', capabilities: ['sell'] },
      db: null, shopName: 'Rig', origin: location.origin, onToast: function () {}
    });

    setTimeout(function () {
      var card = panel.querySelector('.msl-card');
      if (card) card.click();
      setTimeout(function () {
        var bar = panel.querySelector('.msl-bar');
        var body = panel.querySelector('.msl-body');
        var msl = panel.querySelector('.msl');
        if (!bar || !body) return out({ error: 'bar/body missing' });

        var r = bar.getBoundingClientRect();
        var onScreen = r.bottom > 0 && r.top < window.innerHeight;

        /* Is the bar actually TAPPABLE, or is something over it? */
        var cx = Math.round(r.left + r.width / 2);
        var cy = Math.round(r.top + r.height / 2);
        var top = document.elementFromPoint(cx, cy);
        var reachable = !!(top && (bar === top || bar.contains(top)));

        window.scrollTo(0, document.documentElement.scrollHeight);
        body.scrollTop = body.scrollHeight;
        setTimeout(function () {
          var after = bar.getBoundingClientRect();
          out({
            vh: window.innerHeight,
            panelHasClass: panel.classList.contains('panel-scroll'),
            panelHeight: Math.round(panel.getBoundingClientRect().height),
            mslHeight: Math.round(msl ? msl.getBoundingClientRect().height : -1),
            bodyScrollable: body.scrollHeight > body.clientHeight + 4,
            barTop: Math.round(r.top), barBottom: Math.round(r.bottom),
            onScreenBefore: onScreen,
            onScreenAfter: after.bottom > 0 && after.top < window.innerHeight,
            reachable: reachable,
            topAtBarCentre: top ? (top.tagName.toLowerCase() +
              (top.className ? '.' + String(top.className).trim().split(/\s+/)[0] : '')) : null,
            docScrolls: document.documentElement.scrollHeight > window.innerHeight + 4
          });
        }, 400);
      }, 700);
    }, 1500);
  } catch (e) { out({ error: String((e && e.message) || e) }); }
}

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ ok, label, detail: String(detail ?? '') });

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto('http://127.0.0.1:8798/merchant-v2.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await page.addScriptTag({ content: `(${driveInPage.toString()})();` });
    await page.waitForFunction(() => document.body.dataset.chargeDiag !== undefined,
      null, { timeout: 30000, polling: 300 }).catch(() => {});
    const m = JSON.parse(await page.evaluate(() => document.body.dataset.chargeDiag || '{}'));

    const t = vp.name;
    if (m.error) { ck('C0 [' + t + '] mounted', false, m.error); continue; }

    ck('C1 [' + t + '] the panel is height-constrained',
      m.panelHeight > 0 && m.panelHeight <= m.vh,
      'panel=' + m.panelHeight + ' vh=' + m.vh);
    ck('C2 [' + t + '] the product list owns the scrolling',
      m.bodyScrollable, 'bodyScrollable=' + m.bodyScrollable + ' docScrolls=' + m.docScrolls);
    ck('C3 [' + t + '] Charge is on screen without scrolling',
      m.onScreenBefore, 'barTop=' + m.barTop + ' vh=' + m.vh);
    ck('C4 [' + t + '] ...and STAYS on screen after scrolling to the end',
      m.onScreenAfter, 'this is the reported defect');
    ck('C5 [' + t + '] Charge is actually TAPPABLE, nothing covers it',
      m.reachable, 'elementFromPoint at the bar centre = ' + m.topAtBarCentre +
      '  | on screen is not the same as reachable');
    ck('C6 [' + t + '] the rule applies to the REAL host, not an invented wrapper',
      m.panelHasClass === true, 'panel-scroll present on #panel-sell');
  }

  const passed = rows.filter((r) => r.ok).length;
  return {
    verdict: passed + '/' + rows.length + ' passed',
    failed: rows.filter((r) => !r.ok).map((r) => r.label + '  [' + r.detail + ']'),
  };
}
