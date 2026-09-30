#!/usr/bin/env node
/* ================================================================
   SOKONI — Updates centre, browser certification (hermetic)
   scripts/test-admin-updates-center.js

   Fixture: scripts/lib/adminos-probe-lib.js (the one the other admin-console
   certs use) — repo served from disk under a fake host, /firebase.js answered
   by a compat stub with admin + superAdmin claims, every other origin ABORTED.
   version.json is served from THIS tree. The two admin callables are STUBBED
   on top of the compat stub (CALLABLES below): "deployed" pages the log from
   this tree's functions/data/release-log.json the way adminReleaseLog does and
   returns a computed aggregate; "absent" rejects both with functions/not-found.
   There is no public release-log.json (owner decision A) and no request for one
   may be made. Service workers are blocked, so "this browser" must render its
   neutral state and the install reporter has nothing to report.

   Asserts, for BOTH consoles (admin-os.html #updates, super-admin.html #updates):
     U1  the sidebar carries the Updates entry; clicking it opens the panel and
         moves aria-current to it (exactly one)
     U2  Live now renders the commit / branch / cacheVersion of the served
         version.json (read from disk here, not hard-coded)
     U3  the release log renders, newest first (data-date non-increasing)
     U4  every UNMEASURED install metric shows "—" + "Not measured yet" (no
         digit); every measured one shows the stubbed aggregate's figure
     U8  callables absent -> the log says "not available yet" and lists nothing;
         every install metric is neutral; no request for /release-log.json
     U5  no horizontal overflow at 390 / 768 / 1280
     U6  keyboard: the Updates entry is reachable by Tab and opens on Enter;
         the Refresh button and the search field are focusable
     U7  deep link: admin-os.html#updates (and super-admin.html#updates) lands
         on the panel after a real load
   NEGATIVE CONTROL
     N1  a served module that fabricates "0" into the install metrics is caught
         by the U4 predicate (served-markup sabotage via router overrides)

   Run:   node scripts/test-admin-updates-center.js
   Exit:  0 all passed · 1 a test failed · 2 the harness could not run
   ================================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const shared = require(path.join(__dirname, 'lib', 'adminos-probe-lib.js'));
const ROOT = shared.ROOT;
const HOST = 'sokoni-cert.test';

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); }
                          else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); } };

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
const LOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'functions', 'data', 'release-log.json'), 'utf8'));
const STATS = { state: 'computed', computedAt: '2026-10-01T06:00:00.000Z', since: '2026-10-01T03:12:00.000Z', devices: 12, total: 3, standalone: 4, active7: 9, active30: 12, onLive: null, behind: null, liveCacheVersion: null, liveError: 'version.json HTTP 503' };

/* Callable stub appended to the compat /firebase.js stub. mode 'deployed' mirrors
   the adminReleaseLog contract (limit, cursor, type/status/q filters); 'absent'
   is an undeployed function. Anything else keeps the harness default. */
function CALLABLES(mode) {
  return shared.firebaseStub() + '\n(function(){\n'
    + 'var MODE=' + JSON.stringify(mode) + ', LOG=' + (mode === 'deployed' ? JSON.stringify(LOG) : 'null') + ', STATS=' + JSON.stringify(STATS) + ';\n'
    + 'function later(v){ return new Promise(function(r){ setTimeout(function(){ r(v); }, 8); }); }\n'
    + 'function nf(){ var e=new Error("NOT_FOUND"); e.code="functions/not-found"; return Promise.reject(e); }\n'
    + 'var base=window.firebase.functions;\n'
    + 'window.firebase.functions=function(){ var f=base(); var orig=f.httpsCallable; f.httpsCallable=function(name){\n'
    + '  if(name==="adminReleaseLog") return function(q){ if(MODE!=="deployed") return nf(); q=q||{};\n'
    + '    var hits=LOG.entries.filter(function(e){ return (!q.type||q.type==="all"||e.type===q.type) && (!q.q||(e.title+" "+(e.summary||"")).toLowerCase().indexOf(q.q)>=0); });\n'
    + '    var off=q.cursor?parseInt(String(q.cursor).slice(2),10):0, lim=Math.min(q.limit||40,100), page=hits.slice(off,off+lim);\n'
    + '    return later({ data: { schema:1, source:LOG.source, sourceSha256:LOG.sourceSha256, entryCount:LOG.entries.length, total:hits.length, entries:page, nextCursor: off+page.length<hits.length?"o:"+(off+page.length):null } }); };\n'
    + '  if(name==="adminGetAppInstallStats") return function(){ return MODE==="deployed" ? later({ data: STATS }) : nf(); };\n'
    + '  return orig.call(f,name); }; return f; };\n'
    + '})();\n';
}
const CONSOLES = [
  { name: 'AdminOS', page: '/admin-os.html', nav: '#aosNav .nav-item[data-section="updates"]', navRoot: '#aosNav', ready: () => !!(window.SokoniAOS && document.querySelector('#aosNav .nav-item.active')) },
  { name: 'Super Admin', page: '/super-admin.html', nav: '#saNav .nav-item[data-section="updates"]', navRoot: '#saNav', ready: () => !!document.querySelector('#saSidebar .nav-item') && getComputedStyle(document.getElementById('authGate')).display === 'none' },
];

