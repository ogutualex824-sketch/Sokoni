#!/usr/bin/env node
/* test-slice-b-support-whatsapp.js — Slice B: Support authority + WhatsApp booking replacement.
 *
 * Proves, without touching production:
 *   S  the customer support page submits through SokoniSupportContact → adminOsDispatch
 *      {op:'adminCreateSupportTicket'} and shows ONLY a server-minted id; localStorage is a
 *      cache written AFTER the server answers, never the record (executed: the library runs in
 *      a VM with a fake firebase; then the REAL page runs in Chromium with a stub firebase and
 *      every other origin aborted).
 *   R  the payload the browser sends reaches the REAL server handler and lands in
 *      `supportTickets` with the caller's uid, and AdminOS's list op (admin-only) returns it —
 *      the AdminOS super-admin routing the owner asked for. Firestore emulator, functions from
 *      FUNCTIONS_DIR (default C:/temp/sok-f1/functions = the deployed F1-R lineage; admin-os*.js
 *      are byte-identical on f50e675).
 *   W  no supported booking/parcel/support surface hands the user to WhatsApp any more:
 *      waConnect has no wa.me and no window.open; the eleven hub pages' booking submits and
 *      the parcel/rider/tracking support controls point at support.html; the remaining wa.me
 *      on those pages are the enumerated legacy classes (contact chips, registrations, share).
 *   W12-W19  Slice B2 (owner 2026-09-30: WhatsApp ONLY for OTP, invoices, marketing): every client
 *      line still naming wa.me carries wa-allowed:<otp|invoice|marketing>; chat.html?tx= opens only
 *      server-derivable transaction threads; My Orders' in-app actions (executed); no client page
 *      writes the auto-crediting refundRequests collection.
 *   N  negative controls: the old wa.me hop back into waConnect (N1); an unmarked hand-off and an
 *      invented marker class are both caught by the W12 detector (N2, N3).
 *
 * Run (all rows):  firebase emulators:exec --only firestore,auth --project demo-sliceb
 *                    "node scripts/test-slice-b-support-whatsapp.js"
 * Run (S + W only, no emulator): node scripts/test-slice-b-support-whatsapp.js --static
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const ROOT = path.join(__dirname, '..');
const STATIC_ONLY = process.argv.includes('--static');
let pass = 0, fail = 0;
const ck = (label, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
  /* ── S: the library, executed ── */
  console.log('\n── S: SokoniSupportContact submits to the server and trusts only its id ──');
  const calls = [], store = {};
  const mkWin = (reply) => {
    const fns = { httpsCallable: (n) => (p) => { calls.push({ n, p }); return reply(p); } };
    const w = { localStorage: { setItem: (k, v) => { store[k] = v; }, getItem: (k) => store[k] || null }, console,
      firebase: { auth: () => ({ currentUser: { uid: 'u1' } }), functions: () => fns, app: () => ({ functions: () => fns }) } };
    w.window = w; w.global = w; return vm.createContext(w);
  };
  let ctx = mkWin(() => Promise.resolve({ data: { ticketId: 'srv_ABC123' } }));
  vm.runInContext(read('sokoni-support-contact.js'), ctx, { filename: 'sokoni-support-contact.js' });
  const L = ctx.SokoniSupportContact;
  ck('S1  library loads on the live line', !!L && typeof L.submit === 'function', typeof L);
  const p = L.payloadFor({ category: 'delivery', subject: 'Parcel issue', message: 'My parcel is late', priority: 'high' });
  ck('S2  payload is the AdminOS op adminCreateSupportTicket with subject/message/priority', p.op === 'adminCreateSupportTicket' && p.subject === 'Parcel issue' && p.message === 'My parcel is late' && p.priority === 'high', p);
  let r = await L.submit({ category: 'delivery', subject: 'Parcel issue', message: 'My parcel is late', priority: 'high' });
  ck('S3  submit calls adminOsDispatch once and returns the SERVER id', calls.length === 1 && calls[0].n === 'adminOsDispatch' && r.ticketId === 'srv_ABC123', { calls, r });
  ck('S4  localStorage holds a cache of the SERVER id, flagged server:true, written after the reply', JSON.parse(store._sokoniLastTicket || '{}').id === 'srv_ABC123' && JSON.parse(store._sokoniLastTicket).server === true, store);
  ctx = mkWin(() => Promise.resolve({ data: {} })); delete store._sokoniLastTicket; calls.length = 0;
  vm.runInContext(read('sokoni-support-contact.js'), ctx, { filename: 'sokoni-support-contact.js' });
  let err = null; try { await ctx.SokoniSupportContact.submit({ category: 'delivery', subject: 'x', message: 'y', priority: 'low' }); } catch (e) { err = e.message; }
  ck('S5  no server id → the submit FAILS and nothing is cached (the old defect was "submitted" unconditionally)', err === 'no_ticket_id_returned' && !store._sokoniLastTicket, { err, store });
  const v = L.validate({ category: 'delivery', subject: '', message: 'y', priority: 'low' });
  ck('S6  an empty subject is refused before any call', v.ok === false && v.reason === 'subject_required', v);

  /* ── W: static — every supported surface ── */
  console.log('\n── W: no supported surface hands a booking or a support request to WhatsApp ──');
  const pay = read('sokoni-pay.js').replace(/\r\n/g, '\n');
  const waBody = pay.slice(pay.indexOf('function waConnect('), pay.indexOf('\n}\n', pay.indexOf('function waConnect(')));
  ck('W1  waConnect: no wa.me, no window.open, still the deposit gateway, ends in the in-app confirmation', !/wa\.me|window\.open/.test(waBody) && /showGateway\(/.test(waBody) && /_bookingRecorded\(ref, opts\)/.test(waBody), waBody.slice(0, 200));
  const rec = pay.slice(pay.indexOf('function _bookingRecorded('), pay.indexOf('function waConnect('));
  ck('W2  _bookingRecorded offers Support (support.html?topic=booking) and never WhatsApp', /support\.html\?topic=booking/.test(rec) && !/wa\.me/.test(rec), null);
  ck('W3  bookNow is untouched (the malformed callers are a separate contract repair)', /function bookNow\(opts, callback\)\{/.test(pay) && /bookingType:   "booking"/.test(pay), null);
  const sup = read('support.html');
  ck('W4  support.html: submit goes through SokoniSupportContact.submit; SokoniLaunch.submitTicket is not called', /SokoniSupportContact\.submit\(/.test(sup) && !/SokoniLaunch\.submitTicket\(/.test(sup), null);
  ck('W5  support.html: ticket lookup reads supportTickets from the server, no wa.me anywhere, no data-support-phone="wa" card', /collection\('supportTickets'\)\.doc\(id\)/.test(sup) && !/wa\.me/.test(sup) && !/data-support-phone="wa"/.test(sup), null);
  ck('W6  support.html: ?topic=&ref=&desc= prefill exists (Support buttons arrive with context; sos → critical)', /q\.get\('topic'\)/.test(sup) && /q\.get\('desc'\)/.test(sup) && /pr\.value = 'critical'/.test(sup), null);
  const d = read('delivery.html');
  ck('W7  delivery.html: no Book-via-WhatsApp, no SOKONI_WA, no wa.me; Support link present; share is native/copy', !/bookDeliveryWA|SOKONI_WA|wa\.me/.test(d) && /support\.html\?topic=parcel/.test(d) && /navigator\.share/.test(d), null);
  const drv = read('driver.html');
  ck('W8  driver.html: rider support row → support.html?topic=delivery (tel kept), no WhatsApp support button', /support\.html\?topic=delivery/.test(drv) && !/wa\.me\/254705726803\?text=Hi%20Sokoni%20Driver%20Support/.test(drv), null);
  const dt = read('delivery-tracking.html');
  /* dtShareWA is a SHARE of the tracking link (distribution, owner-allowed class) — the only wa.me permitted here. */
  const dtOther = dt.replace(/window\.dtShareWA = function\(\) \{[\s\S]*?\n\};/, '');
  ck('W9  delivery-tracking.html: SOS → support.html?topic=delivery; the only remaining wa.me is the share', /support\.html\?topic=delivery&ref=/.test(dt) && !/wa\.me/.test(dtOther) && (dt.match(/wa\.me/g) || []).length === 1, (dt.match(/wa\.me/g) || []).length);
  const HUB = { 'cleaning.html': ['Confirm Booking via WhatsApp', 'window.open(`https://wa.me/${_waNum}'], 'plumbing.html': ['Confirm Booking via WhatsApp', 'window.open(`https://wa.me/${_plWA}'],
    'electrical.html': ['Confirm Booking via WhatsApp', ":window.open(`https://wa.me/254${(selectedProv"], 'phone-repair.html': ['Confirm via WhatsApp', ":window.open(`https://wa.me/254${(selectedProv"],
    'car-rental.html': ['Confirm via WhatsApp', 'window.open(`https://wa.me/${_crWA}'], 'home-services.html': ['Book via WhatsApp', "window.open(`https://wa.me/254705726803?text=${encodeURIComponent(msg)}`,'_blank');\n  if(msgEl){msgEl.innerHTML='✅ Quote"],
    'tech-hub.html': ['Book Repair via WhatsApp', 'Hire via WhatsApp'], 'mechanics.html': ['Send Booking via WhatsApp', 'Opening WhatsApp'],
    'legal-hub.html': ['Opening WhatsApp... Booking ref', 'setTimeout(()=>{ window.open(`https://wa.me/${wa}'], 'car-hub.html': ['Confirm & Message on WhatsApp', "window.open('https://wa.me/'+phone+'?text='+waText"],
    'construction.html': ['call/WhatsApp', "window.open(`https://wa.me/254${e.phone"] };
  let hubOk = true, hubBad = [];
  for (const [f, needles] of Object.entries(HUB)) { const t = read(f); for (const n of needles) if (t.includes(n)) { hubOk = false; hubBad.push(f + ': ' + n); } if (!/support\.html\?topic=/.test(t)) { hubOk = false; hubBad.push(f + ': no Support link'); } }
  ck('W10 eleven hub pages: booking submits no longer say/open WhatsApp and each carries a Support link', hubOk, hubBad);
  /* Remaining wa.me on those pages are enumerated legacy classes — counted, not asserted away. */
  const remaining = Object.keys(HUB).map((f) => f + '=' + (read(f).match(/wa\.me/g) || []).length).join(' ');
  console.log('      remaining wa.me (legacy: contact chips, registrations, share): ' + remaining);
  const req = [['car-hub.html', 'SOKONI Roadside SOS', "location.href = 'support.html?topic=sos"], ['car-hub.html', 'Vehicle Transport Request', "location.href = 'support.html?topic=request"],
    ['mechanics.html', 'SOKONI ROADSIDE SOS', "location.href = 'support.html?topic=sos"], ['home-services.html', 'Quote Request*', "location.href = 'support.html?topic=quote"], ['tech-hub.html', 'IT Service Request', "location.href = 'support.html?topic=request"]];
  ck('W11 request-shaped hops (SOS ×2, transport, quote, IT request) now open a support ticket with the details prefilled', req.every(([f, near, to]) => { const t = read(f); const i = t.indexOf(near); return i > 0 && t.slice(i, i + 1200).includes(to); }), null);

  /* ── W12+ Slice B2 (owner 2026-09-30): WhatsApp is ONLY for OTP, invoices and marketing. Every
     client line that still names wa.me / api.whatsapp.com must declare which of the three it is,
     on that line, with `wa-allowed:<otp|invoice|marketing>`. Anything else is a hand-off. ── */
  console.log('\n── W12+: Slice B2 — WhatsApp only for OTP, invoices and marketing ──');
  const { execSync } = require('child_process');
  const clientFiles = execSync('git ls-files -- "*.html" "*.js"', { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/)
    .filter((f) => f && !/^(functions|scripts|docs|tests|node_modules|e2e|playwright)\//.test(f));
  const WA_RE = /wa\.me\/|api\.whatsapp\.com/;
  /* Two spellings of one marker: `wa-allowed:<class>` in JS comments, data-wa-allowed="<class>" in markup. */
  const ALLOWED_RE = /(?:wa-allowed:|data-wa-allowed=")(otp|invoice|marketing)\b/;
  const unmarked = (text, f) => text.split(/\r?\n/).map((l, i) => [l, i + 1]).filter(([l]) => WA_RE.test(l) && !ALLOWED_RE.test(l)).map(([l, n]) => f + ':' + n);
  /* index.html's two FOOTER links are converted by sokoni-70's hosting candidate (b1-unboxing-card0),
     which deploys before this slice; B2 does not edit those lines to avoid a conflict. They are
     named here, by exact URL, and nowhere else. After the rebase onto that deploy this list is empty. */
  /* opportunity.html applyNow() is claimed by sokoni-27's in-app application slice (owner ask, 2026-09-30);
     B2 leaves that one line to it. */
  const PEER_OWNED = (f, line) => (f === 'index.html' && /(social-handle|fa-whatsapp|aria-label="SOKONI on Wha)/.test(line) && /wa\.me\/254705726803"/.test(line))
    || (f === 'index.html' && /<!-- This link's href was https:\/\/wa\.me\/\.\.\. /.test(line))   /* a comment inside that footer block, not a link */
    || (f === 'opportunity.html' && /window\.open\(`https:\/\/wa\.me\/254705726803\?text=\$\{encodeURIComponent\(msg\)\}`/.test(line));
  const hand = [];
  for (const f of clientFiles) {
    let t; try { t = read(f); } catch (_) { continue; }
    if (!WA_RE.test(t)) continue;
    const lines = t.split(/\r?\n/);
    for (const ref of unmarked(t, f)) { const n = Number(ref.split(':').pop()); if (!PEER_OWNED(f, lines[n - 1])) hand.push(ref); }
  }
  ck('W12 no client file hands anyone to WhatsApp: every remaining wa.me line is marked otp / invoice / marketing', hand.length === 0, hand.slice(0, 40));
  const bad = [];
  for (const f of clientFiles) { let t; try { t = read(f); } catch (_) { continue; } (t.match(/(?:wa-allowed:|data-wa-allowed=")[a-z]*/g) || []).forEach((m) => { if (!/^(?:wa-allowed:|data-wa-allowed=")(otp|invoice|marketing)$/.test(m)) bad.push(f + ' ' + m); }); }
  ck('W13 the marker vocabulary is exactly otp / invoice / marketing (no fourth class can be smuggled in)', bad.length === 0, bad);
  const chat = read('chat.html');
  const openable = (chat.match(/var TX_OPENABLE = \{([\s\S]*?)\};/) || [])[1] || '';
  const txKeys = (openable.match(/[a-z_]+(?=:1)/g) || []).sort();
  const msgs = read('functions/messages.js');
  const partyKeys = (((msgs.match(/const PARTY_FIELDS = \{([\s\S]*?)\n\};/) || [])[1] || '').match(/^\s+([a-z_]+):/gm) || []).map((s) => s.trim().replace(':', '')).sort();
  ck('W14 chat.html?tx= opens only transaction types the server can derive parties for (TX_OPENABLE == PARTY_FIELDS)', txKeys.length > 0 && JSON.stringify(txKeys) === JSON.stringify(partyKeys), { txKeys, partyKeys });
  ck('W15 chat.html?tx= asks the server (SokoniChat.createConversation) and shows nothing until it answers; the id is validated', /SokoniChat\.createConversation\(TX_TYPE, TX_ID\)/.test(chat) && /\/\^\[A-Za-z0-9_-\]\{1,128\}\$\/\.test\(TX_ID\)/.test(chat) && /CONV_ID = id;/.test(chat), null);
  const cctx = vm.createContext({ window: {}, document: undefined });
  cctx.window = cctx; vm.runInContext(read('sokoni-company.js'), cctx, { filename: 'sokoni-company.js' });
  const CO = cctx.SOKONI_COMPANY;
  const coWa = CO && CO.supportPhoneHref && CO.supportPhoneHref('wa');
  ck('W16 the support-number helper never builds a WhatsApp link: its legacy "wa" kind opens the in-app Support page', coWa === null || coWa === 'support.html', coWa);

  /* W17 — My Orders, EXECUTED: orderActions() is lifted from the page and run on fixtures. */
  const mo = read('my-orders.html');
  const oaSrc = mo.slice(mo.indexOf('var NO_CHAT'), mo.indexOf('function orderDate(o){'));
  const oa = vm.runInNewContext(oaSrc + '; orderActions;', { encodeURIComponent });
  const aPaid = oa({ _fsId: 'ord_A1', status: 'delivered' });
  const aPend = oa({ _fsId: 'ord_A2', status: 'pending_payment' });
  const aCanc = oa({ _fsId: 'ord_A3', status: 'cancelled' });
  const aCache = oa({ id: 'LOCAL-1', status: 'delivered' });
  const aEvil = oa({ _fsId: 'x"><img src=x onerror=alert(1)>', status: 'delivered' });
  ck('W17 My Orders: a delivered order offers in-app Message seller (chat.html?tx=order) + Request refund (a support ticket, never a money call)',
    /chat\.html\?tx=order&amp;txId=ord_A1/.test(aPaid) && /support\.html\?topic=payment&amp;ref=ord_A1/.test(aPaid) && !/wa\.me|createDispute|refundRequests|refundPayment/.test(aPaid), aPaid);
  ck('W18 My Orders: unpaid → no refund action; cancelled → no chat; cache-only order (no server id) → no actions; a hostile id → no actions',
    /Message seller/.test(aPend) && !/Request refund/.test(aPend) && !/Message seller/.test(aCanc) && aCache === '' && aEvil === '', { aPend, aCanc, aCache, aEvil });

  /* W19 — `refundRequests` IS a money path (autoOnRefundRequest credits a wallet on create).
     No client file may write it; refunds stay REQUESTS a person approves. */
  const rrWriters = [];
  for (const f of clientFiles) { let t; try { t = read(f); } catch (_) { continue; } if (/collection\(\s*(db\s*,\s*)?['"]refundRequests['"]\s*\)\s*\.(add|doc)|doc\(\s*db\s*,\s*['"]refundRequests['"]|addDoc\(\s*collection\(\s*db\s*,\s*['"]refundRequests['"]/.test(t)) rrWriters.push(f); }
  ck('W19 no client page writes refundRequests (creating one IS a wallet credit — never wired to a button)', rrWriters.length === 0, rrWriters);

  /* ── N: negative control (in memory) ── */
  const sabotaged = waBody.replace('_bookingRecorded(ref, opts)', 'window.open("https://wa.me/"+providerPhone)');
  ck('N1  negative control: the old wa.me hop back in waConnect turns W1 red', /wa\.me|window\.open/.test(sabotaged), null);
  ck('N2  negative control: an unmarked provider hand-off line is caught by the W12 detector', unmarked("x\n<a href=\"https://wa.me/${p.phone}?text=hi\">Chat</a>\n", 'probe.html').length === 1, null);
  ck('N3  negative control: a marked invoice line passes, a made-up marker class does not', unmarked("window.open('https://wa.me/'+n) /* wa-allowed:invoice */", 'p.js').length === 0 && unmarked("window.open('https://wa.me/'+n) /* wa-allowed:support */", 'p.js').length === 1, null);

  /* ── B: the real page, in a browser, with a stub firebase and every other origin aborted ── */
  console.log('\n── B: support.html in Chromium — the form reaches adminOsDispatch and shows the server id ──');
  try {
    const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
    const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
    const srv = http.createServer((rq, rs) => { const u = decodeURIComponent(rq.url.split('?')[0]); const fp = path.join(ROOT, u === '/' ? 'index.html' : u); if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { rs.writeHead(404); rs.end(); return; } rs.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' }); fs.createReadStream(fp).pipe(rs); });
    await new Promise((res) => srv.listen(0, '127.0.0.1', res));
    const base = 'http://127.0.0.1:' + srv.address().port;
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.route('**/*', (route) => { const u = route.request().url(); if (u.startsWith(base)) return route.continue(); return route.abort(); });
    await page.addInitScript(() => {
      window.__calls = [];
      const fns = { httpsCallable: (n) => (p) => { window.__calls.push({ n, p }); return Promise.resolve({ data: { ticketId: 'srv_BROWSER1' } }); } };
      window.firebase = { apps: [{}], initializeApp() {}, app: () => ({ functions: () => fns }), functions: () => fns, auth: () => ({ currentUser: { uid: 'u1' }, onAuthStateChanged(cb) { cb({ uid: 'u1' }); } }),
        firestore: () => ({ collection: () => ({ doc: () => ({ get: () => Promise.resolve({ exists: false }) }) }) }) };
      window.firebase.firestore.FieldValue = {};
      try { localStorage.removeItem('_sokoniLastTicket'); } catch (_) {}
    });
    const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)));
    await page.goto(base + '/support.html?topic=parcel&ref=PRCtest1', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    const prefill = await page.evaluate(() => ({ desc: document.getElementById('spDesc').value, ref: document.getElementById('spRef').value, chip: (document.querySelector('#spCategory .active') || {}).dataset?.v }));
    ck('B1  ?topic=parcel&ref= prefilled the description, the reference and the Delivery chip', /parcel/i.test(prefill.desc) && prefill.ref === 'PRCtest1' && prefill.chip === 'delivery', prefill);
    await page.evaluate(() => { showTab('ticket', document.querySelectorAll('.sp-tab')[1]); });
    await page.fill('#spName', 'Test User'); await page.fill('#spPhone', '0712345678'); await page.fill('#spDesc', 'My parcel PRCtest1 has not moved.');
    /* The real button's own onclick (submitTicket) — dispatched as a click event, not called
       directly, so the wiring from the control to the authority is what is exercised. */
    await page.evaluate(() => document.getElementById('spSubmitBtn').click());
    await page.waitForTimeout(600);
    const out = await page.evaluate(() => ({ calls: window.__calls, shown: (document.getElementById('spTicketIdDisplay') || {}).textContent, cache: localStorage.getItem('_sokoniLastTicket'), successVisible: getComputedStyle(document.getElementById('spTicketSuccess')).display !== 'none' }));
    /* Other page scripts (device registration) may call their own callables on load; the
       assertion is about the ticket call: exactly ONE adminOsDispatch, with the typed message. */
    const tk = out.calls.filter((c) => c.n === 'adminOsDispatch');
    ck('B2  clicking Submit called adminOsDispatch once with op adminCreateSupportTicket and the typed message', tk.length === 1 && tk[0].p.op === 'adminCreateSupportTicket' && /PRCtest1/.test(tk[0].p.message) && tk[0].p.category === 'delivery', out.calls.map((c) => c.n));
    ck('B3  the page shows the SERVER id and only then caches it', /srv_BROWSER1/.test(out.shown) && out.successVisible && JSON.parse(out.cache || '{}').id === 'srv_BROWSER1', out);
    ck('B4  no page errors', errs.length === 0, errs);
    await browser.close(); srv.close();
  } catch (e) { ck('B*  browser rows', false, String(e.message).slice(0, 200)); }

  /* ── R: the real handler, Firestore emulator, deployed lineage ── */
  if (!STATIC_ONLY) {
    console.log('\n── R: the payload reaches the REAL adminOsDispatch → supportTickets → AdminOS list ──');
    if (!process.env.FIRESTORE_EMULATOR_HOST || !/^demo-/.test(process.env.GCLOUD_PROJECT || '')) { ck('R0  emulator present (run under emulators:exec with a demo-* project, or pass --static)', false, process.env.GCLOUD_PROJECT); }
    else {
      process.env.FUNCTIONS_EMULATOR = 'true';
      const FN = path.resolve(process.env.FUNCTIONS_DIR || 'C:/temp/sok-f1/functions');
      console.log('      FUNCTIONS: ' + FN);
      const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
      if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
      const db = admin.firestore();
      const disp = require(path.join(FN, 'admin-os-dispatch.js'));
      await db.collection('users').doc('u1').set({ email: 'u1@example.com', displayName: 'Test User' });
      const payload = L.payloadFor({ category: 'delivery', subject: 'Parcel issue', message: 'Ticket from the browser payload', priority: 'high' });
      const res = await disp.adminOsDispatch.run({ auth: { uid: 'u1', token: {} }, data: payload });
      const doc = res && res.ticketId ? (await db.collection('supportTickets').doc(res.ticketId).get()).data() : null;
      ck('R1  the exact browser payload creates supportTickets/{id} for the caller, status open', !!doc && doc.uid === 'u1' && doc.status === 'open' && doc.subject === 'Parcel issue' && doc.category === 'delivery' && doc.priority === 'high', doc);
      let e2 = null; try { await disp.adminOsDispatch.run({ auth: null, data: payload }); } catch (e) { e2 = e.message; }
      ck('R2  unauthenticated → refused', /unauthenticated/.test(String(e2)), e2);
      let e3 = null; try { await disp.adminOsDispatch.run({ auth: { uid: 'u1', token: {} }, data: { op: 'adminGetSupportTickets', status: 'open' } }); } catch (e) { e3 = e.message; }
      ck('R3  a customer cannot list tickets (AdminOS op is admin/superAdmin only)', /admin required/.test(String(e3)), e3);
      const list = await disp.adminOsDispatch.run({ auth: { uid: 'sa1', token: { superAdmin: true } }, data: { op: 'adminGetSupportTickets', status: 'open', limit: 30 } });
      const rows = (list && (list.tickets || list.items || list.data || list)) || [];
      const arr = Array.isArray(rows) ? rows : (Array.isArray(rows.tickets) ? rows.tickets : []);
      ck('R4  the super admin\'s AdminOS list op returns the ticket (owner: routed to AdminOS super admin)', arr.some((t) => t.id === res.ticketId || t.ticketId === res.ticketId), { n: arr.length, keys: Object.keys(list || {}) });
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
