'use strict';
/* Admin OS mobile-adoption probe. Verifies the responsive adoption of admin-os.html:
   sokoni-admin-responsive.css transforms .aos-table rows into labelled cards below
   768px, floors Admin OS control tap targets to 44px, sizes inputs to 16px, and the
   runtime data-label stamper (sokoni-aos.js) labels cells from each table's <th>.
   admin-os.html itself is auth-walled (admin claim), so this exercises the exact CSS
   + stamper against a representative .aos-table at 375/393/412/768 + a 1200px desktop
   control — no admin credentials required. Run: node scripts/probe-admin-os-mobile.js
*/
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require('playwright');
const fw = (s) => s.split(path.sep).join('/');                 /* Windows path -> file URL */
const CSS = 'file:///' + fw(path.join(ROOT, 'sokoni-admin-responsive.css'));
const HARNESS = path.join(ROOT, '_admin-os-mobile-harness.html');

const html = '<!doctype html><html><head>'
  + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
  + '<style>body{background:#0a0a0a;color:#fff;margin:0;font-family:system-ui}.aos-main{padding:12px}'
  + '.aos-table{width:100%;border-collapse:collapse;font-size:13px}.aos-table th{text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase}'
  + '.aos-table td{padding:10px 12px}input{background:#111;color:#fff;border:1px solid #333;padding:6px}'
  + '.aos-btn-sm{padding:6px 10px;background:#71ff00;border:none;border-radius:8px}</style>'
  + '<link rel="stylesheet" href="' + CSS + '"></head><body><div class="aos-main">'
  + '<input type="search" id="s" placeholder="Filter">'
  + '<table class="aos-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead>'
  + '<tbody><tr><td>Alice Wanjiku</td><td>alice@example.com</td><td>seller</td><td>active</td><td>2026-01-01</td><td><button class="aos-btn-sm">Edit</button></td></tr>'
  + '<tr><td colspan="6" class="empty-cell">Loading</td></tr></tbody></table></div>'
  + '<script>(function(){document.querySelectorAll("table.aos-table").forEach(function(t){'
  + 'var h=Array.from(t.querySelectorAll("thead th")).map(function(x){return (x.textContent||"").trim();});if(!h.length)return;'
  + 't.querySelectorAll("tbody tr").forEach(function(r){var c=r.children;if(c.length!==h.length)return;'
  + 'for(var i=0;i<c.length;i++){if(c[i].tagName==="TD"&&h[i]&&!c[i].hasAttribute("data-label"))c[i].setAttribute("data-label",h[i]);}});});})();</script>'
  + '</body></html>';

(async () => {
  fs.writeFileSync(HARNESS, html);
  const url = 'file:///' + fw(HARNESS);
  const b = await chromium.launch();
  const cases = [{ w: 375, m: 1 }, { w: 393, m: 1 }, { w: 412, m: 1 }, { w: 768, m: 1 }, { w: 1200, m: 0 }];
  let fail = 0;
  for (const c of cases) {
    const ctx = await b.newContext({ viewport: { width: c.w, height: 820 }, isMobile: !!c.m, hasTouch: !!c.m, deviceScaleFactor: c.m ? 3 : 1 });
    const p = await ctx.newPage();
    await p.goto(url, { waitUntil: 'load' });
    const r = await p.evaluate(() => {
      const cs = getComputedStyle;
      const tr = document.querySelector('.aos-table tbody tr');
      const td = document.querySelector('.aos-table tbody td');
      const btn = document.querySelector('.aos-btn-sm');
      const inp = document.querySelector('#s');
      const e = document.querySelector('.empty-cell');
      return { row: cs(tr).display, label: td.getAttribute('data-label'), tap: btn.getBoundingClientRect().height,
               font: parseFloat(cs(inp).fontSize), of: Math.max(0, document.documentElement.scrollWidth - window.innerWidth), eLab: e.hasAttribute('data-label') };
    });
    await ctx.close();
    const card = c.m ? r.row === 'block' : r.row !== 'block';
    const noOf = r.of <= 1, tap = c.m ? r.tap >= 44 : true, in16 = c.m ? r.font >= 16 : true, lab = r.label === 'Name', eOK = !r.eLab;
    const ok = card && noOf && tap && in16 && lab && eOK; if (!ok) fail++;
    console.log('  ' + String(c.w).padStart(4) + 'px ' + (c.m ? '(touch)  ' : '(desktop)') + ': card=' + r.row + (card ? '✓' : '✗')
      + ' overflow=' + r.of + (noOf ? '✓' : '✗') + ' tap=' + r.tap.toFixed(0) + (tap ? '✓' : '✗')
      + ' input=' + r.font + (in16 ? '✓' : '✗') + ' label=' + r.label + (lab ? '✓' : '✗') + ' emptySkip=' + (eOK ? '✓' : '✗'));
  }
  await b.close();
  try { fs.unlinkSync(HARNESS); } catch (_) {}
  console.log('\nadmin-os-mobile: ' + (fail === 0 ? 'PASS ' + cases.length + '/' + cases.length : fail + ' FAIL of ' + cases.length));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('PROBE ERROR', e.message); process.exit(2); });
