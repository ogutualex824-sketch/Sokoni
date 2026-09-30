#!/usr/bin/env node
'use strict';
/**
 * test-secure-release-admin-browser.js — SOKONI Secure Release in AdminOS + super-admin (real Chromium, 2026-09-30).
 *
 * Ports the 4259b92 manual-disbursement queue to Secure Release: approval sends NO money, the OWNER releases, and only a
 * released (owner_confirmed) payout — or a legacy approved one from before Secure Release — is paid by hand, with
 * evidence. The REAL pages run in a REAL browser; only the edges are stubbed (the `firebase` compat global: a fixture
 * Firestore that RECORDS every attempted write, callables that RECORD every call; the admin-entry guard; all network).
 * Harness adapted from scripts/test-payout-manual-queue.js (4259b92).
 *
 * PROVES — AdminOS
 *   AQ1 three queues: Awaiting review (pending) · Awaiting the owner's release (approved Secure Release, NO Mark Paid) ·
 *       Ready to pay (owner_confirmed + legacy approved, WITH Mark Paid); rejected / paid / settled / failed in none
 *   AB1 the banner says approving sends no money and the owner confirms
 *   AP1 approve → the toast reports the SERVER's answer: "no money was sent. The owner must now confirm…"
 *   AR1 reject calls the live adminProcessPayout('rejected') — not the retired finosRequestBankPayout
 *   AM1 Mark Paid on a released payout: no reference / no attestation → no call; valid → exactly ONE
 *       adminProcessPayout('paid', ref, att); the toast reports the state the server recorded
 *   AM2 Mark Paid on a payout the owner has NOT released → refused in the UI, no call
 *   AW  the UI never writes Firestore
 *   AN  every AdminOS nav section still opens its panel
 * PROVES — super-admin
 *   SQ1 pending rows and gateway (ops) rows have no Mark Paid; "Released by the owner — ready to pay" lists the
 *       released + legacy approved payouts only
 *   SM1 Mark Paid asks for the reference and the attestation and sends both; an empty reference sends nothing
 *   SR1 reject sends adminProcessPayout('rejected') with the reason
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
let playwright;
try { playwright = require(path.join(ROOT, 'node_modules', 'playwright')); } catch (e) { console.log('BLOCKED — playwright unavailable: ' + e.message); process.exit(4); }
let pass = 0, fail = 0;
const WATCHDOG = setTimeout(() => { console.log('  FAIL  watchdog — the run did not finish in 6 min'); console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(3); }, 6 * 60 * 1000);
WATCHDOG.unref();
const ok = (c, id, m, d) => { if (c) pass++; else fail++; console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + id + ' ' + m + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 300) + ']' : '')); };

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end(''); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' }); res.end(d); });
});

const T = (iso) => ({ _ms: Date.parse(iso) });
function fixture() {
  return {
    P1: { status: 'pending', sellerUid: 'SELLERPENDING0001', amount: 500, method: 'mpesa', accountNumber: '0700000001', createdAt: T('2026-09-30T09:00:00Z'), secureRelease: true },
    A1: { status: 'approved', secureRelease: true, sellerUid: 'OWNERWAITING0001', amount: 1000, method: 'mpesa', accountNumber: '0712345678', approvedAt: T('2026-09-30T10:10:00Z'),
          approval: { amount: 1000, expiresAt: T('2026-10-03T10:10:00Z') } },
    OC1: { status: 'owner_confirmed', secureRelease: true, sellerUid: 'OWNERRELEASED01', amount: 750, method: 'mpesa', accountNumber: '0722000111', approvedAt: T('2026-09-30T10:00:00Z'), ownerConfirmedAt: T('2026-09-30T11:00:00Z') },
    L1: { status: 'approved', sellerUid: 'LEGACYAPPROVED1', amount: 250, method: 'bank', accountNumber: '0011223344', bankName: 'Test Bank', approvedAt: T('2026-09-28T08:00:00Z') },
    R1: { status: 'rejected', sellerUid: 'SELLERREJECTED001', amount: 111, method: 'mpesa' },
    X1: { status: 'paid', sellerUid: 'SELLERPAID0000001', amount: 222, method: 'mpesa' },
    S1: { status: 'settled_manually', sellerUid: 'SELLERSETTLED0001', amount: 333, method: 'mpesa' },
    F1: { status: 'failed', sellerUid: 'SELLERFAILED00001', amount: 444, method: 'mpesa' },
  };
}

/* ── the stub: runs before ANY page script (from 4259b92, + prompt answers) ── */
function stub(scn) {
  const db = { payoutRequests: scn.fixture };
  window.__calls = []; window.__writes = []; window.__prompts = (scn.prompts || []).slice();
  const ts = (v) => (v && v._ms) ? { toMillis: () => v._ms, toDate: () => new Date(v._ms), seconds: Math.floor(v._ms / 1000) } : v;
  const hydrate = (o) => { const r = {}; for (const k of Object.keys(o)) r[k] = Array.isArray(o[k]) ? o[k].map((e) => (e && typeof e === 'object') ? hydrate(e) : e) : (o[k] && typeof o[k] === 'object' && !o[k]._ms ? hydrate(o[k]) : ts(o[k])); return r; };
  const writeTrap = (what) => () => { window.__writes.push(what); return Promise.resolve(); };
  function docRef(coll, id) {
    return {
      id,
      get: () => Promise.resolve((() => { const d = (db[coll] || {})[id]; return { exists: !!d, id, data: () => (d ? hydrate(d) : undefined) }; })()),
      set: writeTrap('set:' + coll + '/' + id), update: writeTrap('update:' + coll + '/' + id), delete: writeTrap('delete:' + coll + '/' + id),
      onSnapshot: (cb) => { cb({ exists: false, data: () => undefined }); return () => {}; },
      collection: (c) => query(coll + '/' + id + '/' + c, []),
    };
  }
  function query(coll, filters) {
    const q = {
      where: (f, op, v) => query(coll, filters.concat([[f, op, v]])),
      orderBy: () => q, limit: () => q, startAfter: () => q, limitToLast: () => q,
      doc: (id) => docRef(coll, id),
      add: writeTrap('add:' + coll),
      get: () => {
        const all = Object.entries(db[coll] || {});
        const hit = all.filter(([, d]) => filters.every(([f, op, v]) => op === 'in' ? (Array.isArray(v) && v.includes(d[f])) : (op !== '==' || d[f] === v)));
        const docs = hit.map(([id, d]) => ({ id, exists: true, data: () => hydrate(d) }));
        return Promise.resolve({ docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) });
      },
      onSnapshot: (cb) => { q.get().then(cb).catch(() => {}); return () => {}; },
    };
    return q;
  }
  const fsx = { collection: (c) => query(c, []), doc: (p) => { const [c, id] = p.split('/'); return docRef(c, id); }, batch: () => ({ set: writeTrap('batch'), update: writeTrap('batch'), delete: writeTrap('batch'), commit: writeTrap('batch.commit') }), runTransaction: writeTrap('runTransaction') };
  const Timestamp = { fromDate: (d) => ({ toMillis: () => d.getTime(), toDate: () => d }), now: () => ({ toMillis: () => Date.now(), toDate: () => new Date() }) };
  const fsFn = () => fsx; fsFn.Timestamp = Timestamp; fsFn.FieldValue = { serverTimestamp: () => ({}), increment: (n) => n, arrayUnion: (...a) => a };
  const user = { uid: 'admin-uid-1', email: 'admin@example.test', displayName: 'Cert Admin', getIdTokenResult: () => Promise.resolve({ claims: { admin: true, superAdmin: true } }), getIdToken: () => Promise.resolve('t') };
  const auth = { currentUser: user, onAuthStateChanged: (cb) => { setTimeout(() => cb(user), 0); return () => {}; }, signOut: () => Promise.resolve() };
  const pend = () => Object.entries(db.payoutRequests).filter(([, d]) => d.status === 'pending').map(([id, d]) => Object.assign({ id }, d));
  function handle(name, data) {
    if (name === 'adminOsDispatch' && data && data.op === 'aosGetPendingPayouts') return { payouts: pend() };
    if (name === 'aosGetPendingPayouts' || name === 'adminGetPendingPayouts') return { payouts: pend() };
    if (name === 'adminPayoutOps') return { counts: { failed: 1, processing: 1 }, lists: { failed: [{ id: 'F1', amount: 444, status: 'failed' }], processing: [{ id: 'PR1', amount: 9, status: 'processing' }] } };
    if (name === 'adminProcessPayout') {
      const d = db.payoutRequests[data.requestId];
      if (data.status === 'approved') { if (d) { d.status = 'approved'; d.secureRelease = true; } return { success: true, status: 'approved', awaitingOwner: true }; }
      if (data.status === 'paid') {
        if (!data.externalReference || !data.attestation) { const e = new Error('Manual settlement requires externalReference + attestation'); e.code = 'functions/failed-precondition'; throw e; }
        if (d) d.status = 'settled_manually';           /* the SERVER performs the transition */
        return { success: true };
      }
      if (data.status === 'rejected' && d) d.status = 'rejected';
      return { success: true };
    }
    return {};
  }
  const fns = { httpsCallable: (name) => async (data) => { window.__calls.push({ name, data: JSON.parse(JSON.stringify(data || {})) }); return { data: handle(name, data || {}) }; } };
  window.firebase = { auth: () => auth, firestore: fsFn, functions: () => fns, app: () => ({}), apps: [{}] };
  window.firebaseAuth = auth; window.firebaseDB = fsx;
  window.SokoniAdminEntry = { guard: async () => ({ ok: true }), mountControls: () => {} };
  window.alert = () => {}; window.confirm = () => true;
  window.prompt = () => (window.__prompts.length ? window.__prompts.shift() : null);
  try { localStorage.setItem('sokoniPrivacyAccepted', 'true'); } catch (e) {}
}
async function openPage(browser, file, scn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (!u.startsWith(BASE)) return route.abort();
    if (/\/firebase\.js(\?|$)/.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* stubbed */' });
    if (/\/sokoni-admin-entry\.js(\?|$)/.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.SokoniAdminEntry=window.SokoniAdminEntry||{guard:async()=>({ok:true}),mountControls(){}};' });
    return route.continue();
  });
  const page = await ctx.newPage();
  await page.addInitScript(stub, scn);
  await page.goto(BASE + '/' + file, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => !document.getElementById('sk-splash'), null, { timeout: 9000 }).catch(() => {});
  return { ctx, page };
}
const scn = (x) => Object.assign({ fixture: fixture() }, x || {});
let BASE;

