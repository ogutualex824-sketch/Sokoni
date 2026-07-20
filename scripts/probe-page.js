/* Generic dead-control probe.   node scripts/probe-page.js <page.html> [--seller]

   Two lessons from earlier probes are baked in.

   1. "Didn't throw" is not "worked". A handler that runs to completion and
      changes nothing is the defect being hunted, and it is invisible unless you
      diff the DOM around the click. Every control here is measured before/after.

   2. Synthesising a call as new Function(src)() strips the `event` binding, so
      handlers doing e.stopPropagation() throw for a reason that does not exist
      in a real click. That produced a false positive earlier. This dispatches a
      genuine click and only falls back to static inspection for controls that
      navigate away.

   Seeds a localStorage session because pages guard on it and redirect
   otherwise. That exercises UI wiring, not authorisation — no Firestore data is
   available and none is claimed. */
'use strict';
const { webkit, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const PAGE = process.argv[2];
const SELLER = process.argv.includes('--seller');
const DEVICE = 'iPhone 13';
if (!PAGE) { console.error('usage: node scripts/probe-page.js <page.html> [--seller]'); process.exit(1); }

const T = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
            '.ico': 'image/x-icon', '.json': 'application/json', '.png': 'image/png' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let fp = path.join('.', p);
  if (!fs.existsSync(fp) && fs.existsSync(fp + '.html')) fp += '.html';
  fs.readFile(fp, (e, d) => {
    if (e) { r.writeHead(404); return r.end('nf'); }
    r.writeHead(200, { 'Content-Type': T[path.extname(fp)] || 'text/plain' }); r.end(d);
  });
});

const SESSION = {
  uid: 'PROBE_UID', id: 'PROBE_UID', name: 'KASS VAPES', storeName: 'KASS VAPES',
  email: null, phone: '+254705726803',
  roles: SELLER ? ['buyer', 'seller'] : ['buyer'],
  isSeller: SELLER, role: SELLER ? 'seller' : 'buyer',
};

