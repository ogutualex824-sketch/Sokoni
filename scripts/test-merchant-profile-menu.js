#!/usr/bin/env node
/* test-merchant-profile-menu.js — the merchant shell carries THE profile menu, not a second one.
 *
 * OWNER ASK (2026-09-30): "in merchant dash there is no profile icon in header with the role
 * drop down". merchant-v2.html deliberately does not load shared-header.js, so it never got
 * the avatar + account dropdown + role switcher every shared-header page has. The control was
 * factored out of shared-header.js into sokoni-profile-menu.js and mounted into the shell's
 * own header chrome. This proves, in a real browser:
 *
 *   M  merchant-v2.html at 390 and 1280: avatar in the header (44px target); click opens the
 *      dropdown inside the viewport with aria-expanded; the role list is EXACTLY the
 *      authority's approved set for the stubbed claims; picking the other role goes through
 *      RA.setActiveRole (a Firestore write, intercepted), fires sokoniActiveRoleChanged and
 *      navigates to RA.hubFor(role) (intercepted) — the same path the shared header takes;
 *      Escape and an outside click close it; keyboard opens it; the legacy floating
 *      sokoni-profile-switcher.js is absent.
 *   N  NEGATIVE CONTROL: zero role claims -> no role-switcher rows.
 *   D  DOM PARITY: index.html's dropdown, rendered from the 59effdf tree (git archive) and
 *      from this tree under identical stubs, is byte-identical after whitespace
 *      normalisation; the nav's action slots and the avatar's box are unchanged.
 *
 * Hermetic: two static servers (this tree, the baseline export), every other origin aborted;
 * firebase.js and the three gstatic SDK modules are replaced by stubs that carry a signed-in
 * user with a FAKE claims set, and a Firestore whose writes resolve asynchronously and are
 * recorded, never sent. No production endpoint is reachable from this suite.
 *
 *   node scripts/test-merchant-profile-menu.js
 *   BASELINE=<sha>  the tree index.html's dropdown is compared against (default 59effdf)
 */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const BASELINE = process.env.BASELINE || '59effdf';
