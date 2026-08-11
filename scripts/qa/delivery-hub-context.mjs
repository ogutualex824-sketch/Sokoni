/**
 * Seller "Riders"/"Delivery Hub" must open the seller's delivery operation —
 * never a personal rider account.
 *
 * WHY RUNTIME AND NOT A URL CHECK
 * A route table asserting `src === 'seller-delivery.html'` proves the table, not the
 * product. The defect being guarded against is a CONTEXT error: the seller arrived at
 * a page that renders someone's rider account. So the test clicks the real control and
 * inspects the document that actually loads — its title, its markers, and the absence
 * of rider-app chrome.
 *
 * THREE CONTEXTS THAT MUST NEVER MERGE
 *   driver.html            a rider's OWN account   (go online, my earnings, my trips)
 *   seller-delivery.html   the seller's operation  (my shop's deliveries + who can carry them)
 *   delivery-tracking.html one order, for whoever is party to it
 *
 * Run: node scripts/qa/run-delivery-hub-check.js
 */

const ORIGIN = process.env.QA_ORIGIN || 'https://mysokoni.co.ke';
const EMAIL = process.env.QA_EMAIL;
const PASS = process.env.QA_PASS;

const step = (name, ok, detail) => ({ step: name, ok: !!ok, detail: detail === undefined ? null : detail });

/* Markers that identify a RIDER'S OWN ACCOUNT. If any appear in the seller's hub,
   the context regression is back. Chosen from driver.html's own vocabulary. */
const RIDER_APP_MARKERS = [
  'Go Online', 'My Earnings', 'Available Balance', 'Accept Delivery',
  'My Trips', 'Rider Dashboard', 'Driver Dashboard',
];

async function signIn(page) {
  await page.addInitScript(({ email, pass }) => {
    window.__QA = { signedIn: false, error: null, started: false };
    const tryLogin = () => {
      if (!window.firebaseSDK || !window.firebaseSDK.signInWithEmailAndPassword) return false;
      if (window.__QA.started) return true;
      window.__QA.started = true;
      window.firebaseSDK.signInWithEmailAndPassword(email, pass)
        .then(() => { window.__QA.signedIn = true; })
        .catch((e) => { window.__QA.error = String(e && (e.code || e.message)); });
      return true;
    };
    if (!tryLogin()) {
      const iv = setInterval(() => { if (tryLogin()) clearInterval(iv); }, 100);
      setTimeout(() => clearInterval(iv), 20000);
    }
    const mirror = () => {
      let el = document.getElementById('__qa_state');
      if (!el && document.body) {
        el = document.createElement('div');
        el.id = '__qa_state'; el.style.display = 'none';
        document.body.appendChild(el);
      }
      if (el) el.textContent = JSON.stringify({ signedIn: window.__QA.signedIn, error: window.__QA.error });
    };
    setInterval(mirror, 150);
  }, { email: EMAIL, pass: PASS });
}

async function waitSignedIn(page, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const s = await page.evaluate(() => {
      const el = document.getElementById('__qa_state');
      try { return el ? JSON.parse(el.textContent) : null; } catch (_) { return null; }
    });
    if (s && s.signedIn) return { ok: true };
    if (s && s.error) return { ok: false, error: s.error };
    if (Date.now() - t0 > ms) return { ok: false, error: 'timeout' };
    await page.waitForTimeout(300);
  }
}

