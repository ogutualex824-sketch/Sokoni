/* test-creator-ui.js — Creator Hub UI contracts.
 *
 * WHAT THESE PROVE
 *   AdminOS  - the UI's op list == the server's creatorAdmin* handlers (no op the
 *              server lacks, none it offers that the UI cannot reach)
 *            - sokoni-aos.js whitelists them through adminOsDispatch; admin-os.html
 *              has the nav item, the panel, and loads the module BEFORE the engine
 *            - driven in real Chromium: each button sends the right op + payload;
 *              reasons are REQUIRED before suspend/reject/hold; unknown money is "—"
 *              and never 0; server strings are escaped (no HTML injection)
 *   Pages    - creator.html / creator-studio.html talk only to callables: no
 *              Firestore writes, no media path, no client-side grant; payment
 *              waits for server access; both self-update (sw-register)
 *   Category - `creator` is a key of the canonical categoryMeta, and hands over
 *              to the live catalogue
 *
 *   node scripts/test-creator-ui.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const rd = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 110) + ']' : '')); ok ? pass++ : fail++; };

(async () => {
  console.log('\n── AdminOS wiring ──');
  const modSrc = rd('sokoni-aos-creator.js');
  const sandbox = {}; new Function('globalThis', modSrc.replace('typeof window !== \'undefined\' ? window : globalThis', 'globalThis'))(sandbox);
  const UI_OPS = sandbox.SokoniAOSCreator.OPS;
  const hubSrc = rd('functions/creator-hub.js');
  const SERVER_OPS = [...hubSrc.matchAll(/_adminH\.(creatorAdmin[A-Za-z]+)\s*=/g)].map((m) => m[1]);
  ck('UI op list == server creatorAdmin* handlers', JSON.stringify([...UI_OPS].sort()) === JSON.stringify([...SERVER_OPS].sort()),
    `ui-only: ${UI_OPS.filter((o) => !SERVER_OPS.includes(o))} server-only: ${SERVER_OPS.filter((o) => !UI_OPS.includes(o))}`);
  const aos = rd('sokoni-aos.js');
  ck('sokoni-aos.js whitelists the module ops for adminOsDispatch', /\.\.\.\(\(window\.SokoniAOSCreator && window\.SokoniAOSCreator\.OPS\) \|\| \[\]\)/.test(aos));
  ck('sokoni-aos.js has a creator loader', /creator:\s*\(\)\s*=>\s*_loadCreator\(\)/.test(aos));
  const html = rd('admin-os.html');
  ck('admin-os.html nav item', /data-section="creator"/.test(html));
  ck('admin-os.html panel', /id="panel-creator"/.test(html) && /id="creatorBody"/.test(html));
  ck('module loads BEFORE the engine (whitelist is built at engine load)', html.indexOf('sokoni-aos-creator.js') > 0 && html.indexOf('sokoni-aos-creator.js') < html.indexOf('<script src="sokoni-aos.js">'));
  ck('no new admin page (AdminOS is the one admin surface)', !fs.existsSync(path.join(ROOT, 'creator-admin.html')));

  console.log('\n── AdminOS module in Chromium ──');
  let chromium;
  try { ({ chromium } = require(path.join(ROOT, 'node_modules', 'playwright'))); } catch (e) { ck('playwright available', false, e.message); }
  if (chromium) {
    let browser;
    try { browser = await chromium.launch(); } catch (e) { ck('chromium launches', false, e.message.split('\n')[0]); }
    if (browser) {
      const page = await browser.newPage();
      await page.setContent('<div id="host"></div>');
      await page.addScriptTag({ content: modSrc });
      await page.evaluate(() => {
        window.CALLS = [];
        const data = {
          creatorAdminList: { creators: [{ creatorId: 'cA', displayName: '<img src=x onerror=window.PWNED=1>', state: 'PENDING', verification: 'UNVERIFIED' },
            { creatorId: 'cB', displayName: 'Beta', state: 'ACTIVE', verification: 'VERIFIED' }] },
          creatorAdminFilms: { films: [{ filmId: 'f1', title: 'Film One', pubState: 'UNDER_REVIEW', priceCents: 50000, accessType: 'purchase', mediaReady: true, agreementVersion: null }] },
          creatorAdminPeriods: { current: { periodId: '2026-Q4', endMs: 0 }, periods: [{ periodId: '2026-Q3', status: 'CALCULATED', calculatedBy: 'adm1', totals: { participants: 5, releaseKes: 1312 } }] },
          creatorAdminExceptions: { exceptions: [{ kind: 'fee_unreported', paymentRef: 'SKN1', detail: 'x' }] },
          creatorAdminSecurityEvents: { events: [] },
          creatorAdminConfig: { purchasesEnabled: false, checkoutMethods: [] },
          creatorAdminFilmDetail: { film: { title: 'Film One' }, media: null, agreements: [], accruals: [{ paymentRef: 'P1', status: 'ACCRUED', grossCents: 50000, deductions: { providerFeeCents: null, commissionCents: 7500 }, poolCents: 41000, agreementVersion: 1, periodId: '2026-Q3' }] },
        };
        window.SokoniAOSCreator.mount({ host: document.getElementById('host'), call: async (op, d) => { window.CALLS.push({ op, d }); return data[op] || {}; } });
      });
      const settle = () => page.waitForTimeout(120);
      await settle();
      ck('opens on Creators via creatorAdminList', (await page.evaluate(() => window.CALLS[0].op)) === 'creatorAdminList');
      ck('server strings are escaped (no HTML injection)', !(await page.evaluate(() => window.PWNED)) && (await page.locator('img[src=x]').count()) === 0);
      await page.click('[data-a="cr-approve"][data-id="cA"]'); await settle();
      const ap = (await page.evaluate(() => window.CALLS)).find((c) => c.op === 'creatorAdminSetState');
      ck('Approve → creatorAdminSetState {uid, to:ACTIVE}', ap && ap.d.uid === 'cA' && ap.d.to === 'ACTIVE');
      await page.click('[data-a="cr-suspend"][data-id="cB"]'); await settle();
      await page.click('.aoscr-ask button:first-of-type'); await settle();
      ck('Suspend with no reason sends NOTHING', !(await page.evaluate(() => window.CALLS.some((c) => c.op === 'creatorAdminSetState' && c.d.to === 'SUSPENDED'))));
      await page.fill('.aoscr-ask textarea', 'rights dispute pending'); await page.click('.aoscr-ask button:first-of-type'); await settle();
      const su = (await page.evaluate(() => window.CALLS)).find((c) => c.op === 'creatorAdminSetState' && c.d.to === 'SUSPENDED');
      ck('Suspend with reason → {uid, to:SUSPENDED, reason}', su && su.d.uid === 'cB' && su.d.reason === 'rights dispute pending');
      await page.click('[data-a="cr-release"][data-id="cA"]'); await settle();
      const rel = (await page.evaluate(() => window.CALLS)).find((c) => c.op === 'creatorAdminSetPayoutHold');
      ck('Release hold → creatorAdminSetPayoutHold {hold:false}', rel && rel.d.hold === false && rel.d.uid === 'cA');

      await page.click('[data-tab="films"]'); await settle();
      await page.click('[data-a="film-to"][data-to="APPROVED"]'); await settle();
      const fa = (await page.evaluate(() => window.CALLS)).find((c) => c.op === 'creatorAdminFilmTransition');
      ck('Approve film → creatorAdminFilmTransition {filmId, to:APPROVED}', fa && fa.d.filmId === 'f1' && fa.d.to === 'APPROVED');
      await page.click('[data-a="film-detail"][data-id="f1"]'); await settle();
      const detail = await page.locator('#aoscrDetail').innerText();
      ck('unknown provider fee renders "—", not "KES 0"', detail.includes('—') && !/KES 0\.00/.test(detail), detail.slice(0, 120));
      ck('film detail never shows a media location', !/creator-masters|storage\.googleapis/.test(detail));

      await page.click('[data-tab="settlement"]'); await settle();
      await page.click('[data-a="per-approve"][data-id="2026-Q3"]'); await settle();
      const pa = (await page.evaluate(() => window.CALLS)).find((c) => c.op === 'creatorAdminApprovePeriod');
      ck('Approve quarter → creatorAdminApprovePeriod {periodId}', pa && pa.d.periodId === '2026-Q3');
      await page.fill('form[data-f="per-calc-new"] input', '2026-Q2'); await page.click('form[data-f="per-calc-new"] button'); await settle();
      ck('Calculate quarter form → creatorAdminCalculatePeriod {periodId}', (await page.evaluate(() => window.CALLS)).some((c) => c.op === 'creatorAdminCalculatePeriod' && c.d.periodId === '2026-Q2'));

      await page.click('[data-tab="config"]'); await settle();
      await page.click('[data-a="cfg-purchases"]'); await settle();
      const cf = (await page.evaluate(() => window.CALLS)).find((c) => c.op === 'creatorAdminConfig' && c.d.set);
      ck('Open purchases → creatorAdminConfig {set:{purchasesEnabled:true}}', cf && cf.d.set.purchasesEnabled === true);
      const opsUsed = new Set((await page.evaluate(() => window.CALLS)).map((c) => c.op));
      ck('every op the UI sent is a whitelisted server op', [...opsUsed].every((o) => SERVER_OPS.includes(o)), [...opsUsed].join(','));
      /* Pricing section of subscriptions.html, rendered in Chromium from the served
         commercial copy — its numbers must equal the server's computePool. */
      const html = rd('subscriptions.html');
      const inline = html.slice(html.lastIndexOf('<script>', html.indexOf('renderCreatorPpv')) + 8, html.indexOf('</script>', html.indexOf('renderCreatorPpv')));
      const p2 = await browser.newPage();
      await p2.setContent('<div id="creatorPpv"></div>');
      await p2.addScriptTag({ content: rd('sokoni-creator-commercial.js') });
      await p2.addScriptTag({ content: inline });
      const txt = await p2.locator('#creatorPpv').innerText();
      const Rm = require(path.join(ROOT, 'functions', 'shared', 'creator-royalty.js'));
      const Cm = require(path.join(ROOT, 'functions', 'shared', 'creator-commercial.js'));
      const srv = Rm.computePool({ grossCents: 50000, providerFeeCents: 2000, policy: Cm.CREATOR_PPV });
      ck('pricing: shows 30% SOKONI and 70% creator pool', /30% SOKONI commission/.test(txt) && /70% Creator royalty pool/.test(txt), txt.slice(0, 120));
      ck('pricing: example equals the server split (480 → 144 / 336)', txt.includes('KES ' + (srv.commissionCents / 100)) && txt.includes('KES ' + (srv.poolCents / 100)) && srv.commissionCents === 14400);
      ck('pricing: provider fee separate, quarterly, not immediately withdrawable, refunds reverse', /provider/i.test(txt) && /quarterly/i.test(txt) && /not immediately withdrawable/i.test(txt) && /reverses/i.test(txt));
      const p3 = await browser.newPage();
      await p3.setContent('<div id="creatorPpv"></div>');
      await p3.addScriptTag({ content: inline });
      ck('pricing: without the policy file it says unavailable (no guessed rate)', /unavailable/.test(await p3.locator('#creatorPpv').innerText()));
      await browser.close();
    }
  }

  console.log('\n── viewer + studio pages ──');
  for (const f of ['creator.html', 'creator-studio.html']) {
    const s = rd(f);
    const mod = (s.match(/<script type="module">([\s\S]*?)<\/script>/) || [])[1] || '';
    ck(`${f}: self-updates (sw-register.js)`, /<script src="\/sw-register\.js" defer><\/script>/.test(s));
    ck(`${f}: no Firestore client writes`, !/\b(setDoc|addDoc|updateDoc|deleteDoc|writeBatch|runTransaction)\b/.test(mod));
    ck(`${f}: never references the private master path`, !/creator-masters/.test(mod));
    ck(`${f}: never grants from the URL / storage`, !/(localStorage|sessionStorage)\.[a-zA-Z]+\([^)]*(access|entitle|paid)/i.test(mod) && !/params\.get\(['"](paid|access|entitled)/.test(mod));
  }
  const viewer = rd('creator.html');
  ck('creator.html: purchase uses film_access via createPaymentIntent (server price)', /createPaymentIntent'\)\(\{ purpose: 'film_access'/.test(viewer));
  ck('creator.html: STK amount is the SERVER intent amount', /amount: intent\.amount/.test(viewer));
  ck('creator.html: access only after server says ACTIVE', /viewer\.access\.status === 'ACTIVE'/.test(viewer));
  ck('creator.html: says "Payment methods available at checkout" from the server notice', /co\.notice/.test(viewer));
  ck('creator.html: no "copy-proof" / "cannot be recorded" claims', !/copy-?proof|cannot be recorded|impossible to record|screen[- ]recording (is )?blocked/i.test(viewer));
  ck('creator.html: fullscreens the CONTAINER so the watermark stays on', /p\.requestFullscreen/.test(viewer) && /nofullscreen/.test(viewer));
  ck('creator.html: tamper → pause + report', /report\('overlay_removed'\)/.test(viewer) && /report\('overlay_hidden'\)/.test(viewer));
  ck('creator.html: guest account = LINK (same uid), never a second account', /linkWithCredential\(USER, cred\)/.test(viewer) && !/createUserWithEmailAndPassword/.test(viewer));
  ck('creator.html: guest checkout offered only when the server says so', /co\.guestCheckout \?/.test(viewer));
  ck('creator.html: My films (library) view', viewer.includes("params.get('view') === 'library') library()") && /viewer\.library/.test(viewer));
  ck('creator.html: heartbeat reports progress', /beat\.positionSec = Math\.floor\(v\.currentTime\)/.test(viewer));
  ck('creator.html: hosted checkout offered only when the server says so', /co\.hostedCheckout \?/.test(viewer));
  ck('creator.html: hosted redirect only to https *.intasend.com', /u\.protocol !== 'https:' \|\| !\/\(\^\|\\\.\)intasend\\\.com\$\/\.test\(u\.hostname\)/.test(viewer) || (viewer.includes("u.protocol !== 'https:'") && viewer.includes('intasend')));
  ck('creator.html: return from checkout WAITS for server access (no grant from the URL)', /params\.get\('checkout'\) === 'returned'/.test(viewer) && /viewer\.access\.status === 'ACTIVE'/.test(viewer));
  ck('creator.html: public creator profile view', /catalog\.creator/.test(viewer) && /function creatorProfile/.test(viewer));
  ck('creator.html: dashboard shows Available for withdrawal + Withdrawn + history', /Available for withdrawal\*/.test(viewer) && /Withdrawn\*/.test(viewer) && /Withdrawal history/.test(viewer));
  ck('studio: no UI for an unenforced "free preview" rule', !/previewSeconds/.test(rd('creator-studio.html')));
  const fsearch = rd('sokoni-firestore-search.js');
  ck('search: films source guarded like the rules (creatorHub + status active)', /col: 'entertainmentListings'/.test(fsearch) && /w\('creatorHub', '==', true\), w\('status', '==', 'active'\)/.test(fsearch));
  ck('search: Films tab + links to the film page', /id: "films"/.test(rd('search.html')) && /'creator\.html\?film=' \+ encodeURIComponent\(id\)/.test(fsearch));
  ck('search: film result carries no media location', !/creator-masters|streamingUrl/.test(fsearch.slice(fsearch.indexOf("col: 'entertainmentListings'"), fsearch.indexOf("col: 'entVenues'"))));
  const pricing = rd('subscriptions.html');
  ck('pricing: Creator section on the canonical Monetisation & Pricing page', /SOKONI Monetisation & Pricing/.test(pricing) && /id="creatorPpv"/.test(pricing) && /sokoni-creator-commercial\.js/.test(pricing));
  ck('pricing: no isolated Creator pricing page', !fs.existsSync(path.join(ROOT, 'creator-pricing.html')));
  const studio = rd('creator-studio.html');
  ck('studio: Apply for Creator Verification', /Apply for Creator Verification/.test(studio) && /verification\.submit/.test(studio));
  ck('studio: verification docs go to private KYC storage', /kyc-documents\/\$\{USER\.uid\}\//.test(studio));
  ck('studio: rights attestation required before saving a split', /rightsAttestation: ME\.rightsAttestation\.version/.test(studio));
  ck('studio: analytics panel (aggregates)', /creator\.analytics/.test(studio));
  ck('studio: split sent as INTEGER basis points', /Math\.round\(Number\(e\.target\.value\) \* 100\)/.test(studio));
  ck('studio: master upload goes through the server-issued target', /film\.mediaUploadTarget/.test(studio) && /film\.attachMedia/.test(studio));

  console.log('\n── category authority ──');
  const cat = rd('category.js');
  ck('`creator` is a key of the canonical categoryMeta', /creator:\s*\{ title:"Creator — Films & Media"/.test(cat));
  ck('the key hands over to the live catalogue', /categoryMeta\[category\]\.href/.test(cat));
  ck('category.html pill links the canonical key', /category\.html\?cat=creator/.test(rd('category.html')));
  ck('Entertainment hub links Creator (inside the hub, not a new hub)', /href="creator\.html"/.test(rd('entertainment.html')));

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS CRASHED', e); process.exit(2); });