/* The U4 predicate, identical to scripts/test-admin-updates-static.js: an
   UNMEASURED metric is "—" + "Not measured yet"; measured ones are returned. */
const METRIC_PROBE = () => {
  const out = { count: 0, bad: [], measured: {} };
  document.querySelectorAll('.aos-panel:not([hidden]) [data-metric], .sa-panel:not([hidden]) [data-metric]').forEach((m) => {
    out.count++;
    const v = (m.querySelector('.sk-upd-metric-value') || {}).textContent;
    const s = (m.querySelector('.sk-upd-metric-state') || {}).textContent;
    if (m.dataset.measured === 'true') { out.measured[m.dataset.metric] = (v || '').trim(); return; }
    if ((v || '').trim() !== '—' || /\d/.test(v || '')) out.bad.push({ metric: m.dataset.metric, value: v });
    if (s !== 'Not measured yet') out.bad.push({ metric: m.dataset.metric, state: s });
  });
  return out;
};

const REQUESTED = [];
async function newCtx(browser, { width, height, overrides = {}, callables = 'deployed' }) {
  const ctx = await browser.newContext({ viewport: { width, height }, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  await ctx.addInitScript(shared.compatInit, 'superAdmin');
  const handler = shared.router({ host: HOST, overrides: Object.assign({ '/firebase.js': CALLABLES(callables) }, overrides) });
  await ctx.route('**/*', (route) => { try { REQUESTED.push(new URL(route.request().url()).pathname); } catch (_) {} return handler(route); });
  return ctx;
}

async function boot(page, c, hash) {
  await page.goto('about:blank');
  await page.goto('https://' + HOST + c.page + (hash || ''), { waitUntil: 'domcontentloaded', timeout: 30000 });
  try { await page.waitForFunction(c.ready, { timeout: 20000 }); } catch (_) { return false; }
  await page.waitForTimeout(250);
  await page.evaluate(() => ['sk-splash', 'sk-offline-bar'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); }));
  return true;
}

const waitRendered = (page) => page.waitForFunction(() => {
  const p = document.querySelector('#panel-updates');
  return p && !p.hidden && document.querySelector('#panel-updates [data-fact="commit"]') && (document.querySelectorAll('#panel-updates .sk-upd-entry').length > 0 || /not available yet/.test((document.querySelector('#panel-updates [data-upd="log-meta"]') || {}).textContent || ''));
}, { timeout: 15000 }).then(() => true, () => false);

