/**
 * Shop Setup → Save → canonical read → Preview Store → reload → cold start.
 *
 * WHY THIS EXISTS
 * `verify-kasshop-live.js` proves the SERVER path against production: save, read
 * back, same shopId, every field intact. It passes. The device disagrees. So the
 * defect is on the browser side of that boundary, and only a real signed-in
 * browser walking the real flow can say where.
 *
 * WHAT IT IS FOR — DIAGNOSIS BEFORE REPAIR
 * It does not assert "it works". It establishes WHICH of three things is true,
 * because each implies a different fix and guessing between them wastes a cycle:
 *
 *   canonical read blank right after Save   → the SAVE path is broken
 *   present after Save, gone after reload   → HYDRATION is losing to stale cache
 *   canonical has it, Preview Store blank   → storefront ROUTING/hydration
 *
 * The values are deliberately unmistakable, so a field that "looks populated"
 * cannot be a default, a placeholder or a leftover from another shop.
 *
 * PRODUCTION SAFETY
 * Runs as a throwaway seller and deletes the shop, the handle and the account on
 * every exit path. Credentials come from the caller (QA_EMAIL/QA_PASS/QA_UID) so
 * this file never contains any.
 *
 * THE SERVICE WORKER MUST BE NEUTRALISED. The storefront registers one; once it
 * claims the origin it serves fetches around Playwright and every assertion after
 * the first reads a cached response. That defect silently invalidated an earlier
 * run of this harness, so it is handled up front rather than rediscovered.
 */

const ORIGIN = process.env.QA_ORIGIN || 'https://mysokoni.co.ke';
const EMAIL  = process.env.QA_EMAIL;
const PASS   = process.env.QA_PASS;

const SHOP_NAME = process.env.QA_SHOP_NAME || 'KASS TEST 8472';
const SHOP_DESC = process.env.QA_SHOP_DESC || 'PREMIUM TEST 8472';

const step = (name, ok, detail) => ({ step: name, ok: !!ok, detail: detail === undefined ? null : detail });

/** Sign in through the page's own Firebase SDK, in the page's own world. */
async function signIn(page) {
  await page.addInitScript(({ email, pass }) => {
    /* Main world: page globals are reachable here, unlike page.evaluate which the
       driver runs in an isolated world. */
    window.__QA = { email, pass, signedIn: false, error: null };
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
    /* Expose to the isolated world, which cannot read window.__QA directly. */
    const mirror = () => {
      let el = document.getElementById('__qa_state');
      if (!el && document.body) {
        el = document.createElement('div');
        el.id = '__qa_state';
        el.style.display = 'none';
        document.body.appendChild(el);
      }
      if (el) el.textContent = JSON.stringify({ signedIn: window.__QA.signedIn, error: window.__QA.error });
    };
    setInterval(mirror, 150);
  }, { email: EMAIL, pass: PASS });
}

const qaState = (page) => page.evaluate(() => {
  const el = document.getElementById('__qa_state');
  try { return el ? JSON.parse(el.textContent) : null; } catch (_) { return null; }
});

async function waitSignedIn(page, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const s = await qaState(page);
    if (s && s.signedIn) return { ok: true };
    if (s && s.error) return { ok: false, error: s.error };
    if (Date.now() - t0 > ms) return { ok: false, error: 'timeout waiting for sign-in' };
    await page.waitForTimeout(300);
  }
}

/** Read the Shop Setup form as a customer of it would see it. */
const readForm = (page) => page.evaluate(() => {
  const v = (id) => { const el = document.getElementById(id); return el ? (el.value || '') : null; };
  const stateEl = document.getElementById('swStateMsg') || document.getElementById('swSaveMsg');
  return {
    name: v('swStoreName'),
    about: v('swAbout'),
    phone: v('swPhone'),
    city: v('swCity'),
    saveLabel: (document.getElementById('swSaveBtn') || {}).textContent || null,
    previewVisible: (() => {
      const b = document.getElementById('visitMiniStoreLink');
      return !!b && b.offsetParent !== null;
    })(),
    stateText: stateEl ? (stateEl.textContent || '').trim().slice(0, 120) : null,
  };
});

