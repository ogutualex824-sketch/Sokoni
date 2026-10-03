'use strict';
/* sokoni-intasend.js — the double-submit lock guards the push REQUEST, not the whole session (2026-10-03).
   Runs the REAL file in a vm; the Firebase SDK import is swapped for a stub callable.
     node scripts/test-intasend-client-lock.js       BASE=72dca56 node scripts/test-intasend-client-lock.js (must FAIL) */
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
let src = process.env.BASE ? execSync('git show ' + process.env.BASE + ':sokoni-intasend.js', { cwd: ROOT, encoding: 'utf8' }) : fs.readFileSync(path.join(ROOT, 'sokoni-intasend.js'), 'utf8');
src = src.replace(/await import\(\s*'https:\/\/www\.gstatic\.com\/firebasejs\/[^']+\/firebase-functions\.js'\s*\)/g, 'await __imp()');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const calls = []; let n = 0;
const store = {};
const ctx = { console, setTimeout, clearTimeout, Promise, JSON, Math, Number, String, Date, Array, Object, Error,
  sessionStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  __imp: async () => ({ getFunctions: () => ({}), httpsCallable: (_f, name) => async (data) => { calls.push({ name, data }); return { data: { success: true, checkoutId: 'CK' + (++n) } }; } }) };
ctx.window = ctx; ctx.window.firebaseAuth = { currentUser: { uid: 'buyer1' } }; ctx.window.firebaseApp = {};
vm.createContext(ctx);
try { vm.runInContext(src, ctx); } catch (e) { ck('L-0', false, 'loads', e.message); }
const IS = ctx.window.SokoniIntaSend;
const go = async (...a) => { try { return { ok: true, r: await IS.initiateSTKPush(...a) }; } catch (e) { return { ok: false, msg: e.message }; } };
(async () => {
  console.log('\nIntaSend client lock   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
  let a = await go('0712345678', 2500, 'pi_plan', { category: 'partner' });
  let b = await go('0712345678', 900, 'pi_promo', { category: 'promotion' });
  ck('C-1', a.ok && b.ok && calls.length === 2, 'a SECOND purchase in the same page session works after the first push (plan, then promotion)', { a, b });
  const c = await go('0712345678', 500, 'pi_don');
  ck('C-2', c.ok, 'a call with NO options object does not throw', c);
  const d = await go('0712345678', 500, 'pi_don', {});
  ck('C-3', d.ok && d.r.reused === true && calls.length === 3, 'the SAME payment ref retried reuses its checkout — no duplicate push', d);
  /* concurrent double tap of two DIFFERENT refs while the first request is in flight */
  let release; const slow = new Promise((r) => { release = r; });
  const prevImp = ctx.__imp;
  ctx.__imp = async () => ({ getFunctions: () => ({}), httpsCallable: () => async () => { await slow; return { data: { success: true, checkoutId: 'CKslow' } }; } });
  const p1 = go('0712345678', 100, 'pi_x1', {});
  await new Promise((r) => setTimeout(r, 5));
  const p2 = await go('0712345678', 100, 'pi_x2', {});
  release(); const r1 = await p1;
  ctx.__imp = prevImp;
  ck('C-4', r1.ok && !p2.ok && /already in progress/.test(p2.msg || ''), 'WHILE a push request is in flight, a second payment is still refused (the double-submit guard holds)', { r1, p2 });
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