(async () => {
  let chromium;
  try { ({ chromium } = shared.playwright()); } catch (e) { console.error('HARNESS: ' + e.message); process.exit(2); }
  let browser;
  try { browser = await chromium.launch(); } catch (e) { console.error('HARNESS: chromium did not launch: ' + e.message); process.exit(2); }

  try {
    for (const c of CONSOLES) {
      console.log(`\n  [${c.name}]`);
      const ctx = await newCtx(browser, { width: 1280, height: 900 });
      const page = await ctx.newPage();
      if (!await boot(page, c)) { ok(`${c.name}: console boots under the fixture`, false, 'ready condition not met'); await ctx.close(); continue; }

      ok(`U1 ${c.name}: sidebar carries the Updates entry`, await page.locator(c.nav).count() === 1);
      await page.click(c.nav);
      const rendered = await waitRendered(page);
      ok(`U1 ${c.name}: clicking it opens #panel-updates and renders`, rendered);
      const cur = await page.evaluate((root) => [...document.querySelectorAll(root + ' [aria-current="page"]')].map((n) => n.dataset.section), c.navRoot);
      ok(`U1 ${c.name}: exactly one aria-current, on Updates`, JSON.stringify(cur) === '["updates"]', cur);

      const facts = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#panel-updates [data-fact]')].map((n) => [n.dataset.fact, n.textContent])));
      ok(`U2 ${c.name}: commit from the served version.json (${VERSION.commitShort})`, (facts.commit || '').includes(VERSION.commitShort), facts.commit);
      ok(`U2 ${c.name}: branch from the served version.json`, (facts.branch || '').includes(VERSION.branch), facts.branch);
      ok(`U2 ${c.name}: cache version from the served version.json`, (facts.cacheVersion || '').includes(VERSION.cacheVersion), facts.cacheVersion);
      ok(`U2 ${c.name}: SW blocked -> "this browser" is neutral, not "Up to date"`, /cannot be read|did not answer/.test(facts.verdict || '') && !/Up to date/.test(facts.verdict || ''), facts.verdict);

      const dates = await page.evaluate(() => [...document.querySelectorAll('#panel-updates .sk-upd-entry')].map((n) => n.dataset.date).filter(Boolean));
      ok(`U3 ${c.name}: release log newest first (${dates.length} shown)`, dates.length > 1 && dates.every((d, i) => i === 0 || dates[i - 1] >= d), dates.slice(0, 6));

      await page.waitForFunction(() => !!document.querySelector('#panel-updates [data-metric="devices"][data-measured="true"]'), { timeout: 10000 }).catch(() => {});
      const mv = await page.evaluate(METRIC_PROBE);
      ok(`U4 ${c.name}: every unmeasured install metric is "—" + "Not measured yet"`, mv.count >= 7 && mv.bad.length === 0, mv.bad);
      ok(`U4 ${c.name}: measured metrics show the aggregate's figures (devices 12, installs 3, active7 9)`, mv.measured.devices === '12' && mv.measured.installs === '3' && mv.measured.active7 === '9' && !('onLatest' in mv.measured) && !('behind' in mv.measured), mv.measured);

      for (const [w, h] of [[390, 844], [768, 1024], [1280, 900]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(200);
        const ov = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth, wide: [...document.querySelectorAll('#panel-updates *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(e).position !== 'fixed').slice(0, 3).map((e) => e.className || e.tagName) }));
        ok(`U5 ${c.name}: no horizontal overflow at ${w}px`, ov.doc <= ov.vw + 1 && ov.wide.length === 0, ov);
      }
      await page.setViewportSize({ width: 1280, height: 900 });

      /* Keyboard: Tab from the top of the document reaches the Updates entry. */
      await boot(page, c);
      await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); window.scrollTo(0, 0); });
      let reached = false;
      for (let i = 0; i < 80 && !reached; i++) {
        await page.keyboard.press('Tab');
        reached = await page.evaluate(() => !!(document.activeElement && document.activeElement.dataset && document.activeElement.dataset.section === 'updates'));
      }
      ok(`U6 ${c.name}: the Updates entry is reachable by Tab`, reached);
      if (reached) {
        await page.keyboard.press('Enter');
        ok(`U6 ${c.name}: Enter opens the panel`, await waitRendered(page));
        const focusable = await page.evaluate(() => ['[data-upd="refresh"]', '#panel-updates input[type="search"]'].map((s) => { const e = document.querySelector(s); if (!e) return false; e.focus(); return document.activeElement === e; }));
        ok(`U6 ${c.name}: Refresh and search are focusable`, focusable.every(Boolean), focusable);
      }

      await boot(page, c, '#updates');
      ok(`U7 ${c.name}: ${c.page}#updates lands on the Updates panel after a real load`, await waitRendered(page));
      await ctx.close();
    }

    /* ── U8: callables not deployed ─────────────────────────────────────── */
    console.log('\n  [callables absent]');
    for (const c of CONSOLES) {
      const ctx = await newCtx(browser, { width: 1280, height: 900, callables: 'absent' });
      const page = await ctx.newPage();
      if (!await boot(page, c, '#updates')) { ok(`U8 ${c.name}: console boots`, false); await ctx.close(); continue; }
      const shown = await page.waitForFunction(() => /not available yet/.test((document.querySelector('#panel-updates [data-upd="log-meta"]') || {}).textContent || ''), { timeout: 15000 }).then(() => true, () => false);
      ok(`U8 ${c.name}: log says "Release log is served to admins by the server — not available yet"`, shown);
      ok(`U8 ${c.name}: no entries and no "no entries" line`, await page.evaluate(() => document.querySelectorAll('#panel-updates .sk-upd-entry, #panel-updates .sk-upd-empty').length === 0));
      const mv = await page.evaluate(METRIC_PROBE);
      ok(`U8 ${c.name}: every install metric neutral (${mv.count})`, mv.count >= 7 && mv.bad.length === 0 && Object.keys(mv.measured).length === 0, mv);
      await ctx.close();
    }
    ok('U8 no request for a public /release-log.json was made in any context', !REQUESTED.some((p) => /release-log\.json$/.test(p)), REQUESTED.filter((p) => /release-log/.test(p)));

    /* ── NEGATIVE CONTROL: a module that fabricates a count ────────────── */
    console.log('\n  [negative control]');
    const src = fs.readFileSync(path.join(ROOT, 'sokoni-admin-updates.js'), 'utf8');
    const ANCHOR = "Number(v).toLocaleString('en-KE') : NEUTRAL;";
    const sabotaged = src.replace(ANCHOR, "Number(v).toLocaleString('en-KE') : '0';");
    if (sabotaged === src) ok('N1 sabotage applied (anchor present)', false, 'anchor missing');
    else {
      const ctx = await newCtx(browser, { width: 1280, height: 900, callables: 'absent', overrides: { '/sokoni-admin-updates.js': sabotaged } });
      const page = await ctx.newPage();
      if (await boot(page, CONSOLES[0], '#updates') && await waitRendered(page)) {
        const mv = await page.evaluate(METRIC_PROBE);
        ok('N1 a fabricated "0" in the install metrics is CAUGHT by the U4 predicate', mv.bad.length > 0, mv);
      } else ok('N1 sabotaged console booted', false);
      await ctx.close();
    }
  } catch (e) {
    console.error('HARNESS ERROR', e); await browser.close(); process.exit(2);
  }
  await browser.close();
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