export default async function run(page) {
  const out = [];
  if (!EMAIL || !PASS) return { fatal: 'QA_EMAIL and QA_PASS required' };

  /* The SW would otherwise serve these navigations from cache and mask a routing change. */
  await page.addInitScript(() => {
    try {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.register = () => Promise.resolve({
          update() {}, unregister() { return Promise.resolve(true); },
        });
      }
    } catch (_) {}
  });
  await signIn(page);

  await page.goto(ORIGIN + '/merchant', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const si = await waitSignedIn(page);
  out.push(step('signed in as the QA seller', si.ok, si.error || EMAIL));
  if (!si.ok) return { results: out, verdict: 'BLOCKED: sign-in failed' };
  await page.waitForTimeout(6000);

  /* The route TABLE is asserted in Node by the runner (it is a module, and this driver
     evaluates in an isolated world where page globals are invisible). What happens here
     is the part a table cannot prove: clicking the control and inspecting what loads. */

  /* ── Click the real control and inspect what loads ────────────────────────── */
  const clicked = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-route],[data-id],button,a')];
    const hit = els.find(e => {
      const key = (e.getAttribute('data-route') || e.getAttribute('data-id') || '').toLowerCase();
      const txt = (e.textContent || '').trim().toLowerCase();
      return key === 'riders' || key === 'deliveries' ||
             txt === 'riders' || txt === 'delivery hub' || txt === 'deliveries';
    });
    if (!hit) return { found: false, sample: els.slice(0, 40).map(e => (e.textContent || '').trim()).filter(Boolean).slice(0, 25) };
    hit.click();
    return { found: true, label: (hit.textContent || '').trim() };
  });
  out.push(step('found and clicked the seller delivery control', clicked.found, clicked));

  let loaded = { url: null, title: null, riderMarkers: [], hasDeliveryHub: false, hasRidersTab: false, bodyChars: 0 };
  if (clicked.found) {
    await page.waitForTimeout(9000);
    /* The module opens in an iframe panel; inspect the frame, not the shell. */
    loaded = await page.evaluate((markers) => {
      const frames = [...document.querySelectorAll('iframe')]
        .filter(f => f.offsetParent !== null && f.src && f.src !== 'about:blank');
      const f = frames[frames.length - 1];
      let doc = null;
      try { doc = f && (f.contentDocument || null); } catch (_) { doc = null; }
      const text = doc && doc.body ? (doc.body.innerText || '') : '';
      return {
        url: f ? f.src : null,
        title: doc ? doc.title : null,
        bodyChars: text.length,
        riderMarkers: markers.filter(m => text.includes(m)),
        hasDeliveryHub: /Delivery Dashboard|Delivery Hub/i.test(text),
        hasRidersTab: !!(doc && doc.querySelector('.sd-tab[data-tab="riders"]')),
        hasDeliveryTabs: !!(doc && doc.querySelector('.sd-tab[data-tab="active"]')),
      };
    }, RIDER_APP_MARKERS);
  }

  out.push(step('the opened module is the seller delivery surface',
    /seller-delivery\.html/.test(loaded.url || ''), loaded.url));
  out.push(step('it is NOT the rider account app',
    !/\/driver\.html|\/rider-dashboard\.html|\/food-rider\.html/.test(loaded.url || ''), loaded.url));
  out.push(step('no rider-account chrome is present',
    (loaded.riderMarkers || []).length === 0, loaded.riderMarkers));
  out.push(step('the page rendered something (not a blank board)',
    (loaded.bodyChars || 0) > 80, loaded.bodyChars));
  out.push(step('delivery tabs are present', !!loaded.hasDeliveryTabs, loaded));
  out.push(step('a Riders roster exists inside the hub', !!loaded.hasRidersTab, loaded.hasRidersTab));

  /* ── The hub works with no map. seller-delivery.html ships no map at all, so this
        asserts the property rather than simulating a failure: deliveries and riders
        must be reachable without any map surface existing. ───────────────────────── */
  const mapless = await page.evaluate(() => {
    const f = [...document.querySelectorAll('iframe')].filter(x => x.offsetParent !== null).pop();
    let doc = null;
    try { doc = f && f.contentDocument; } catch (_) { return null; }
    if (!doc) return null;
    const text = doc.body ? (doc.body.innerText || '') : '';
    return {
      mentionsHeatmapOff: /heatmap off/i.test(text),
      listPresent: !!doc.getElementById('activeList'),
      ridersPresent: !!doc.getElementById('ridersList'),
    };
  });
  out.push(step('no "Heatmap OFF" is the seller experience',
    mapless ? !mapless.mentionsHeatmapOff : false, mapless));
  out.push(step('delivery list and rider roster exist independently of any map',
    !!(mapless && mapless.listPresent && mapless.ridersPresent), mapless));

  return {
    verdict: out.every(s => s.ok) ? 'PASS — seller Rider/Deliveries opens the seller delivery hub'
                                  : 'FAIL — see failing steps',
    passed: out.filter(s => s.ok).length,
    failed: out.filter(s => !s.ok).length,
    results: out,
  };
}