let pass = 0, fail = 0;
const ck = (l, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const head = (t) => console.log('\n' + t);

/* ── stubs ─────────────────────────────────────────────────────────────────────────── */
const GSTATIC = 'https://www.gstatic.com/firebasejs/10.12.2/';
const STUB_APP = `
  const apps = [];
  export function initializeApp(cfg) { const a = { name: '[DEFAULT]', options: cfg || {} }; apps.push(a); return a; }
  export function getApps() { return apps.slice(); }
  export function getApp() { return apps[0]; }
`;
const STUB_AUTH = `
  export function getAuth() { return window.__stubAuth; }
  export function onAuthStateChanged(auth, cb) { setTimeout(() => cb(auth.currentUser), 0); return () => {}; }
  export function signOut() { return Promise.resolve(); }
  export function getIdTokenResult(u, force) { return u.getIdTokenResult(force); }
`;
const STUB_FS = `
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const snap = (p) => ({ id: String(p).split('/').pop(), exists: () => false, data: () => undefined, ref: { path: p } });
  const qsnap = () => ({ docs: [], empty: true, size: 0, forEach() {} });
  export function getFirestore() { return window.__stubDB; }
  export function initializeFirestore() { return window.__stubDB; }
  export function doc(db, ...segs) { return { path: segs.join('/'), _db: db }; }
  export function collection(db, ...segs) { return { path: segs.join('/'), _db: db, _col: true }; }
  export function query(c) { return c; }
  export function where() { return {}; }  export function orderBy() { return {}; }  export function limit() { return {}; }
  export function startAfter() { return {}; } export function endBefore() { return {}; } export function documentId() { return '__name__'; }
  export async function getDoc(ref) { await tick(); return snap(ref.path); }
  export async function getDocs() { await tick(); return qsnap(); }
  export async function getCountFromServer() { await tick(); return { data: () => ({ count: 0 }) }; }
  export async function setDoc(ref, data, opts) { await tick(); (window.__stubWrites = window.__stubWrites || []).push({ op: 'set', path: ref.path, data, opts }); try { window.__skReport && window.__skReport('write', { op: 'set', path: ref.path, data, opts }); } catch (_) {} }
  export async function updateDoc(ref, data) { await tick(); (window.__stubWrites = window.__stubWrites || []).push({ op: 'update', path: ref.path, data }); }
  export async function addDoc(col, data) { await tick(); (window.__stubWrites = window.__stubWrites || []).push({ op: 'add', path: col.path, data }); return { id: 'stub' }; }
  export async function deleteDoc(ref) { await tick(); (window.__stubWrites = window.__stubWrites || []).push({ op: 'delete', path: ref.path }); }
  export function onSnapshot(ref, cb) { setTimeout(() => { try { cb(ref._col ? qsnap() : snap(ref.path)); } catch (_) {} }, 5); return () => {}; }
  export function serverTimestamp() { return { __ts: true }; }  export function increment(n) { return { __inc: n }; }
  export function arrayUnion(...v) { return { __au: v }; }  export function arrayRemove(...v) { return { __ar: v }; }
  export function deleteField() { return { __del: true }; }
  export function writeBatch() { const ops = []; return { set(r, d) { ops.push(['set', r.path, d]); }, update(r, d) { ops.push(['update', r.path, d]); }, delete(r) { ops.push(['delete', r.path]); }, async commit() { await tick(); (window.__stubWrites = window.__stubWrites || []).push({ op: 'batch', ops }); } }; }
  export async function runTransaction(db, fn) { await tick(); return fn({ get: async (r) => snap(r.path), set() {}, update() {}, delete() {} }); }
  export const Timestamp = { now: () => ({ toDate: () => new Date(), toMillis: () => Date.now() }), fromDate: (d) => ({ toDate: () => d, toMillis: () => +d }) };
  export function enableIndexedDbPersistence() { return Promise.resolve(); }
`;
/* firebase.js replacement: a signed-in user whose token carries CLAIMS. */
const stubFirebaseJs = (claims, user) => `
  import { initializeApp, getApps } from '${GSTATIC}firebase-app.js';
  import { getAuth } from '${GSTATIC}firebase-auth.js';
  import { getFirestore } from '${GSTATIC}firebase-firestore.js';
  const claims = ${JSON.stringify(claims)};
  const user = { uid: ${JSON.stringify(user.uid)}, email: ${JSON.stringify(user.email)}, displayName: ${JSON.stringify(user.name)},
    getIdTokenResult(force) { (window.__tokenReads = window.__tokenReads || []).push(!!force); return new Promise((r) => setTimeout(() => r({ claims, token: 'stub' }), 5)); },
    getIdToken() { return Promise.resolve('stub'); } };
  window.__stubAuth = { currentUser: user, onAuthStateChanged(cb) { setTimeout(() => cb(user), 0); return () => {}; }, signOut() { return Promise.resolve(); } };
  window.__stubDB = { __stub: true };
  const app = getApps().length ? getApps()[0] : initializeApp({ projectId: 'stub' });
  window.firebaseApp = app; window.firebaseAuth = getAuth(app); window.firebaseDB = getFirestore(app);
  try { localStorage.setItem('sokoniUser', JSON.stringify({ uid: user.uid, name: user.displayName, email: user.email, roles: ['buyer'], role: 'buyer' })); localStorage.setItem('loggedIn', 'true'); } catch (_) {}
  window.sokoniSignOut = () => Promise.resolve();
  const detail = { uid: user.uid, email: user.email };
  window.__sokoniAuthReady = true; window.__sokoniAuthReadyDetail = detail;
  document.dispatchEvent(new CustomEvent('sokoniAuthReady', { detail }));
`;

function serve(root) {
  const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' };
  const srv = http.createServer((rq, rs) => {
    const u = decodeURIComponent(rq.url.split('?')[0]);
    let fp = path.join(root, u === '/' ? 'index.html' : u);
    if (!fs.existsSync(fp) && fs.existsSync(fp + '.html')) fp += '.html';
    if (!fp.startsWith(root) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { rs.writeHead(404); rs.end(); return; }
    rs.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(fp).pipe(rs);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, base: 'http://127.0.0.1:' + srv.address().port })));
}

