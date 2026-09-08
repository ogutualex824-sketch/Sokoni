#!/usr/bin/env node
/* The product-card action buttons, MEASURED and ASSERTED at real viewport widths.
 *
 *   node scripts/test-product-card-buttons.js
 *
 * WHY THIS EXISTS
 * ---------------
 * "The buttons are hiding towards the right side of the cards" is a geometric claim, and
 * geometry is measurable. Reading the CSS tells you what the rules SAY; it cannot tell you
 * what a card 152px wide actually does with three buttons, two of which have a fixed 40px
 * width and a `!important` flex-shrink of 0.
 *
 * It drives the REAL renderer (`buildProductCard`) inside the REAL index page, so every
 * stylesheet loads in its real order and the cascade is the shipped one. A hand-built probe
 * page would measure a cascade nobody ships.
 *
 * WHAT IT ENFORCES, at every breakpoint
 *   1  the card has NO "Buy Now" — the card itself opens the product page, which owns the
 *      purchase. A second Buy was also the third control in a row with space for two.
 *   2  exactly ONE action block is visible. The card emits two (.pcard-actions and
 *      .pcard-mobile-strip) and CSS used to pick differently per width — the strip below
 *      768px, the actions block in the side rails, and NEITHER in the main feed on desktop.
 *   3  nothing overflows the card. The original complaint, and it was real: 96px of overhang
 *      at 320px, clipped by the card's overflow:hidden.
 *   4  the two buttons are the SAME width, to the pixel.
 *   5  the row is centred — equal slack either side.
 *   6  every button keeps the 44px WCAG 2.5.5 touch target from sokoni-quality.css.
 *
 * WHAT IT REPORTS, per breakpoint
 *   · which action container is VISIBLE (the card emits two, and CSS picks)
 *   · every visible button's box, and whether it overflows the card's content edge
 *   · the free space left over in the row — negative means the row cannot fit
 *   · whether the row is centred (equal slack either side)
 *
 * OVERFLOW IS MEASURED AGAINST THE PADDING BOX, not the border box: a button sitting inside
 * the card's border but underneath its padding is still visually crammed against the edge,
 * which is exactly the complaint.
 */
'use strict';
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.png':'image/png', '.json':'application/json', '.svg':'image/svg+xml', '.jpg':'image/jpeg',
  '.webp':'image/webp', '.ico':'image/x-icon', '.woff2':'font/woff2' };

/* The widths that matter: each is inside a DIFFERENT grid/media branch of compact-grid.css. */
const VIEWPORTS = [
  { w: 320,  h: 720,  label: '320  very small phone   (<360 branch)' },
  { w: 390,  h: 844,  label: '390  phone              (<=600 branch)' },
  { w: 600,  h: 900,  label: '600  large phone        (<=600 boundary)' },
  { w: 700,  h: 900,  label: '700  small tablet       (601-767 branch)' },
  { w: 820,  h: 1000, label: '820  tablet             (601-900 grid, no strip)' },
  { w: 1024, h: 900,  label: '1024 small laptop       (901-1279 grid)' },
  { w: 1440, h: 900,  label: '1440 desktop            (>=1280 grid)' },
];

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (!path.extname(p)) p += '.html';
  fs.readFile(path.join(ROOT, p), (e, d) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'text/plain' });
    res.end(d);
  });
});

