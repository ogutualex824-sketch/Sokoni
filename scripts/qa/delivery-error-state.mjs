/**
 * A failed delivery query must NOT read as "you have no deliveries".
 *
 * WHY THIS IS A RUNTIME TEST AND NOT A CODE REVIEW
 * The defect was invisible precisely because the failure path produced a calm,
 * plausible screen. Reading the source proves an error callback is *present*;
 * only running it proves the seller is *told*. So this breaks the query for real
 * and reads what the page renders.
 *
 * HOW THE FAILURE IS INDUCED
 * Firestore's listen channel is blocked at the network layer, which is what an
 * offline device, a rules rejection or an App Check refusal all look like to the
 * SDK: onSnapshot's error callback fires. No app code is stubbed, so what is
 * exercised is the real handler shipping in the page.
 *
 * THE ASSERTION THAT MATTERS
 * Not merely "an error appeared" — that the EMPTY wording is absent. The bug was
 * showing "No active deliveries right now" on failure, and a page could show both.
 */

const ORIGIN = process.env.QA_ORIGIN || 'https://mysokoni.co.ke';
const EMAIL = process.env.QA_EMAIL, PASS = process.env.QA_PASS;

const step = (name, ok, detail) => ({ step: name, ok: !!ok, detail: detail === undefined ? null : detail });

const EMPTY_WORDING = /No active deliveries right now/i;
const ERROR_WORDING = /couldn't load deliveries|could not load deliveries/i;

export default async function run(page) {
  const out = [];
  if (!EMAIL || !PASS) return { fatal: 'QA_EMAIL and QA_PASS required' };

  const ctx = page.context();
  await ctx.addInitScript(() => {
    try {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.register = () => Promise.resolve({
          update() {}, unregister() { return Promise.resolve(true); },
        });
      }
    } catch (_) {}
  });
  await ctx.addInitScript(({ email, pass }) => {
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
    setInterval(() => {
      let el = document.getElementById('__qa_state');
      if (!el && document.body) {
        el = document.createElement('div');
        el.id = '__qa_state'; el.style.display = 'none';
        document.body.appendChild(el);
      }
      if (el) el.textContent = JSON.stringify({ signedIn: window.__QA.signedIn, error: window.__QA.error });
    }, 150);
  }, { email: EMAIL, pass: PASS });

  await page.goto(ORIGIN + '/seller', { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 100; i++) {
    const s = await page.evaluate(() => {
      const el = document.getElementById('__qa_state');
      try { return el ? JSON.parse(el.textContent) : null; } catch (_) { return null; }
    });
    if (s && s.signedIn) break;
    await page.waitForTimeout(300);
  }

  /* Break the listen channel BEFORE the hub loads, so the very first subscription
     fails rather than succeeding and then being interrupted. */
  await page.route('**/google.firestore.v1.Firestore/Listen/**', r => r.abort());
  await page.route('**/firestore.googleapis.com/**/channel**', r => r.abort());

  await page.goto(ORIGIN + '/seller-delivery.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

  /* Wait for a settled state — any of the three — instead of a fixed delay, so a
     slow error is not mistaken for a missing one. */
  await page.waitForFunction(() => {
    const el = document.getElementById('activeList');
    if (!el) return false;
    const t = el.innerText || '';
    return /couldn't load|could not load|No active deliveries|Order #/i.test(t);
  }, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const seen = await page.evaluate(() => {
    const el = document.getElementById('activeList');
    const t = el ? (el.innerText || '') : '';
    return {
      text: t.replace(/\s+/g, ' ').trim().slice(0, 200),
      hasRetry: !!(el && el.querySelector('button')),
      retryLabel: el && el.querySelector('button') ? el.querySelector('button').textContent.trim() : null,
    };
  });

  out.push(step('the failed query produced a visible state at all', seen.text.length > 0, seen.text));
  out.push(step('it does NOT claim the seller has no deliveries',
    !EMPTY_WORDING.test(seen.text), seen.text));
  out.push(step('it says the load failed', ERROR_WORDING.test(seen.text), seen.text));
  out.push(step('a Retry action is offered', seen.hasRetry, seen.retryLabel));

  /* Recovery: with the channel restored, Retry must return the list to a real
     state. An error state that cannot be left is only half a fix. */
  await page.unroute('**/google.firestore.v1.Firestore/Listen/**');
  await page.unroute('**/firestore.googleapis.com/**/channel**');
  if (seen.hasRetry) {
    await page.evaluate(() => {
      const el = document.getElementById('activeList');
      const b = el && el.querySelector('button');
      if (b) b.click();
    });
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => {
      const el = document.getElementById('activeList');
      return (el ? (el.innerText || '') : '').replace(/\s+/g, ' ').trim().slice(0, 160);
    });
    out.push(step('Retry leaves the error state', !ERROR_WORDING.test(after) || /Loading/i.test(after), after));
  }

  return {
    verdict: out.every(s => s.ok) ? 'PASS — a failed query is reported as a failure, not as "no deliveries"'
                                  : 'FAIL — see failing steps',
    passed: out.filter(s => s.ok).length,
    failed: out.filter(s => !s.ok).length,
    results: out,
  };
}
