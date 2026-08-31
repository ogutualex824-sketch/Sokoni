#!/usr/bin/env node
/**
 * MINISHOP TRUST LAYER — every badge must have an authoritative source.
 *
 *   node scripts/test-minishop-trust-honesty.js
 *
 * A storefront's trust signals are the one place where a missing value must NEVER become
 * a green tick. "Verified" with no verification record, "Open" with no resolved schedule,
 * or a star rating invented from an empty review list are all worse than showing nothing:
 * they are a claim about a real business, made by us, on no evidence.
 *
 * So this suite is built around NEGATIVE controls. It renders the real storefront twice —
 * once with a fully-attested shop, once with a shop that has none of it — and requires the
 * badges to DISAPPEAR in the second case. A suite that only tested the happy path would
 * pass just as well against code that hard-codes every tick.
 *
 * WHAT IS DELIBERATELY NOT TESTED, because it does not exist: seller certification. There
 * is no certification authority for merchants in this codebase — `certificationReports` is
 * an internal release-readiness artifact, not a merchant credential. A "Seller certified"
 * badge would therefore have nothing behind it, so it is not built and not asserted.
 */
'use strict';
/* TEARDOWN MUST NOT SWALLOW THE VERDICT.
   Observed: this suite ran every assertion, printed the last PASS, and then produced NO
   tally at all — the required-suite runner correctly refused it as NO-TALLY. The work had
   finished; browser.close() hung on a stuck context and the process died before reporting.
   A suite that cannot report is indistinguishable from one that failed, so closing is now
   bounded and can never outlive the verdict. */
function _bounded (p, ms) {
  return Promise.race([
    Promise.resolve(p).catch(function () {}),
    new Promise(function (r) { setTimeout(r, ms); }),
  ]);
}

const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 88) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(NL + t);

const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html',
                '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const PRODUCTS = [
  { id: 'm1', name: 'Bravilex Shirt', price: 2500, shopId: 'SHOP_A', sellerUid: 'SELLER_A',
    imageUrl: '', category: 'Clothing', stock: 8, status: 'active' },
];

/* ATTESTED — everything genuinely present */
const ATTESTED = {
  ok: true,
  shop: { id: 'SHOP_A', name: 'Bravilex', handle: 'bravilex',
          verified: true, rating: 4.8, reviewCount: 247,
          responseRate: 96, completionRate: 98 },
  config: {}, products: PRODUCTS,
  reviews: [{ id: 'r1', rating: 5, text: 'Fast delivery', targetId: 'SHOP_A' }],
  totalProducts: 1, followerCount: 12,
  availability: { open: true, label: 'Open' },
  schedule: { mon: '08:00-18:00' },
};

/* BARE — a real shop with none of it attested. Every badge must vanish. */
const BARE = {
  ok: true,
  shop: { id: 'SHOP_B', name: 'New Duka', handle: 'newduka' },
  config: {}, products: PRODUCTS,
  reviews: [],
  totalProducts: 1, followerCount: 0,
  availability: null,        /* the server could not resolve it */
  schedule: null,
};

const SNAPSHOT = `(function () {
  var t = (document.body.innerText || '').replace(/\\s+/g, ' ');
  return {
    text: t,
    verifiedBadgeVisible: (function () {
      var v = document.getElementById('msVerified');
      if (!v) return false;
      var s = getComputedStyle(v);
      return s.display !== 'none' && s.visibility !== 'hidden' && v.getBoundingClientRect().height > 0;
    })(),
    trustItems: Array.prototype.map.call(
      document.querySelectorAll('.ms-trust-item'), function (e) { return (e.textContent || '').trim(); })
  };
})()`;