(async () => {
  const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));

  /* baseline tree: index.html's dropdown BEFORE the refactor */
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sok-pm-baseline-'));
  execFileSync('git', ['-C', ROOT, 'archive', '--format=tar', '-o', path.join(baseDir, 'b.tar'), BASELINE]);
  execFileSync('tar', ['-xf', path.join(baseDir, 'b.tar'), '-C', baseDir]);
  const here = await serve(ROOT);
  const base = await serve(baseDir);
  const browser = await chromium.launch();
  const JS = (body) => ({ status: 200, contentType: 'application/javascript', body });

  async function open(server, file, { width, claims, user }) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const nav = [];              /* intercepted navigations to a role hub */
    const records = [];          /* writes + events reported from the page BEFORE it navigates away */
    await page.exposeFunction('__skReport', (kind, payload) => { records.push({ kind, payload }); });
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(GSTATIC + 'firebase-app.js')) return route.fulfill(JS(STUB_APP));
      if (url.startsWith(GSTATIC + 'firebase-auth.js')) return route.fulfill(JS(STUB_AUTH));
      if (url.startsWith(GSTATIC + 'firebase-firestore.js')) return route.fulfill(JS(STUB_FS));
      if (!url.startsWith(server.base)) return route.abort();
      const p = new URL(url).pathname;
      if (p === '/firebase.js') return route.fulfill(JS(stubFirebaseJs(claims, user)));
      if (/^\/(sw-register|auth-guard|sokoni-routing|sokoni-crash-sentinel|seo|splash)\.js$/.test(p)) return route.fulfill(JS('/* stubbed by test-merchant-profile-menu */'));
      if (route.request().isNavigationRequest() && route.request().frame() === page.mainFrame() && /\/(driver|index|merchant-v2|providers|car-hub|healthcare|legal-hub|landlord|property)\.html$/.test(p) && nav.armed) {
        nav.push(p); return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>hub stub</title>' + p });
      }
      return route.continue();
    });
    await page.addInitScript(() => {
      window.__events = [];
      ['sokoniActiveRoleChanged', 'sokoniRoleChanged', 'sokoniRoleAuthorityReady'].forEach((n) =>
        document.addEventListener(n, (e) => {
          const rec = { n, role: e.detail && (e.detail.role || e.detail.activeRole), approved: e.detail && e.detail.approved };
          window.__events.push(rec);
          try { window.__skReport && window.__skReport('event', rec); } catch (_) {}
        }));
    });
    await page.goto(server.base + '/' + file, { waitUntil: 'domcontentloaded' });
    /* the menu file is injected by the header on shared-header pages; wait for the module and for the authority to verify */
    await page.waitForFunction(() => window.SokoniProfileMenu || typeof window._skToggleAcct === 'function', null, { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => window.SokoniRoleAuthority && window.SokoniRoleAuthority.isVerified(), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(400);
    return { ctx, page, nav, records };
  }
  const USER = { uid: 'u-stub-1', email: 'stub@example.test', name: 'Stub Merchant' };
  const TWO = { seller: true, rider: true };                 /* two role claims; the authority adds the buyer baseline */
  const EXPECTED = ['buyer', 'seller', 'rider'];

  const popupState = () => ({
    open: !!document.getElementById('sk-acct-popup'),
    expanded: (document.getElementById('sk-nav-avatar') || {}).getAttribute && document.getElementById('sk-nav-avatar').getAttribute('aria-expanded'),
    rect: (function () { const p = document.getElementById('sk-acct-popup'); if (!p) return null; const r = p.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })(),
    vw: innerWidth, vh: innerHeight,
    roles: Array.from(document.querySelectorAll('#sk-acct-popup [data-sk-workspace]')).map((b) => b.getAttribute('data-sk-workspace')),
    active: Array.from(document.querySelectorAll('#sk-acct-popup [data-sk-workspace].active')).map((b) => b.getAttribute('data-sk-workspace')),
    switchLabel: /Switch Role/.test((document.getElementById('sk-acct-popup') || {}).textContent || ''),
    approved: window.SokoniRoleAuthority ? window.SokoniRoleAuthority.getApprovedRoles() : null,
    verified: !!(window.SokoniRoleAuthority && window.SokoniRoleAuthority.isVerified()),
    hubRider: window.SokoniRoleAuthority ? window.SokoniRoleAuthority.hubFor('rider') : null,
    focusedId: document.activeElement && document.activeElement.id,
  });

  /* ── M · the merchant shell at both widths ─────────────────────────────────────── */
  for (const width of [390, 1280]) {
    head('M · merchant-v2.html @ ' + width);
    const { ctx, page, nav, records } = await open(here, 'merchant-v2.html', { width, claims: TWO, user: USER });
    const av = await page.evaluate(() => {
      const b = document.querySelector('.hdr #hdr-acct #sk-nav-avatar');
      if (!b) return { present: false, scripts: Array.from(document.scripts).map((s) => s.getAttribute('src')).filter(Boolean) };
      const r = b.getBoundingClientRect(); const cs = getComputedStyle(b);
      return { present: true, tag: b.tagName, w: r.width, h: r.height, visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0, text: b.textContent, inViewport: r.right <= innerWidth && r.left >= 0,
        legacy: Array.from(document.scripts).some((s) => /sokoni-profile-switcher/.test(s.getAttribute('src') || '')), legacyEl: !!document.querySelector('[id*="profile-switcher"], .sokoni-profile-switcher'),
        expanded: b.getAttribute('aria-expanded'), haspopup: b.getAttribute('aria-haspopup'), label: b.getAttribute('aria-label') };
    });
    ck('M1  avatar BUTTON is in the shell header slot, visible, inside the viewport', av.present && av.tag === 'BUTTON' && av.visible && av.inViewport, av);
    ck('M2  44px touch target', av.present && av.w >= 44 && av.h >= 44, av);
    ck('M3  initial is the user\'s (S), aria-expanded=false, aria-haspopup, labelled', av.present && av.text === 'S' && av.expanded === 'false' && av.haspopup === 'menu' && /Account/.test(av.label || ''), av);
    ck('M4  the legacy floating sokoni-profile-switcher.js is NOT loaded and renders nothing', av.present && !av.legacy && !av.legacyEl, av);

    const pre = await page.evaluate(popupState);
    ck('M5  authority VERIFIED the stubbed token; approved set = baseline + the two claims', pre.verified && JSON.stringify(pre.approved) === JSON.stringify(EXPECTED), pre);
    await page.click('#hdr-acct #sk-nav-avatar');
    await page.waitForTimeout(350);
    const st = await page.evaluate(popupState);
    ck('M6  click opens the dropdown; aria-expanded=true', st.open && st.expanded === 'true', st);
    ck('M7  dropdown lies fully inside the viewport (' + width + 'px)', st.rect && st.rect.l >= 0 && st.rect.t >= 0 && st.rect.r <= st.vw && st.rect.b <= st.vh && st.rect.w > 200 && st.rect.h > 100, st);
    ck('M8  role list == the authority\'s approved set, exactly, in its order', JSON.stringify(st.roles) === JSON.stringify(st.approved) && JSON.stringify(st.roles) === JSON.stringify(EXPECTED), st);
    ck('M9  the acting role (buyer baseline) is the one marked active', JSON.stringify(st.active) === JSON.stringify(['buyer']), st);
    ck('M10 rider\'s hub per the authority is driver.html (the destination the shared header would take)', st.hubRider === 'driver.html', st);

    /* pick the other role: authority write -> event -> navigate to hubFor() */
    nav.armed = true;
    records.length = 0;           /* only what the switch itself causes, reported before the page navigates away */
    await page.click('#sk-acct-popup [data-sk-workspace="rider"]');
    await page.waitForTimeout(1200);
    const writes = records.filter((r) => r.kind === 'write').map((r) => r.payload);
    const events = records.filter((r) => r.kind === 'event').map((r) => r.payload);
    const setWrite = writes.find((w) => w.op === 'set' && w.path === 'users/' + USER.uid && w.data && w.data.activeRole === 'rider');
    ck('M11 the switch went THROUGH the authority: users/{uid}.activeRole=rider was written (merge), nothing else', !!setWrite && setWrite.opts && setWrite.opts.merge === true && writes.length === 1, writes);
    ck('M12 sokoniActiveRoleChanged(role=rider) fired from the authority, before the navigation', events.some((e) => e.n === 'sokoniActiveRoleChanged' && e.role === 'rider'), events);
    ck('M13 navigation went to the authority\'s hub for rider (/driver.html) — intercepted, not fabricated', nav.length === 1 && nav[0] === '/driver.html', nav);
    await ctx.close();

    /* fresh page for close behaviours (the first navigated away) */
    const s2 = await open(here, 'merchant-v2.html', { width, claims: TWO, user: USER });
    await s2.page.click('#hdr-acct #sk-nav-avatar'); await s2.page.waitForTimeout(300);
    const o1 = await s2.page.evaluate(popupState);
    await s2.page.keyboard.press('Escape'); await s2.page.waitForTimeout(200);
    const e1 = await s2.page.evaluate(popupState);
    ck('M14 Escape closes it, aria-expanded=false, focus returns to the avatar', o1.open && !e1.open && e1.expanded === 'false' && e1.focusedId === 'sk-nav-avatar', e1);
    await s2.page.click('#hdr-acct #sk-nav-avatar'); await s2.page.waitForTimeout(300);
    const o2 = await s2.page.evaluate(popupState);
    await s2.page.mouse.click(Math.round(width / 2), 300); await s2.page.waitForTimeout(250);   /* outside: the content pane, well below the header */
    const e2 = await s2.page.evaluate(popupState);
    ck('M15 an outside click closes it', o2.open && !e2.open && e2.expanded === 'false', e2);
    await s2.page.focus('#hdr-acct #sk-nav-avatar'); await s2.page.keyboard.press('Enter'); await s2.page.waitForTimeout(300);
    const k1 = await s2.page.evaluate(popupState);
    ck('M16 keyboard: focus + Enter opens it', k1.open && k1.expanded === 'true', k1);
    await s2.page.keyboard.press('Tab'); await s2.page.waitForTimeout(100);
    const k2 = await s2.page.evaluate(() => ({ inMenu: !!(document.activeElement && document.activeElement.closest('#sk-acct-popup')), tag: document.activeElement && document.activeElement.tagName }));
    ck('M17 Tab moves focus into the open menu', k2.inMenu, k2);
    await s2.ctx.close();
  }

  /* ── N · negative control: no roles -> no switcher rows ────────────────────────── */
  head('N · negative control: zero role claims');
  {
    const { ctx, page } = await open(here, 'merchant-v2.html', { width: 1280, claims: {}, user: USER });
    await page.click('#hdr-acct #sk-nav-avatar'); await page.waitForTimeout(300);
    const st = await page.evaluate(popupState);
    ck('N1  the dropdown still opens', st.open, st);
    ck('N2  approved set is the baseline only', st.verified && JSON.stringify(st.approved) === JSON.stringify(['buyer']), st);
    ck('N3  NO role-switcher rows and no "Switch Role" strip', st.roles.length === 0 && st.switchLabel === false, st);
    ck('N4  rider has no hub for this account (routing cannot become a way in)', st.hubRider === null, st);
    await ctx.close();
  }

  /* ── D · shared-header parity: index.html dropdown byte-identical to the baseline ── */
  head('D · index.html dropdown: ' + BASELINE + ' tree vs this tree');
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').replace(/> </g, '><').trim();
  async function indexDropdown(server, width) {
    const { ctx, page } = await open(server, 'index.html', { width, claims: TWO, user: USER });
    await page.waitForTimeout(2200);   /* the header's splash holds ~1.8s */
    await page.evaluate(() => window._skToggleAcct({ stopPropagation() {} }));
    await page.waitForTimeout(350);
    const r = await page.evaluate(() => {
      const p = document.getElementById('sk-acct-popup'); const b = document.getElementById('sk-nav-avatar');
      const br = b ? b.getBoundingClientRect() : null;
      return { popup: p ? p.innerHTML : null, attrs: p ? Array.from(p.attributes).map((a) => a.name + '=' + a.value).sort() : null,
        wrap: (document.getElementById('sk-acct-wrap') || {}).outerHTML ? document.getElementById('sk-acct-wrap').outerHTML.replace(/<div id="sk-acct-popup"[\s\S]*$/, '') : null,
        actions: Array.from(document.querySelectorAll('#sk-nav-actions > *')).map((e) => e.id || e.className),
        avatarBox: br ? { w: Math.round(br.width), h: Math.round(br.height) } : null,
        roles: Array.from(document.querySelectorAll('#sk-acct-popup [data-sk-workspace]')).map((x) => x.getAttribute('data-sk-workspace')),
        menuFile: Array.from(document.scripts).some((s) => /sokoni-profile-menu\.js/.test(s.src)) };
    });
    await ctx.close();
    return r;
  }
  for (const width of [390, 1280]) {
    const b = await indexDropdown(base, width), h = await indexDropdown(here, width);
    ck('D1 @' + width + ' both trees rendered the dropdown with the two-claim role list', !!b.popup && !!h.popup && JSON.stringify(b.roles) === JSON.stringify(EXPECTED) && JSON.stringify(h.roles) === JSON.stringify(EXPECTED), { b: b.roles, h: h.roles, bp: !!b.popup, hp: !!h.popup });
    ck('D2 @' + width + ' dropdown innerHTML is byte-identical (whitespace-normalised) to ' + BASELINE, !!b.popup && norm(b.popup) === norm(h.popup), { bLen: norm(b.popup).length, hLen: norm(h.popup).length, firstDiff: (function () { const x = norm(b.popup), y = norm(h.popup); for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return i + ': ' + x.slice(i, i + 60) + ' | ' + y.slice(i, i + 60); return null; })() });
    ck('D3 @' + width + ' popup attributes (id, role) unchanged', JSON.stringify(b.attrs) === JSON.stringify(h.attrs), { b: b.attrs, h: h.attrs });
    ck('D4 @' + width + ' avatar wrap markup and box unchanged', b.wrap === h.wrap && JSON.stringify(b.avatarBox) === JSON.stringify(h.avatarBox), { b: [b.wrap, b.avatarBox], h: [h.wrap, h.avatarBox] });
    ck('D5 @' + width + ' header action slots unchanged', JSON.stringify(b.actions) === JSON.stringify(h.actions), { b: b.actions, h: h.actions });
    ck('D6 @' + width + ' this tree builds it from the injected sokoni-profile-menu.js; the baseline had no such file', h.menuFile === true && b.menuFile === false, { b: b.menuFile, h: h.menuFile });
  }
  ck('D7 CONTROL: the comparison is not vacuous — a one-byte change is detected', norm('<a b="1"> x </a>') !== norm('<a b="1"> y </a>') && norm('<a>\n  <b></b>\n</a>') === norm('<a><b></b></a>'));

  await browser.close(); here.srv.close(); base.srv.close();
  try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) {}
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