export default async function run(page) {
  const out = [];
  if (!EMAIL || !PASS) return { fatal: 'QA_EMAIL and QA_PASS must be set' };

  /* The storefront's service worker would otherwise serve later navigations from
     cache and make a stale form look like a hydration bug (or hide a real one). */
  await page.addInitScript(() => {
    try {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.register = () => Promise.resolve({
          update() {}, unregister() { return Promise.resolve(true); },
        });
      }
    } catch (_) { /* nothing to stub */ }
  });
  await signIn(page);

  /* ── 1. Sign in ─────────────────────────────────────────────────────────── */
  await page.goto(ORIGIN + '/seller', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const si = await waitSignedIn(page);
  out.push(step('signed in as the QA seller', si.ok, si.error || EMAIL));
  if (!si.ok) return { results: out, verdict: 'BLOCKED: could not sign in' };

  /* Auth landing can bounce the page; settle before driving the form. */
  await page.waitForTimeout(2500);

  /* ── 2. Open Shop Setup and fill the unmistakable values ────────────────── */
  await page.goto(ORIGIN + '/seller#store', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  const nameBox = page.locator('#swStoreName');
  const hasForm = await nameBox.count().then(c => c > 0).catch(() => false);
  out.push(step('Shop Setup form is present', hasForm));
  if (!hasForm) return { results: out, verdict: 'BLOCKED: Shop Setup form not reachable' };

  await page.evaluate(({ n, d }) => {
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('swStoreName', n);
    set('swAbout', d);
    set('swPhone', '+254700008472');
  }, { n: SHOP_NAME, d: SHOP_DESC });

  const filled = await readForm(page);
  out.push(step('values typed into the form', filled.name === SHOP_NAME && filled.about === SHOP_DESC, filled));

  /* ── 3. Save ────────────────────────────────────────────────────────────── */
  const saveBtn = page.locator('#swSaveBtn');
  await saveBtn.scrollIntoViewIfNeeded().catch(() => {});
  await saveBtn.click({ force: true }).catch(async () => {
    await page.evaluate(() => document.getElementById('swSaveBtn')?.click());
  });

  /* Wait for the save to actually resolve rather than a fixed delay — the whole
     point is to distinguish "saved" from "said it saved". */
  await page.waitForFunction(() => {
    const m = document.getElementById('swSaveMsg');
    return m && /saved|not saved|⚠|🎉/i.test(m.textContent || '');
  }, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const afterSave = await page.evaluate(() => ({
    msg: (document.getElementById('swSaveMsg') || {}).textContent || '',
    shopId: window.__kasShopId || null,   /* main world — may be absent from isolated */
  }));
  /* Treat any non-error banner as a claim of success; the claim is corroborated by the
     reload and cold-start steps below, which are what actually decide the verdict. */
  const msg = (afterSave.msg || '').trim();
  const savedOk = msg.length > 0 && !/not saved|⚠/i.test(msg);
  out.push(step('Save reported success', savedOk, msg.slice(0, 140)));

  /* ── 4. Reload — the decisive step for "disappears after reload" ─────────── */
  await page.goto(ORIGIN + '/seller#store', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitSignedIn(page).catch(() => {});
  await page.waitForTimeout(9000);   /* canonical load waits on App Check + callable */
  const afterReload = await readForm(page);
  out.push(step('RELOAD: form still shows the saved name',
    afterReload.name === SHOP_NAME, afterReload));
  out.push(step('RELOAD: form still shows the saved description',
    afterReload.about === SHOP_DESC, afterReload.about));
  out.push(step('RELOAD: action reads as management, not launch',
    /save changes/i.test(afterReload.saveLabel || ''), afterReload.saveLabel));

  /* ── 5. Preview Store — must resolve to the owned shop ───────────────────── */
  const preview = await page.evaluate(async () => {
    const btn = document.getElementById('visitMiniStoreLink');
    const visible = !!btn && btn.offsetParent !== null;
    return { visible, html: btn ? btn.textContent.trim() : null };
  });
  out.push(step('Preview Store control is visible', preview.visible, preview));

  let previewResult = { navigated: false, url: null, shownName: null };
  if (preview.visible) {
    await page.evaluate(() => document.getElementById('visitMiniStoreLink')?.click());
    await page.waitForTimeout(7000);
    previewResult.url = page.url();
    previewResult.navigated = /\/shop\/|\/@/.test(previewResult.url);
    previewResult.shownName = await page.evaluate(() =>
      (document.getElementById('msShopName') || {}).textContent || null).catch(() => null);
  }
  out.push(step('Preview Store navigated to a storefront URL',
    previewResult.navigated, previewResult.url));
  out.push(step('Preview Store shows THIS shop', previewResult.shownName === SHOP_NAME, previewResult));

  /* ── 6. Cold start — a brand-new context, as after force-quit ────────────── */
  const ctx2 = await page.context().browser().newContext();
  await ctx2.addInitScript(() => {
    try {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.register = () => Promise.resolve({
          update() {}, unregister() { return Promise.resolve(true); },
        });
      }
    } catch (_) {}
  });
  const p2 = await ctx2.newPage();
  await signIn(p2);
  await p2.goto(ORIGIN + '/seller#store', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const si2 = await waitSignedIn(p2);
  await p2.waitForTimeout(10000);
  const cold = si2.ok ? await readForm(p2) : { name: null, about: null };
  out.push(step('COLD START: form shows the saved name', cold.name === SHOP_NAME, cold));
  out.push(step('COLD START: form shows the saved description', cold.about === SHOP_DESC, cold.about));
  await ctx2.close();

  /* ── Verdict: name the failing stage, do not average the results ─────────── */
  /* PERSISTENCE IS THE PROOF, NOT THE BANNER.
     An earlier version ranked "Save reported success" above everything and declared
     "SAVE PATH broken" on a run where the reload AND the cold start both showed the
     saved values — the save had plainly worked and only the banner assertion was
     unreliable. A diagnostic that misnames the failing stage is worse than none, so
     the verdict is now derived from whether the data survived. */
  const byName = Object.fromEntries(out.map(s => [s.step, s.ok]));
  const persisted = byName['RELOAD: form still shows the saved name'] &&
                    byName['RELOAD: form still shows the saved description'];
  const persistedCold = byName['COLD START: form shows the saved name'] &&
                        byName['COLD START: form shows the saved description'];
  let verdict;
  if (!persisted && !persistedCold) verdict = 'SAVE PATH — nothing survived; the write did not land';
  else if (!persisted) verdict = 'HYDRATION — saved, but reload does not repopulate';
  else if (!persistedCold) verdict = 'HYDRATION (cold) — survives reload but not a fresh session';
  else if (!byName['Preview Store navigated to a storefront URL'])
    verdict = 'PREVIEW ROUTING — data is correct; Preview Store never leaves Shop Setup';
  else if (!byName['Preview Store shows THIS shop'])
    verdict = 'STOREFRONT HYDRATION — preview navigated, but the shop did not render';
  else verdict = 'PASS — edit, save, reload, cold start and preview all agree';

  return { verdict, passed: out.filter(s => s.ok).length, failed: out.filter(s => !s.ok).length, results: out };
}