(async () => {
  console.log(NL + 'MINISHOP TRUST — HONESTY UNDER NEGATIVE CONTROL' + NL + '='.repeat(64));

  let webkit;
  try { ({ webkit } = require('playwright')); }
  catch (_) {
    console.log(NL + '  ENV  playwright is not installed — cannot render the storefront.');
    console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, 1 env');
    process.exit(0);
  }

  const server = http.createServer((rq, rs) => {
    let name = (rq.url.split('?')[0] || '/').replace(/^\//, '') || 'index.html';
    if (!path.extname(name)) name += '.html';
    fs.readFile(path.join(ROOT, name), (e, d) => {
      if (e) { rs.writeHead(404); return rs.end('nf'); }
      rs.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] || 'text/plain' });
      rs.end(d);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = 'http://localhost:' + server.address().port;

  let br;
  try { br = await webkit.launch(); }
  catch (e) {
    console.log(NL + '  ENV  browser could not launch: ' + String(e && e.message || e).slice(0, 64));
    try { server.close(); } catch (_) {}
    console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, 1 env');
    process.exit(0);
  }

  async function render (payload, viewport) {
    const ctx = await br.newContext({ viewport });
    await ctx.addInitScript(() => {
      /* sw-register checks this before BUILDING the prompt, so it is never created.
         Removing it afterwards raced its own re-creation. Suppress, do not fight. */
      try { localStorage.setItem('sokoniNotifDismissed', 'permanent'); } catch (_) {}
    });
    const page = await ctx.newPage();
    await page.route('**/getMinishopPublic**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
                      headers: { 'Access-Control-Allow-Origin': '*' },
                      body: JSON.stringify(payload) }));
    await page.goto(base + '/minishop.html?handle=x', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3200);
    const acc = page.locator('#_sokoniPrivacyAcceptBtn');
    if (await acc.count()) { await acc.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(400); }
    await page.evaluate(`(function(){var p=document.getElementById('sokoniNotifPrompt');if(p)p.remove();})()`);
    const snap = await page.evaluate(SNAPSHOT);
    return { ctx, page, snap };
  }

  async function suite (label, viewport) {
    head(label + ' — ' + viewport.width + 'x' + viewport.height);

    /* ── ATTESTED ── */
    const A = await render(ATTESTED, viewport);
    try {
      ck(label + ': an ATTESTED shop shows the verified badge', A.snap.verifiedBadgeVisible);
      ck(label + ': ...and a Verified Business trust item',
         A.snap.trustItems.some((t) => /verified business/i.test(t)), A.snap.trustItems.join(' | '));
      ck(label + ': ...and its real rating', /4\.8/.test(A.snap.text), '4.8 expected');
      ck(label + ': ...and reports OPEN when the server resolved it',
         /open/i.test(A.snap.text), 'server said open:true');
      ck(label + ': the product is still purchasable',
         (await A.page.locator('.ms-add-btn:visible').count()) > 0);
    } finally { await A.ctx.close(); }

    /* ── BARE — the negative control ── */
    const B = await render(BARE, viewport);
    try {
      ck(label + ': NEGATIVE no verification record ⇒ NO verified badge',
         B.snap.verifiedBadgeVisible === false,
         'a missing record must never become a green tick');
      ck(label + ': NEGATIVE ...and no Verified Business trust item',
         !B.snap.trustItems.some((t) => /verified/i.test(t)), B.snap.trustItems.join(' | ') || 'none');
      ck(label + ': NEGATIVE no reviews ⇒ no invented rating',
         !/\b[0-5]\.\d\s*(star|★)/i.test(B.snap.text) &&
         !B.snap.trustItems.some((t) => /star rating/i.test(t)),
         B.snap.trustItems.join(' | ') || 'no rating claimed');
      ck(label + ': NEGATIVE unresolved availability ⇒ does not claim Open',
         !/\bopen\b/i.test(B.snap.text) || /closed|unknown|hours/i.test(B.snap.text),
         'availability was null — guessing Open would be a fabricated fact');
      ck(label + ': NEGATIVE no response/completion data ⇒ no such badge',
         !B.snap.trustItems.some((t) => /response rate|order completion/i.test(t)),
         B.snap.trustItems.join(' | ') || 'none');
      ck(label + ': the bare shop is still a working storefront',
         (await B.page.locator('.ms-add-btn:visible').count()) > 0,
         'honesty must not cost the shop its ability to sell');
      ck(label + ': CONTROL the two renders genuinely differ',
         A.snap.trustItems.length !== B.snap.trustItems.length ||
         A.snap.verifiedBadgeVisible !== B.snap.verifiedBadgeVisible,
         'if identical, the badges are not reading the data at all');
    } finally { await B.ctx.close(); }
  }

  try {
    await suite('mobile', { width: 390, height: 844 });
    await suite('desktop', { width: 1280, height: 900 });
  } finally {
    await _bounded(br.close(), 5000);
    try { server.close(); } catch (_) {}
  }

  /* ── the source of each claim ─────────────────────────────────────────────── */
  head('every badge names an authoritative source');
  const MS = fs.readFileSync(path.join(ROOT, 'sokoni-minishop.js'), 'utf8');
  ck('verified reads shop.verified', /shop\.verified/.test(MS));
  ck('...which the rules keep out of a shop owner write',
     /'featured','verified','flagged','adminNote'/.test(fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8')),
     'admin-only, so its presence is authoritative rather than self-asserted');
  ck('open/closed presents the SERVER decision, never a browser one',
     /Never decide it here/.test(MS),
     'it used to re-derive from config.hours and was wrong in four ways, all towards "open"');
  ck('CONTROL no badge is hard-coded true',
     !/verified\s*=\s*true/.test(MS) && !/verifiedBadge\s*=\s*true/.test(MS));
  ck('seller certification is NOT claimed — it has no authority',
     !/seller certified|certified seller/i.test(MS),
     'certificationReports is an internal release artifact, not a merchant credential');

  console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR: ' + (e && e.stack || e)); process.exit(1); });