server.listen(0, async () => {
  BASE = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await playwright.chromium.launch(); } catch (e) { console.log('BLOCKED — chromium could not launch: ' + e.message); server.close(); process.exit(4); }
  const flow = async (id, fn) => { try { return await fn(); } catch (e) { ok(false, id, 'flow', String(e && e.message).slice(0, 200)); return null; } };
  try {
    /* ══ AdminOS ══ */
    const aosOpen = async (x) => {
      const o = await openPage(browser, 'admin-os.html', scn(x));
      await o.page.waitForFunction(() => window.SokoniAOS && document.querySelector('#panel-financial'), null, { timeout: 45000 });
      await o.page.evaluate(() => { const n = document.querySelector('.nav-item[data-section="financial"]'); if (n) n.click(); });
      await o.page.evaluate(() => SokoniAOS.financialTab('payouts'));
      await o.page.waitForFunction(() => /Ready to pay/.test((document.getElementById('finBody') || {}).innerText || ''), null, { timeout: 15000 });
      return o;
    };
    await flow('AQ1', async () => {
      const { ctx, page } = await aosOpen();
      const r = await page.evaluate(() => {
        const txt = (sel) => (document.querySelector(sel) || {}).innerText || '';
        const rowIds = (sel) => [...document.querySelectorAll(sel + ' tr[data-payout-id]')].map((t) => t.getAttribute('data-payout-id'));
        return { body: txt('#finBody'), owner: rowIds('#payoutOwnerTable'), ready: rowIds('#payoutReadyTable'),
          ownerHasMarkPaid: !!document.querySelector('#payoutOwnerTable [onclick*="markPayoutPaid"]'), readyMarkPaid: document.querySelectorAll('#payoutReadyTable [onclick*="markPayoutPaid"]').length,
          banner: txt('#payoutModeBanner') };
      });
      const pendingOk = /Awaiting review/.test(r.body) && /SELLERPENDING0001/.test(r.body) || /500/.test(r.body);
      ok(pendingOk && JSON.stringify(r.owner) === JSON.stringify(['A1']) && !r.ownerHasMarkPaid && r.ready.sort().join(',') === 'L1,OC1' && r.readyMarkPaid === 2
        && !/SELLERREJECTED|SELLERPAID0|SELLERSETTLED|SELLERFAILED/.test(r.body), 'AQ1', 'three queues: pending · awaiting the owner (no Mark Paid) · ready to pay (released + legacy, with Mark Paid); final states in none', { owner: r.owner, ready: r.ready, ownerMP: r.ownerHasMarkPaid });
      ok(/Approving sends NO money/.test(r.banner) && /owner then confirms/.test(r.banner), 'AB1', 'the banner: approving sends no money; the owner confirms', r.banner.slice(0, 120));

      await page.evaluate(() => SokoniAOS.approvePayout('P1')); await page.waitForTimeout(500);
      const t1 = await page.evaluate(() => (document.getElementById('aosToasts') || {}).innerText || '');
      ok(/no money was sent\. The owner must now confirm/.test(t1), 'AP1', 'approve reports the SERVER\'s answer (awaiting the owner)', t1.slice(0, 160));

      await page.evaluate(() => { window.__prompts.push('duplicate request'); SokoniAOS.rejectPayout('A1'); }); await page.waitForTimeout(400);
      const calls = await page.evaluate(() => window.__calls);
      const rej = calls.filter((c) => c.name === 'adminProcessPayout' && c.data.status === 'rejected');
      ok(rej.length === 1 && rej[0].data.requestId === 'A1' && rej[0].data.note === 'duplicate request' && !calls.some((c) => c.name === 'finosRequestBankPayout'), 'AR1', 'reject calls the live adminProcessPayout(rejected) — never the retired finosRequestBankPayout', rej);
      await ctx.close();
    });

    await flow('AM1', async () => {
      const { ctx, page } = await aosOpen();
      await page.evaluate(() => SokoniAOS.markPayoutPaid('OC1'));
      await page.waitForSelector('#mpSubmit', { timeout: 8000 });
      const n0 = await page.evaluate(() => window.__calls.filter((c) => c.name === 'adminProcessPayout').length);
      await page.fill('#mpAtt', 'sent by finance via M-PESA 11:30');
      const dis1 = await page.$eval('#mpSubmit', (b) => b.disabled);
      await page.evaluate(() => { const b = document.getElementById('mpSubmit'); b.disabled = false; b.click(); });   /* forced click without a reference */
      await page.waitForTimeout(300);
      const n1 = await page.evaluate(() => window.__calls.filter((c) => c.name === 'adminProcessPayout').length);
      await page.fill('#mpRef', 'QWE123RTY');
      await page.click('#mpSubmit');
      await page.waitForTimeout(500);
      const paid = await page.evaluate(() => window.__calls.filter((c) => c.name === 'adminProcessPayout' && c.data.status === 'paid'));
      const toast = await page.evaluate(() => (document.getElementById('aosToasts') || {}).innerText || '');
      ok(dis1 === true && n1 === n0 && paid.length === 1 && paid[0].data.requestId === 'OC1' && paid[0].data.externalReference === 'QWE123RTY' && /sent by finance/.test(paid[0].data.attestation)
        && /settled_manually/.test(toast), 'AM1', 'Mark Paid on a released payout: nothing without a reference; then exactly ONE call with ref + attestation; the server\'s state reported', { dis1, n0, n1, paid: paid.length, toast: toast.slice(0, 100) });

      const before = paid.length;
      await page.evaluate(() => SokoniAOS.markPayoutPaid('A1')); await page.waitForTimeout(400);
      const t2 = await page.evaluate(() => (document.getElementById('aosToasts') || {}).innerText || '');
      const after = await page.evaluate(() => window.__calls.filter((c) => c.name === 'adminProcessPayout' && c.data.status === 'paid').length);
      const modal = await page.evaluate(() => !!document.querySelector('#aosModal.open #mpSubmit'));
      ok(/owner has not released/.test(t2) && after === before && !modal, 'AM2', 'Mark Paid on a payout the owner has NOT released is refused in the UI — no call', t2.slice(-120));
      const writes = await page.evaluate(() => window.__writes);
      ok(writes.length === 0, 'AW', 'the UI never writes Firestore', writes);
      await ctx.close();
    });

    await flow('AN', async () => {
      const { ctx, page } = await openPage(browser, 'admin-os.html', scn());
      await page.waitForFunction(() => window.SokoniAOS && document.querySelectorAll('.nav-item[data-section]').length > 0, null, { timeout: 45000 });
      const res = await page.evaluate(() => [...document.querySelectorAll('.nav-item[data-section]')].map((n) => { n.click(); const p = document.getElementById('panel-' + n.dataset.section); return [n.dataset.section, !!p && !p.hidden]; }));
      const bad = res.filter((r) => !r[1]).map((r) => r[0]);
      ok(res.length >= 5 && !bad.length, 'AN', `every AdminOS nav section (${res.length}) still opens its panel`, bad);
      await ctx.close();
    });

    /* ══ super-admin ══ */
    const saOpen = async (x) => {
      const o = await openPage(browser, 'super-admin.html', scn(x));
      /* this line's super-admin asks for its master passcode before SA.init — entered as a user would (the value is
         in the page's own source, so it is no secret; recorded as a pre-existing finding) */
      const pass = await o.page.waitForSelector('#saPass', { state: 'attached', timeout: 20000 }).catch(() => null);
      if (pass) await o.page.evaluate(() => { document.getElementById('saPass').value = '3026'; document.getElementById('saPassBtn').click(); });
      await o.page.waitForFunction(() => typeof SA !== 'undefined' && !!SA._fns, null, { timeout: 45000 });
      await o.page.evaluate(() => { const n = document.querySelector('.nav-item[data-section="financial"]'); if (n) n.click(); });
      await o.page.evaluate(() => Promise.all([SA.loadPayouts(), SA.loadPayoutOps && SA.loadPayoutOps()]));
      await o.page.waitForTimeout(400);
      return o;
    };
    await flow('SQ1', async () => {
      const { ctx, page } = await saOpen();
      const r = await page.evaluate(() => {
        const list = document.getElementById('saPayoutsList'), ops = document.getElementById('saPayoutOps');
        const rows = [...list.querySelectorAll('tr')];
        const pendingRow = rows.find((t) => /SELLERPENDING0001|500/.test(t.innerText) && /Approve/.test(t.innerText));
        const readyRows = rows.filter((t) => /not paid/.test(t.innerText)).map((t) => t.innerText.replace(/\s+/g, ' '));
        return { pendingMP: pendingRow ? /Mark Paid/.test(pendingRow.innerText) : null, readyRows, opsMP: /Mark Paid/.test(ops ? ops.innerText : ''), text: list.innerText };
      });
      ok(r.pendingMP === false && r.opsMP === false && /Released by the owner — ready to pay/.test(r.text) && r.readyRows.length === 2
        && r.readyRows.some((x) => /OWNERRELEA/.test(x) && /Released by owner/.test(x)) && r.readyRows.some((x) => /LEGACYAPPR/.test(x)) && !r.readyRows.some((x) => /OWNERWAITI/.test(x)),
        'SQ1', 'super-admin: no Mark Paid on pending or gateway rows; "ready to pay" = released + legacy approved only', { pendingMP: r.pendingMP, opsMP: r.opsMP, ready: r.readyRows });
      await ctx.close();
    });
    await flow('SM1', async () => {
      const { ctx, page } = await saOpen({ prompts: ['', 'QWE999', 'sent by finance 12:00'] });
      await page.evaluate(() => { SA.processPayout('OC1', 'paid'); }); await page.click('#saModalConfirmBtn'); await page.waitForTimeout(300);
      const n1 = await page.evaluate(() => window.__calls.filter((c) => c.name === 'adminProcessPayout').length);
      await page.evaluate(() => { SA.processPayout('OC1', 'paid'); }); await page.click('#saModalConfirmBtn'); await page.waitForTimeout(400);
      const paid = await page.evaluate(() => window.__calls.filter((c) => c.name === 'adminProcessPayout' && c.data.status === 'paid'));
      ok(n1 === 0 && paid.length === 1 && paid[0].data.externalReference === 'QWE999' && paid[0].data.attestation === 'sent by finance 12:00', 'SM1', 'super-admin Mark Paid: an empty reference sends nothing; then ref + attestation are sent', { n1, paid });
      await ctx.close();
    });
    await flow('SR1', async () => {
      const { ctx, page } = await saOpen({ prompts: ['not verified'] });
      await page.evaluate(() => { SA.processPayout('P1', 'reject'); }); await page.click('#saModalConfirmBtn'); await page.waitForTimeout(400);
      const rej = await page.evaluate(() => window.__calls.filter((c) => c.name === 'adminProcessPayout' && c.data.status === 'rejected'));
      ok(rej.length === 1 && rej[0].data.requestId === 'P1' && rej[0].data.note === 'not verified', 'SR1', 'super-admin reject sends adminProcessPayout(rejected) with the reason', rej);
      await ctx.close();
    });
  } finally { await browser.close().catch(() => {}); server.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