srv.listen(0, async () => {
  const B = 'http://127.0.0.1:' + srv.address().port;
  const br = await webkit.launch();
  const ctx = await br.newContext({ ...devices[DEVICE] });
  await ctx.addInitScript((s) => {
    try {
      localStorage.setItem('sokoniUser', JSON.stringify(s));
      localStorage.setItem('sokoniPrivacyAccepted', '1');
    } catch (e) {}
  }, SESSION);

  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(B + '/' + PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(7000);
  const landed = new URL(page.url()).pathname;
  console.log('page   : ' + PAGE + (SELLER ? '  (seller session)' : '  (buyer session)'));
  console.log('landed : ' + landed);
  if (!landed.replace(/\.html$/, '').endsWith(PAGE.replace(/\.html$/, ''))) {
    console.log('\nABORT — redirected away; any result would describe the wrong page.');
    await br.close(); srv.close(); process.exit(1);
  }

  /* From here on, a control that navigates would destroy the execution context
     and abort the audit mid-way — which is what happened before this guard. The
     onclick-inspection above already skips known navigators; this catches the
     ones wired through addEventListener, whose target is not visible in markup.
     Blocked navigations are recorded rather than dropped. */
  const blockedNavs = [];
  await page.route('**/*', (route) => {
    const req = route.request();
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      blockedNavs.push(req.url().replace(B, ''));
      return route.abort();
    }
    return route.continue();
  });

  const out = await page.evaluate(async () => {
    const res = { controls: [], floating: [], overflow: null, smallTargets: [] };

    /* `visible` is load-bearing. An earlier version watched only innerHTML
       length and a dialog-selector count, and reported four healthy controls as
       INERT: openReg() and hcShowTab() work by flipping style.display, which
       changes neither. Counting rendered elements catches show/hide, tab
       switches and modals without needing to know a page's class names. */
    const visibleCount = () => {
      let n = 0;
      const all = document.body.getElementsByTagName('*');
      for (let i = 0; i < all.length; i++) if (all[i].offsetParent !== null) n++;
      return n;
    };
    const snap = () => ({
      len: document.body.innerHTML.length,
      visible: visibleCount(),
      dialogs: document.querySelectorAll('[role="dialog"],.modal,.sheet,[class*="modal"],[class*="sheet"]').length,
      hash: location.hash,
      active: document.activeElement ? document.activeElement.className : '',
    });

    const label = (el) =>
      (el.getAttribute('aria-label') || (el.textContent || '').trim().replace(/\s+/g, ' ')).slice(0, 34)
      || el.id || el.tagName;

    const nodes = [...document.querySelectorAll('button,[onclick],a[href],[role="button"]')];
    for (const el of nodes) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;      /* not rendered */
      const oc = el.getAttribute('onclick') || '';
      const href = el.getAttribute('href') || '';
      const lbl = label(el);

      /* Controls that leave the page are checked statically, never clicked. */
      if (/location|window\.open/.test(oc) || (href && !href.startsWith('#') && !/^javascript:/i.test(href))) {
        res.controls.push({ lbl, kind: 'navigate', target: href || oc.slice(0, 50), verdict: 'nav' });
        continue;
      }
      if (href === '#' && !oc) {
        res.controls.push({ lbl, kind: 'href-hash', target: '#', verdict: 'DEAD' });
        continue;
      }
      if (!oc && !el.onclick && href === '') {
        /* may still have an addEventListener binding — click and see */
      }

      const before = snap();
      let threw = null;
      try { el.click(); } catch (e) { threw = e.message; }
      await new Promise((s) => setTimeout(s, 130));
      const after = snap();
      const changed = before.len !== after.len || before.dialogs !== after.dialogs ||
                      before.visible !== after.visible ||
                      before.hash !== after.hash || before.active !== after.active;

      res.controls.push({
        lbl, kind: oc ? 'onclick' : 'listener',
        target: (oc || '(js listener)').slice(0, 50),
        verdict: threw ? 'THROWS' : (changed ? 'ok' : 'INERT'),
        err: threw || '',
      });

      /* close anything that opened, so the next control starts clean */
      document.querySelectorAll('[role="dialog"]').forEach((d) => { try { d.remove(); } catch (e) {} });
    }

    /* floating / fixed elements and their boxes, for collision analysis */
    document.querySelectorAll('*').forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return;
      if (r.width >= window.innerWidth - 2 && r.height >= window.innerHeight - 2) return;  /* full overlay */
      res.floating.push({
        id: el.id || '', cls: (el.className || '').toString().slice(0, 44),
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        z: cs.zIndex, op: cs.opacity, bf: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
        bg: cs.backgroundColor,
      });
    });

    res.overflow = document.documentElement.scrollWidth - window.innerWidth;
    res.smallTargets = [...document.querySelectorAll('button,a[href],[role="button"]')]
      .filter((b) => { const r = b.getBoundingClientRect(); return r.height > 0 && r.height < 40; })
      .map((b) => label(b)).slice(0, 12);

    return res;
  });

  const dead = out.controls.filter((c) => c.verdict === 'DEAD' || c.verdict === 'INERT');
  const threw = out.controls.filter((c) => c.verdict === 'THROWS');

  console.log('\n=== controls: ' + out.controls.length + ' ===');
  [...threw, ...dead].forEach((c) =>
    console.log('  ' + c.verdict.padEnd(8) + c.lbl.padEnd(36) + c.target + (c.err ? '  ' + c.err.slice(0, 50) : '')));
  if (!threw.length && !dead.length) console.log('  (no dead or throwing controls)');

  console.log('\n=== floating/fixed elements: ' + out.floating.length + ' ===');
  out.floating.forEach((f) => console.log('  ' + (f.id || f.cls).padEnd(34) +
    ('[' + f.x + ',' + f.y + ' ' + f.w + 'x' + f.h + ']').padEnd(24) +
    'z=' + String(f.z).padEnd(7) + 'op=' + String(f.op).padEnd(5) +
    (f.bf !== 'none' ? 'backdrop=' + f.bf + ' ' : '') + f.bg));

  /* pairwise overlap */
  const ov = [];
  for (let i = 0; i < out.floating.length; i++) {
    for (let j = i + 1; j < out.floating.length; j++) {
      const a = out.floating[i], b = out.floating[j];
      const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      if (x > 4 && y > 4) ov.push((a.id || a.cls) + '  ×  ' + (b.id || b.cls) + '   ' + x + 'x' + y + 'px');
    }
  }
  console.log('\n=== overlaps: ' + ov.length + ' ===');
  ov.forEach((o) => console.log('  ' + o));

  console.log('\n=== layout ===');
  console.log('  horizontal overflow : ' + out.overflow + 'px');
  console.log('  tap targets < 40px  : ' + out.smallTargets.length +
    (out.smallTargets.length ? '  — ' + out.smallTargets.join(', ') : ''));

  if (blockedNavs.length) {
    console.log('\n=== navigations blocked during audit: ' + blockedNavs.length + ' ===');
    [...new Set(blockedNavs)].forEach((u) => console.log('  ' + u));
  }

  console.log('\n=== summary ===');
  console.log('  dead/inert : ' + dead.length);
  console.log('  throwing   : ' + threw.length);
  console.log('  pageerror  : ' + errs.length);
  errs.slice(0, 4).forEach((e) => console.log('     ' + e.slice(0, 100)));

  await br.close(); srv.close();
});