const PRODUCTS = [
  { id: 'P1', name: 'Samsung Galaxy A54 5G 128GB Awesome Graphite', price: 32999,
    category: 'electronics', image: '', stock: 12, sellerName: 'Nairobi Tech Hub', soldCount: 41 },
  { id: 'P2', name: 'Nike Air Max', price: 8500, category: 'shoes', image: '',
    stock: 3, sellerName: 'SoleMate', wishlistCount: 9 },
];

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('    ' + (ok ? 'PASS  ' : 'FAIL  ') + label +
    (detail !== undefined && detail !== '' ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

(async () => {
  const BASE = await new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port)));
  const browser = await chromium.launch();
  let worst = 0, rows = 0;

  try {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      const page = await ctx.newPage();
      page.on('pageerror', () => {});               /* Firebase will not connect; irrelevant here */
      await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 45000 });

      /* The renderer must exist, or every measurement below would be of an empty container —
         a silent pass. Reported explicitly. */
      const ready = await page.waitForFunction(
        () => typeof window.buildProductCard === 'function', null, { timeout: 20000 }
      ).then(() => true).catch(() => false);
      if (!ready) {
        console.log('\n' + vp.label + '\n  CANNOT MEASURE — buildProductCard never became available');
        await ctx.close(); continue;
      }

      const out = await page.evaluate((products) => {
        const host = document.getElementById('productsContainer');
        if (!host) return { error: 'no #productsContainer' };
        host.innerHTML = products.map((p) => window.buildProductCard(p)).join('');
        const card = host.querySelector('.product-card');
        if (!card) return { error: 'no card rendered' };

        const vis = (el) => {
          const s = getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
        };
        const cs = getComputedStyle(card);
        const cr = card.getBoundingClientRect();
        /* PADDING BOX — the edge content is actually allowed to touch. */
        const inner = {
          left: cr.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth),
          right: cr.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth),
        };
        inner.width = inner.right - inner.left;

        const containers = ['.pcard-actions', '.pcard-mobile-strip']
          .map((sel) => { const el = card.querySelector(sel); return el ? { sel, el } : null; })
          .filter(Boolean);
        const visibleContainers = containers.filter((c) => vis(c.el)).map((c) => c.sel);

        const btns = [...card.querySelectorAll('button')].filter(vis).map((b) => {
          const r = b.getBoundingClientRect();
          return {
            cls: b.className.split(/\s+/).filter((c) => /^pcard/.test(c)).join(' ') || b.className,
            label: (b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 14),
            left: Math.round(r.left - inner.left),
            right: Math.round(inner.right - r.right),
            w: Math.round(r.width), h: Math.round(r.height),
            overflowRight: Math.round(r.right - inner.right),
            overflowLeft: Math.round(inner.left - r.left),
            clipped: r.width < 1 || r.height < 1,
          };
        });

        /* Row geometry: how much slack is left, and is it shared evenly either side? */
        let row = null;
        /* Only a VISIBLE row. The card emits .pcard-row inside the hidden .pcard-actions
           block, and it appears FIRST in document order — a plain querySelector picked that
           one, found it invisible, and reported "no button row" on every viewport while the
           real row sat right below it. */
        const rowEl = [...card.querySelectorAll('.pcard-m-btns, .pcard-row')].find(vis) || null;
        if (rowEl) {
          const rr = rowEl.getBoundingClientRect();
          const kids = [...rowEl.children].filter(vis).map((k) => k.getBoundingClientRect());
          const used = kids.reduce((a, k) => a + k.width, 0);
          const rs = getComputedStyle(rowEl);
          const gap = parseFloat(rs.columnGap || rs.gap) || 0;
          row = {
            rowW: Math.round(rr.width),
            used: Math.round(used + gap * Math.max(0, kids.length - 1)),
            slackLeft: kids.length ? Math.round(kids[0].left - rr.left) : null,
            slackRight: kids.length ? Math.round(rr.right - kids[kids.length - 1].right) : null,
            justify: rs.justifyContent,
            absL: Math.round(rr.left), absR: Math.round(rr.right),
            stripPad: getComputedStyle(rowEl.parentElement).padding,
          };
          row.free = row.rowW - row.used;
        }

        return {
          pad: cs.padding, bord: cs.borderLeftWidth,
          cardW: Math.round(cr.width), innerW: Math.round(inner.width),
          cardAbsL: Math.round(cr.left), cardAbsR: Math.round(cr.right),
          visibleContainers, btns, row,
          buyButtons: [...card.querySelectorAll('[data-action="buy"]')].filter(vis).length,
          buyInDom: card.querySelectorAll('[data-action="buy"]').length,
        };
      }, PRODUCTS);

      console.log('\n' + vp.label);
      if (out.error) { console.log('  ERROR: ' + out.error); await ctx.close(); continue; }
      console.log('  card ' + out.cardW + 'px [' + out.cardAbsL + '..' + out.cardAbsR + ']  (content ' + out.innerW + 'px, pad ' + out.pad + ', border ' + out.bord + ')   block: '
        + (out.visibleContainers.join(', ') || 'NONE'));
      console.log('  buy buttons: ' + out.buyInDom + ' in DOM, ' + out.buyButtons + ' visible');
      if (!out.btns.length) console.log('    (no visible buttons on the card)');
      for (const b of out.btns) {
        const flags = [];
        if (b.overflowRight > 0) flags.push('OVERFLOWS RIGHT by ' + b.overflowRight + 'px');
        if (b.overflowLeft > 0) flags.push('OVERFLOWS LEFT by ' + b.overflowLeft + 'px');
        if (b.clipped) flags.push('COLLAPSED');
        if (b.overflowRight > worst) worst = b.overflowRight;
        console.log('    ' + String(b.w).padStart(4) + 'x' + String(b.h).padEnd(3)
          + ' L' + String(b.left).padStart(4) + ' R' + String(b.right).padStart(4)
          + '  ' + (b.label || '·').padEnd(15) + b.cls
          + (flags.length ? '   << ' + flags.join(', ') : ''));
      }
      /* ── ASSERTIONS ── */
      const W = vp.w + 'px';
      ck(W + ' the card carries no Buy Now at all', out.buyInDom === 0, out.buyInDom + ' in DOM');
      ck(W + ' exactly one action block is visible',
         out.visibleContainers.length === 1, out.visibleContainers.join('+') || 'NONE');
      ck(W + ' the action buttons are present', out.btns.length === 2, out.btns.length + ' buttons');
      ck(W + ' nothing overflows the card',
         out.btns.every((b) => b.overflowRight <= 0 && b.overflowLeft <= 0),
         out.btns.map((b) => b.overflowRight).join('/'));
      ck(W + ' the two buttons are the same width',
         out.btns.length === 2 && out.btns[0].w === out.btns[1].w,
         out.btns.map((b) => b.w).join(' vs '));
      ck(W + ' every button keeps the 44px touch target',
         out.btns.every((b) => b.h >= 44), out.btns.map((b) => b.h).join('/'));
      ck(W + ' the row is centred in the card',
         out.btns.length === 2 && Math.abs(out.btns[0].left - out.btns[1].right) <= 1,
         'L' + (out.btns[0] || {}).left + ' / R' + (out.btns[1] || {}).right);

      if (out.row) {
        rows++;
        ck(W + ' the row fills its track exactly — no dead space, no overhang',
           out.row.free === 0, 'free ' + out.row.free + 'px');
        ck(W + ' ...and the buttons sit flush inside it',
           out.row.slackLeft === 0 && out.row.slackRight === 0,
           'slack L' + out.row.slackLeft + '/R' + out.row.slackRight);
        console.log('    row ' + out.row.rowW + 'px [' + out.row.absL + '..' + out.row.absR + '] stripPad ' + out.row.stripPad + ', children use ' + out.row.used
          + 'px, free ' + out.row.free + 'px, slack L' + out.row.slackLeft
          + '/R' + out.row.slackRight + ', justify:' + out.row.justify
          + (out.row.free < 0 ? '   << ROW CANNOT FIT' : ''));
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  /* A run that measured NOTHING must not look like a clean run: if the renderer never
     appeared, or every viewport failed to produce a row, the per-viewport assertions above
     would simply not have run and the suite would exit 0 having proved nothing. */
  ck('every viewport produced a measurable button row', rows === VIEWPORTS.length,
     rows + '/' + VIEWPORTS.length);
  ck('the suite actually asserted something', pass + fail >= VIEWPORTS.length * 9,
     (pass + fail) + ' assertions');

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed   (worst right-overflow '
    + worst + 'px across ' + VIEWPORTS.length + ' viewports)\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
