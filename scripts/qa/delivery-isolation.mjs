/**
 * Seller B must not see Seller A's deliveries — proved with REAL deliveries.
 *
 * WHY THIS EXISTS SEPARATELY FROM delivery-hub-context.mjs
 * That test proved the seller lands on the right SURFACE. It could not prove
 * isolation, because its probe seller had no deliveries: an empty hub looks
 * identical whether isolation works or the query is simply returning nothing.
 * Reporting "B sees no deliveries" from an empty database is the classic
 * false pass, so this seeds real records and asserts both directions.
 *
 * THE CONTROL IS THE POINT
 *   A sees A's delivery      ← MUST pass, or nothing below means anything
 *   B does not see A's       ← the isolation claim
 *   B sees B's own           ← proves B's hub works at all
 *
 * Without the first and third, "B sees nothing" is satisfied by a broken page.
 *
 * Driven entirely through the product: each seller signs in and reads their own
 * hub. The Firestore rule is exercised by the app's real query, not by a
 * hand-written one that might differ from what ships.
 */

const ORIGIN = process.env.QA_ORIGIN || 'https://mysokoni.co.ke';

const A_EMAIL = process.env.QA_A_EMAIL, A_PASS = process.env.QA_A_PASS;
const B_EMAIL = process.env.QA_B_EMAIL, B_PASS = process.env.QA_B_PASS;
/* Unmistakable per-seller markers written into the seeded deliveries. */
const A_MARK = process.env.QA_A_MARK, B_MARK = process.env.QA_B_MARK;

const step = (name, ok, detail) => ({ step: name, ok: !!ok, detail: detail === undefined ? null : detail });

function installSignIn(target, email, pass) {
  return target.addInitScript(({ email, pass }) => {
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
  }, { email, pass });
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

/** Open the hub directly and read what its own real-time query rendered. */
async function readHub(page) {
  await page.goto(ORIGIN + '/seller-delivery.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  /* Wait for the snapshot to paint rather than a fixed delay: an unrendered list
     would otherwise read as "no deliveries" and pass the isolation assertion for
     entirely the wrong reason. */
  await page.waitForFunction(() => {
    const el = document.getElementById('activeList');
    return el && el.innerHTML.trim().length > 0;
  }, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const el = document.getElementById('activeList');
    return {
      html: el ? el.innerHTML : '',
      text: el ? (el.innerText || '') : '',
      cards: el ? el.querySelectorAll('.sd-card').length : -1,
      empty: el ? /No active deliveries/i.test(el.innerText || '') : false,
    };
  });
}

export default async function run(page) {
  const out = [];
  if (!A_EMAIL || !B_EMAIL) return { fatal: 'QA_A_* and QA_B_* env required' };

  const browser = page.context().browser();
  const noSW = () => {
    try {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.register = () => Promise.resolve({
          update() {}, unregister() { return Promise.resolve(true); },
        });
      }
    } catch (_) {}
  };

  /* APP CHECK IS ENFORCED ON FIRESTORE, AND WITHOUT THIS THE TEST LIES.
     A headless browser cannot pass reCAPTCHA, so exchangeRecaptchaV3Token 403s and
     every Firestore read is refused BEFORE rules are consulted. The first run of this
     harness showed both sellers with zero deliveries — which satisfies "B cannot see
     A's" for a reason that has nothing to do with isolation. The controls caught it.
     The SDK honours this global when it is set before App Check initialises, and
     addInitScript runs ahead of the page's own scripts. The token is registered and
     revoked by the runner; a lingering debug token is itself an App Check bypass. */
  const withAppCheck = (ctx) => ctx.addInitScript((tok) => {
    try { self.FIREBASE_APPCHECK_DEBUG_TOKEN = tok; } catch (_) {}
  }, process.env.QA_APPCHECK_TOKEN);

  /* ── Seller A ─────────────────────────────────────────────────────────────── */
  const ctxA = await browser.newContext();
  await withAppCheck(ctxA);
  await ctxA.addInitScript(noSW);
  await installSignIn(ctxA, A_EMAIL, A_PASS);
  const pA = await ctxA.newPage();
  await pA.goto(ORIGIN + '/seller', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const siA = await waitSignedIn(pA);
  out.push(step('Seller A signed in', siA.ok, siA.error || A_EMAIL));

  let hubA = { text: '', cards: -1 };
  if (siA.ok) hubA = await readHub(pA);
  /* CONTROL — if A cannot see A's own delivery, every "B sees nothing" below is
     uninformative and must not be reported as isolation working. */
  out.push(step('CONTROL: Seller A sees their OWN delivery',
    hubA.text.includes(A_MARK), { cards: hubA.cards, sawMark: hubA.text.includes(A_MARK) }));
  out.push(step("CONTROL: Seller A does NOT see Seller B's delivery",
    !hubA.text.includes(B_MARK), { sawOther: hubA.text.includes(B_MARK) }));
  await ctxA.close();

  /* ── Seller B — a completely separate browser context ─────────────────────── */
  const ctxB = await browser.newContext();
  await withAppCheck(ctxB);
  await ctxB.addInitScript(noSW);
  await installSignIn(ctxB, B_EMAIL, B_PASS);
  const pB = await ctxB.newPage();
  await pB.goto(ORIGIN + '/seller', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const siB = await waitSignedIn(pB);
  out.push(step('Seller B signed in', siB.ok, siB.error || B_EMAIL));

  let hubB = { text: '', cards: -1 };
  if (siB.ok) hubB = await readHub(pB);
  out.push(step("ISOLATION: Seller B does NOT see Seller A's delivery",
    !hubB.text.includes(A_MARK), { sawOther: hubB.text.includes(A_MARK), cards: hubB.cards }));
  out.push(step('CONTROL: Seller B sees their OWN delivery',
    hubB.text.includes(B_MARK), { cards: hubB.cards, sawMark: hubB.text.includes(B_MARK) }));

  await ctxB.close();
  /* The rules layer — B fetching A's document by id with B's own token — is asserted
     by the RUNNER, in Node. It cannot be done here: this driver evaluates in an
     isolated world where `window.firebaseAuth` (a page global) is invisible, so the
     check returned "no user in page context" and failed for a reason unrelated to
     security. A test that cannot reach its subject must not report on it. */

  const failed = out.filter(s => !s.ok);
  /* A control failure invalidates the isolation claim rather than merely reducing
     the score, so it is named explicitly instead of being averaged away. */
  const controlsOk = out.filter(s => s.step.startsWith('CONTROL')).every(s => s.ok);
  return {
    verdict: !controlsOk
      ? 'INCONCLUSIVE — a control failed, so "B sees nothing" proves nothing'
      : (failed.length === 0 ? 'PASS — real deliveries, and B cannot see A\'s'
                             : 'FAIL — isolation or rules gap'),
    passed: out.length - failed.length,
    failed: failed.length,
    results: out,
  };
}
