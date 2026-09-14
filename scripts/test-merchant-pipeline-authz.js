#!/usr/bin/env node
/* J2 verification — merchant-pipeline.html authorization matrix.
   The REAL sokoni-admin-guard.js runs; only the Firebase SDK surface is stubbed
   so claims can be controlled. Storage is pre-seeded to simulate an attacker.

   PIN "1234" -> sha256 03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4
*/
const { chromium } = require(require('path').resolve(__dirname,'..','node_modules','playwright'));
const BASE = 'http://127.0.0.1:3000';
const PIN = '1234';
const PIN_HASH = '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4';

const CASES = [
  { name: 'signed OUT + attacker localStorage PIN', user: null,  claims: {},                    pin: PIN,     seedPin: true,  expect: 'DENY' },
  { name: 'signed OUT + attacker sessionStorage',   user: null,  claims: {},                    pin: null,    seedPin: true, seedSess: true, expect: 'DENY' },
  { name: 'signed in NON-admin + correct PIN',      user: 'u1',  claims: { seller: true },      pin: PIN,     seedPin: true,  expect: 'DENY' },
  { name: 'signed in NON-admin + attacker session', user: 'u1',  claims: { seller: true },      pin: null,    seedPin: true, seedSess: true, expect: 'DENY' },
  { name: 'signed in ADMIN + wrong PIN',            user: 'a1',  claims: { admin: true },       pin: '9999',  seedPin: true,  expect: 'DENY' },
  { name: 'signed in ADMIN + correct PIN',          user: 'a1',  claims: { admin: true },       pin: PIN,     seedPin: true,  expect: 'ALLOW' },
  { name: 'signed in ADMIN + no PIN configured',    user: 'a1',  claims: { admin: true },       pin: 'x',     seedPin: false, expect: 'ALLOW' },
];

(async () => {
  const browser = await chromium.launch();
  let pass = 0, fail = 0;
  console.log('SCENARIO'.padEnd(42), 'EXPECT'.padEnd(7), 'ACTUAL'.padEnd(7), 'VERDICT');
  console.log('-'.repeat(80));

  for (const c of CASES) {
    const ctx = await browser.newContext();
    await ctx.addInitScript(({ user, claims, seedPin, seedSess, hash }) => {
      try {
        if (seedPin)  localStorage.setItem('sokoniAdminPin', hash);
        if (seedSess) { sessionStorage.setItem('sokoniAdminSess', '1');
                        sessionStorage.setItem('sokoniAdminSessTs', String(Date.now())); }
      } catch (e) {}
      const u = user ? { uid: user, getIdTokenResult: async () => ({ claims }) } : null;
      window.firebaseAuth = { currentUser: u };
      window.firebase = {
        auth: () => ({ onAuthStateChanged: (cb) => cb(u), currentUser: u }),
        firestore: () => { const q = { collection:()=>q, doc:()=>q, where:()=>q, orderBy:()=>q,
          limit:()=>q, get: async()=>({empty:true,size:0,docs:[],forEach(){}}), onSnapshot:()=>()=>{} }; return q; },
      };
      window.firebase.firestore.FieldValue = { serverTimestamp: () => 'ts' };
    }, { user: c.user, claims: c.claims, seedPin: c.seedPin, seedSess: c.seedSess, hash: PIN_HASH });

    const page = await ctx.newPage();
    let actual = 'DENY';
    try {
      await page.goto(`${BASE}/merchant-pipeline.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2500);

      if (c.pin) {
        const has = await page.$('#mp-pin');
        if (has) {
          await page.fill('#mp-pin', c.pin).catch(() => {});
          await page.evaluate(() => { try { _mpAuth(); } catch (e) {} });
          await page.waitForTimeout(1200);
        }
      }
      /* ALLOW only if the console is genuinely visible AND the guard overlay is gone. */
      const vis = await page.evaluate(() => {
        const app = document.getElementById('mp-app');
        const ov  = document.getElementById('sokoniAdminGuard');
        const appVisible = !!app && getComputedStyle(app).display !== 'none';
        const overlayUp  = !!ov && getComputedStyle(ov).display !== 'none';
        return appVisible && !overlayUp;
      }).catch(() => false);
      actual = vis ? 'ALLOW' : 'DENY';
    } catch (e) { actual = 'DENY(err)'; }

    const ok = actual === c.expect;
    ok ? pass++ : fail++;
    console.log(c.name.padEnd(42), c.expect.padEnd(7), actual.padEnd(7), ok ? 'PASS' : '*** FAIL ***');
    await ctx.close();
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
})();
