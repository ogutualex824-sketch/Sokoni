#!/usr/bin/env node
/* test-agreement-acknowledge-browser.js — the REAL agreement-acknowledge.html in Chromium over the page harness.
 *
 * PROVES  the page lists only the signed-in user's applications (another uid's is absent); the Kasindi-shaped one is
 *         offered for acknowledgement while a current one is shown as acknowledged and a healthcare one is pointed
 *         elsewhere; the confirm button is disabled until the box is ticked; the write is called ONCE with exactly the
 *         intake fields dated now (not July) for the right document; success renders only after the write resolved;
 *         a failed write shows the failure and never claims success; signed-out shows the sign-in note; no horizontal
 *         overflow at 390 px.
 *
 *   node scripts/test-agreement-acknowledge-browser.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1'; process.env.GCLOUD_PROJECT = 'demo-ack-browser';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const Path = require('path'); const ROOT = Path.resolve(__dirname, '..');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const { makePageHarness } = require('./lib/page-harness.js');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 200) + ']' : '')); ok ? pass++ : fail++; };
const V = require(Path.join(ROOT, 'sokoni-merchant-application.js')).AGREEMENT_VERSION;
(async () => {
  await db.doc('applications/PRVMS7IACKG').set({ uid: 'kasindi', name: 'Kasindi holdings limited', type: 'Cleaning Company / Housekeeper', role: 'provider', hub: 'service', status: 'approved', statusCanonical: 'approved', decidedBy: 'reindex', decidedAt: '2026-07-30T15:11:12.000Z', createdAt: '2026-07-30T12:44:56.000Z' });
  await db.doc('applications/CUR1').set({ uid: 'kasindi', name: 'Second venture', type: 'Plumber', role: 'provider', status: 'pending', agreementAccepted: true, agreementVersion: V, agreementAcceptedAt: '2026-09-10T08:00:00.000Z' });
  await db.doc('applications/HC1').set({ uid: 'kasindi', name: 'Kasindi clinic', type: 'Clinic', role: 'health', hub: 'healthcare', status: 'pending' });
  await db.doc('applications/OTHER1').set({ uid: 'other', name: 'Other Co', type: 'Plumber', role: 'provider', status: 'approved' });
  const H = makePageHarness({ db, root: ROOT, callables: {} });
  await H.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  /* I/O seam: the harness cannot perform client writes, so the page's `write` is replaced with a recorder; the
     surface's logic (eligibility, gating, payload, success-after-write) is the real module. */
  const seam = (mode) => `window.__writes = []; window.SokoniAgreementAckDeps = { fetchTerms: () => Promise.resolve('<p>TERMS BODY</p>'), write: (id, patch) => { window.__writes.push({ id, patch }); return ${mode === 'fail' ? "Promise.reject(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }))" : 'Promise.resolve()'}; } };`;
  try {
    say('\n── signed in as kasindi, 390px ──');
    let page = await H.page(browser, { user: { uid: 'kasindi', claims: {} }, viewport: { width: 390, height: 800 } });
    await page.addInitScript(seam('ok'));
    await page.goto(H.BASE + '/agreement-acknowledge.html');
    await page.waitForSelector('#ackHost[data-ack-state="ready"]', { timeout: 15000 });
    const rows = await page.$$eval('[data-ack-app]', (els) => els.map((e) => [e.getAttribute('data-ack-app'), e.getAttribute('data-ack-eligible')]));
    ck('lists the three own applications, not the other uid\'s', rows.length === 3 && !rows.some((r) => r[0] === 'OTHER1'), rows);
    const st = Object.fromEntries(rows);
    ck('Kasindi application → eligible; current one → current; healthcare → versioned_elsewhere', st.PRVMS7IACKG === 'eligible' && st.CUR1 === 'current' && st.HC1 === 'versioned_elsewhere', st);
    ck('no horizontal overflow at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await page.click('[data-ack-open="PRVMS7IACKG"]');
    await page.waitForSelector('[data-ack-confirm]');
    ck('the terms body is rendered in the panel', (await page.textContent('[data-ack-terms]')).includes('TERMS BODY'));
    ck('confirm is DISABLED until the box is ticked', await page.$eval('[data-ack-confirm]', (b) => b.disabled));
    await page.click('[data-ack-confirm]', { force: true });
    ck('clicking the disabled button writes nothing', (await page.evaluate(() => window.__writes.length)) === 0);
    await page.check('[data-ack-tick]');
    ck('ticking enables confirm', !(await page.$eval('[data-ack-confirm]', (b) => b.disabled)));
    const t0 = Date.now();
    await page.click('[data-ack-confirm]');
    await page.waitForSelector('[data-ack-app="PRVMS7IACKG"][data-ack-eligible="current"]', { timeout: 10000 });
    const writes = await page.evaluate(() => window.__writes);
    ck('exactly ONE write, to applications/PRVMS7IACKG', writes.length === 1 && writes[0].id === 'PRVMS7IACKG', writes);
    const w = writes[0].patch;
    ck('payload = exactly the intake fields + marker, current version', Object.keys(w).sort().join(',') === 'agreementAccepted,agreementAcceptedAt,agreementAcknowledgedSurface,agreementVersion' && w.agreementAccepted === true && w.agreementVersion === V, w);
    const at = Date.parse(w.agreementAcceptedAt);
    ck('agreementAcceptedAt is NOW (within the click window), not July', at >= t0 - 2000 && at <= Date.now() + 2000 && !w.agreementAcceptedAt.startsWith('2026-07'), w.agreementAcceptedAt);
    ck('success state rendered only after the write resolved (row now current, data-ack-last set)', (await page.getAttribute('#ackHost', 'data-ack-last')) === 'PRVMS7IACKG');
    await page.close();

    say('\n── failed write never claims success ──');
    page = await H.page(browser, { user: { uid: 'kasindi', claims: {} }, viewport: { width: 1280, height: 900 } });
    await page.addInitScript(seam('fail'));
    await page.goto(H.BASE + '/agreement-acknowledge.html');
    await page.waitForSelector('#ackHost[data-ack-state="ready"]', { timeout: 15000 });
    await page.click('[data-ack-open="PRVMS7IACKG"]'); await page.waitForSelector('[data-ack-tick]'); await page.check('[data-ack-tick]'); await page.click('[data-ack-confirm]');
    await page.waitForFunction(() => /NOT saved/.test((document.querySelector('[data-ack-result]') || {}).textContent || ''), null, { timeout: 10000 });
    ck('the failure is shown ("NOT saved") and the row stays eligible', (await page.getAttribute('[data-ack-app="PRVMS7IACKG"]', 'data-ack-eligible')) === 'eligible' && (await page.getAttribute('#ackHost', 'data-ack-error')) === 'permission-denied');
    ck('confirm re-enabled for a retry', !(await page.$eval('[data-ack-confirm]', (b) => b.disabled)));
    await page.close();

    say('\n── signed out ──');
    page = await H.page(browser, { user: null, viewport: { width: 1280, height: 900 } });
    await page.addInitScript(seam('ok'));
    await page.goto(H.BASE + '/agreement-acknowledge.html');
    await page.waitForSelector('#ackHost[data-ack-state="signed_out"]', { timeout: 15000 });
    ck('signed out → sign-in note, nothing listed, nothing written', (await page.$('[data-ack-signed-out]')) !== null && (await page.$$('[data-ack-app]')).length === 0 && (await page.evaluate(() => window.__writes.length)) === 0);
    await page.close();
  } finally { await browser.close(); await H.stop(); }
  say('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('SUITE CRASH ' + (e.stack || e)); process.exit(2); });
