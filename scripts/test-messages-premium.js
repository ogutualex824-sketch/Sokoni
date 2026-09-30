#!/usr/bin/env node
/**
 * Messages inbox — premium page certification (2026-09-30)
 *
 * PART A (Node, no browser)  — the category registry in sokoni-chat-engine.js:
 *   R1 every CONTEXTS type is covered by exactly one explicit category (no orphan type, no double-home)
 *   R2 no category names a type the engine does not have
 *   R3 Invoices is DERIVED from the `view_invoice` action and equals the contexts that carry it
 *   R4 categoryMatches: all / unread / other / explicit behave on real projection rows
 *   R5 categorySummary counts + unread from rows only; `other` is hidden until a row needs it
 *   R6 createConversation never sends participantUids; sokoni-inbox.createOrOpen writes nothing
 *
 * PART B (Playwright, chromium) — the real messages.html over a local static server. ALL external
 * origins are aborted (nothing reaches production). Firebase compat is STUBBED with ASYNC snapshots
 * carrying a fixture of every CONTEXTS type, one legacy type, and one conversation the user is NOT a
 * participant of (negative control).
 *   B1 every category chip renders, from the registry, with counts from the fixture
 *   B2 each chip filters to exactly the rows the registry says (incl. Unread, Invoices, Other)
 *   B3 unread badges (per chip, per row, header total) equal the fixture
 *   B4 a conversation of EVERY type opens and its messages render (own/other/system)
 *   B5 negative control: the non-participant conversation is not in the list and ?id= renders Unavailable, never a message
 *   B6 four states: loading → ready; empty; unauthenticated; unreadable (permission-denied) — each distinct, unreadable ≠ empty
 *   B7 layouts at 360 / 390 / 768 / 1280: no horizontal overflow, phone = one pane with a 44px back button, desktop = both panes
 *   B8 legacy ?with= arrival shows the honest notice
 *   B9 composer: send goes through the engine (sendMessage op), nothing renders as sent before the callable resolves
 *
 * Run:   node scripts/test-messages-premium.js            (A + B)
 *        node scripts/test-messages-premium.js --registry (A only — no browser)
 */
'use strict';
const path = require('path'), http = require('http'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const say = console.log;
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 500) + ']' : '')); ok ? pass++ : fail++; };
const head = (t) => say('\n' + t);
const REGISTRY_ONLY = process.argv.includes('--registry');

/* ─────────────────────────────── FIXTURE ─────────────────────────────── */
const ME = 'u_me', OTHER = 'u_other', RIDER = 'u_rider', STRANGER_A = 'u_sa', STRANGER_B = 'u_sb';
const ENGINE_SRC = fs.readFileSync(path.join(ROOT, 'sokoni-chat-engine.js'), 'utf8');
const Chat = require(path.join(ROOT, 'sokoni-chat-engine.js'));
const TYPES = Object.keys(Chat.CONTEXTS);
const T0 = Date.UTC(2026, 8, 30, 8, 0, 0);
const ts = (ms) => ({ __ts: ms });     /* serialised; the browser stub turns it into a Timestamp-like */

/* unreadCount per type — deterministic, several zero, several > 0 */
const UNREAD = {};
TYPES.forEach((t, i) => { UNREAD[t] = (i % 3 === 0) ? (i / 3 + 1) : 0; });
const LEGACY = { type: 'legacy_dm', unread: 2 };

function convDocs() {
  const conversations = {}, items = {}, messages = {};
  const mk = (type, i, extra) => {
    const id = type + '_tx' + i;
    const participants = extra && extra.participants ? extra.participants : [ME, OTHER];
    conversations[id] = Object.assign({
      transactionType: type, transactionId: 'tx' + i, transactionTitle: (Chat.getContext(type).label) + ' #TX' + i,
      participants, participantNames: { [ME]: 'Me', [OTHER]: 'Amina Wanjiru', [RIDER]: 'Rider Otieno', [STRANGER_A]: 'A', [STRANGER_B]: 'B' },
      status: (extra && extra.status) || 'active', lastMessageAt: ts(T0 + i * 60000), createdAt: ts(T0), unreadCounts: {},
    }, extra && extra.conv);
    messages[id] = [
      { id: 'm1', senderId: OTHER, type: 'text', text: 'Hello about ' + type + ' (' + i + ')', timestamp: ts(T0 + i * 60000 - 3000), createdAt: ts(T0 + i * 60000 - 3000) },
      { id: 'm2', senderId: ME,    type: 'text', text: 'Reply from me ' + i,                   timestamp: ts(T0 + i * 60000 - 2000), createdAt: ts(T0 + i * 60000 - 2000) },
      { id: 'm3', senderId: 'system', type: 'system', text: 'Status: confirmed',               timestamp: ts(T0 + i * 60000 - 1000), createdAt: ts(T0 + i * 60000 - 1000) },
    ];
    return id;
  };
  TYPES.forEach((t, i) => {
    const id = mk(t, i + 1);
    items[id] = { conversationId: id, transactionType: t, transactionId: 'tx' + (i + 1), title: conversations[id].transactionTitle,
      participantName: 'Amina Wanjiru', participantAvatar: null, lastMessageAt: ts(T0 + (i + 1) * 60000), lastMessageText: 'Reply from me ' + (i + 1),
      lastMessageSenderId: ME, unreadCount: UNREAD[t], status: 'active' };
  });
  /* legacy row with a type the registry does not know */
  const lid = mk(LEGACY.type, 99);
  items[lid] = { conversationId: lid, transactionType: LEGACY.type, transactionId: 'tx99', title: 'Old direct message', participantName: 'Legacy Contact',
    lastMessageAt: ts(T0 + 99 * 60000), lastMessageText: 'old thread', lastMessageSenderId: OTHER, unreadCount: LEGACY.unread, status: 'active' };
  /* a read-only one */
  conversations['order_tx1'].status = 'read_only';
  /* NEGATIVE CONTROL: not a participant; must never render */
  mk('order', 500, { participants: [STRANGER_A, STRANGER_B] });
  return { conversations, items, messages };
}
const FIX = convDocs();
const STRANGER_ID = 'order_tx500';
const expectedRows = Object.keys(FIX.items).length;   /* 17 + legacy = 18 */

/* ─────────────────────────────── PART A ─────────────────────────────── */
head('A. Category registry (Node)');
{
  const explicit = Chat.CATEGORIES.filter((c) => !c.kind || c.kind === 'types');
  const homes = {}; TYPES.forEach((t) => { homes[t] = explicit.filter((c) => c.types.includes(t)).map((c) => c.id); });
  const orphans = TYPES.filter((t) => homes[t].length === 0), dbl = TYPES.filter((t) => homes[t].length > 1);
  ck('R1 every one of the ' + TYPES.length + ' CONTEXTS types has exactly one explicit category', orphans.length === 0 && dbl.length === 0, { orphans, dbl });
  const unknown = []; Chat.CATEGORIES.forEach((c) => (c.types || []).forEach((t) => { if (!Chat.CONTEXTS[t]) unknown.push(c.id + ':' + t); }));
  ck('R2 no category names a type the engine does not have', unknown.length === 0, unknown);
  const inv = Chat.getCategory('invoices');
  const withInvoice = TYPES.filter((t) => (Chat.CONTEXTS[t].actions || []).some((a) => a.id === 'view_invoice')).sort();
  ck('R3 Invoices is derived from the view_invoice action = ' + withInvoice.join(','), !!inv && inv.derived === true && inv.types.slice().sort().join() === withInvoice.join() && withInvoice.length >= 3, inv && inv.types);
  const row = (type, unread) => ({ transactionType: type, unreadCount: unread });
  ck('R4 categoryMatches: all / unread / other / explicit',
    Chat.categoryMatches('all', row('order', 0)) && Chat.categoryMatches('unread', row('order', 3)) && !Chat.categoryMatches('unread', row('order', 0)) &&
    Chat.categoryMatches('other', row('legacy_dm', 0)) && !Chat.categoryMatches('other', row('order', 0)) &&
    Chat.categoryMatches('orders', row('food_order', 0)) && !Chat.categoryMatches('orders', row('rfq', 0)) && !Chat.categoryMatches('nope', row('order', 0)));
  const rows = Object.values(FIX.items);
  const sum = Chat.categorySummary(rows), byId = {}; sum.forEach((s) => { byId[s.id] = s; });
  const expUnread = rows.reduce((s, r) => s + (r.unreadCount > 0 ? r.unreadCount : 0), 0);
  const noRowsSum = Chat.categorySummary([]);
  ck('R5 categorySummary counts from rows; all=' + rows.length + ', unread total=' + expUnread + '; `other` visible only with a row',
    byId.all.count === rows.length && byId.all.unread === expUnread && byId.unread.count === rows.filter((r) => r.unreadCount > 0).length &&
    byId.other.count === 1 && byId.other.visible === true && noRowsSum.find((s) => s.id === 'other').visible === false &&
    byId.orders.count === 3 && byId.support.count === 1, { all: byId.all, other: byId.other });
  const wrapper = ENGINE_SRC.slice(ENGINE_SRC.indexOf('function createConversation('), ENGINE_SRC.indexOf('function markRead('));
  const inbox = fs.readFileSync(path.join(ROOT, 'sokoni-inbox.js'), 'utf8');
  const coo = inbox.slice(inbox.indexOf('SokoniInbox.createOrOpen ='), inbox.indexOf('SokoniInbox.createOrOpen =') + 80);
  ck('R6 createConversation never sends participantUids; sokoni-inbox.createOrOpen is inert (no setDoc, returns null)',
    !/participantUids\s*:/.test(wrapper) && /return null/.test(coo) && !/setDoc|participants/.test(coo));
}

if (REGISTRY_ONLY) { finish(); }
else runBrowser().then(finish, (e) => { say('  HARNESS ERROR ' + (e && e.stack || e)); fail++; finish(); });

function finish() {
  say('\n' + pass + ' passed, ' + fail + ' failed' + (REGISTRY_ONLY ? '  (registry only — browser part NOT run)' : ''));
  process.exit(fail ? 1 : 0);
}

/* ─────────────────────────────── PART B ─────────────────────────────── */
function resolvePlaywright() {
  const cands = [path.join(ROOT, 'node_modules', 'playwright'), 'playwright'];
  for (const c of cands) { try { const pw = require(c); say('  playwright from ' + c); return pw; } catch (_) { /* next */ } }
  throw new Error('playwright not found in ' + cands.join(' | '));
}

/* The stub is injected as an init script BEFORE any page script; the gstatic compat
   tags are served as empty files so they never fail. Snapshots are ASYNC (setTimeout). */
function stubSource(mode) {
  return `(function(){
  var FIX = ${JSON.stringify(FIX)}; var ME = ${JSON.stringify(ME)}; var MODE = ${JSON.stringify(mode)};
  window.__ops = []; window.__stubMode = MODE;
  function T(ms){ return { toDate:function(){return new Date(ms);}, toMillis:function(){return ms;}, seconds:Math.floor(ms/1000) }; }
  function hydrate(o){ if(o&&typeof o==='object'){ if('__ts' in o) return T(o.__ts); var out=Array.isArray(o)?[]:{}; for(var k in o) out[k]=hydrate(o[k]); return out; } return o; }
  var conversations = hydrate(FIX.conversations), items = hydrate(FIX.items), messages = hydrate(FIX.messages);
  function denied(){ var e=new Error('Missing or insufficient permissions.'); e.code='permission-denied'; return e; }
  function later(fn){ setTimeout(fn, 40); }
  function isParticipant(cid){ var c=conversations[cid]; return !!c && c.participants.indexOf(ME)!==-1; }
  function snapOf(arr){ var docs=arr.map(function(d){ return { id:d.id, data:function(){ var x={}; for(var k in d) if(k!=='id') x[k]=d[k]; return x; }, exists:true }; }); return { docs:docs, size:docs.length, forEach:function(f){docs.forEach(f);} }; }
  function Query(kind, cid){ this.kind=kind; this.cid=cid; this._limit=50; }
  Query.prototype.orderBy=function(){ return this; }; Query.prototype.limit=function(n){ this._limit=n; return this; };
  Query.prototype.where=function(){ return this; }; Query.prototype.startAfter=function(){ return this; };
  Query.prototype.onSnapshot=function(ok, err){
    var q=this; var alive=true;
    later(function(){ if(!alive) return;
      if(q.kind==='items'){ if(MODE==='denied') return err(denied()); if(MODE==='empty') return ok(snapOf([]));
        var rows=Object.keys(items).map(function(k){ return Object.assign({id:k}, items[k]); }); return ok(snapOf(rows)); }
      if(q.kind==='messages'){ if(!isParticipant(q.cid)) return err(denied()); var ms=(messages[q.cid]||[]).slice().reverse().slice(0,q._limit); return ok(snapOf(ms)); }
      ok(snapOf([]));
    });
    return function(){ alive=false; };
  };
  Query.prototype.get=function(){ var q=this; return new Promise(function(res,rej){ q.onSnapshot(res,rej); }); };
  /* a sub-collection is both a query and a doc factory (typingIndicators/{id}/users/{uid}) */
  Query.prototype.doc=function(id){ return new Doc(this.col||'sub', id||('auto'+Math.random())); };
  function Doc(col, id){ this.col=col; this.id=id; }
  Doc.prototype.collection=function(name){ var q;
    if(this.col==='userConversations'&&name==='items'){ if(this.id!==ME){ q=new Query('x'); q.onSnapshot=function(_,e){ later(function(){e(denied());}); return function(){}; }; return q; } q=new Query('items'); }
    else if(this.col==='conversations'&&name==='messages') q=new Query('messages', this.id);
    else q=new Query('x');
    q.col=this.col+'/'+name; return q; };
  Doc.prototype.get=function(){ var d=this; return new Promise(function(res,rej){ later(function(){
    if(d.col==='conversations'){ var c=conversations[d.id]; if(!c) return res({exists:false, id:d.id, data:function(){return undefined;}}); if(!isParticipant(d.id)) return rej(denied()); return res({exists:true, id:d.id, data:function(){return c;}}); }
    res({exists:false, data:function(){return undefined;}}); }); }); };
  /* the rules allow ONE client write on this surface: typingIndicators/{conv}/users/{uid}. Every other write is a defect. */
  Doc.prototype.set=function(){ if(/^typingIndicators\//.test(this.col)) return Promise.resolve(); window.__ops.push({write:this.col, id:this.id}); return Promise.reject(denied()); };
  Doc.prototype.update=Doc.prototype.set;
  function Col(name){ this.name=name; }
  Col.prototype.doc=function(id){ return new Doc(this.name, id||('auto'+Math.random())); };
  var db={ collection:function(n){ return new Col(n); } };
  var user = MODE==='unauth' ? null : { uid:ME, displayName:'Me', email:'me@example.com' };
  var auth={ currentUser:user, onAuthStateChanged:function(cb){ later(function(){ cb(user); }); return function(){}; } };
  function callable(name){ return function(data){ window.__ops.push({fn:name, data:data}); return new Promise(function(res){ setTimeout(function(){
    if(name==='messagesDispatch' && data.op==='sendMessage'){ var cid=data.conversationId; (messages[cid]=messages[cid]||[]).push({id:'m'+Date.now(), senderId:ME, type:'text', text:data.text, timestamp:T(Date.now()), createdAt:T(Date.now())}); }
    res({data:{ok:true}}); }, 60); }); }; }
  var fns={ httpsCallable:callable };
  var storage={ ref:function(){ return { child:function(){ return { put:function(){ throw new Error('no uploads'); }, getDownloadURL:function(){ return Promise.resolve(null); } }; } }; } };
  var firebase={ apps:[{name:'[DEFAULT]'}], initializeApp:function(){ return firebase.apps[0]; }, app:function(){ return firebase.apps[0]; },
    auth:function(){ return auth; }, firestore:function(){ return db; }, functions:function(){ return fns; }, storage:function(){ return storage; }, appCheck:function(){ return { activate:function(){} }; } };
  firebase.firestore.FieldValue={ serverTimestamp:function(){ return T(Date.now()); }, increment:function(n){ return n; } };
  window.firebase=firebase;   /* the compat tags are served empty, so nothing overwrites this */
})();`;
}

async function runBrowser() {
  head('B. Browser (chromium, hermetic)');
  const pw = resolvePlaywright();
  const TYPES_MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    /* the modular bootstrap and app-check are replaced by the stub (they only import gstatic) */
    if (u === '/firebase.js' || u === '/sokoni-appcheck.js' || u === '/sokoni-merchant-diag.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end('/* stubbed by test-messages-premium */'); }
    const f = path.join(ROOT, u === '/' ? 'index.html' : u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES_MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const browser = await pw.chromium.launch();

  const open = async (mode, width, url) => {
    const ctx = await browser.newContext({ viewport: { width: width || 390, height: 800 }, serviceWorkers: 'block', deviceScaleFactor: 1 });
    await ctx.route('**/*', (r) => {
      const u = r.request().url();
      if (u.startsWith(BASE)) return r.continue();
      if (/gstatic\.com\/firebasejs\//.test(u)) return r.fulfill({ status: 200, contentType: 'application/javascript', body: '/* compat sdk stubbed */' });
      return r.abort();
    });
    await ctx.addInitScript(stubSource(mode));
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(String(e && e.stack || e && e.message || e)));
    await page.goto(BASE + (url || '/messages.html'), { waitUntil: 'domcontentloaded' });
    return { ctx, page, errors };
  };
  const listState = (page) => page.$eval('#convList', (el) => el.getAttribute('data-state'));
  const waitState = (page, st, t) => page.waitForSelector('#convList[data-state="' + st + '"]', { timeout: t || 6000 }).then(() => true).catch(() => false);
  const chips = (page) => page.$$eval('#filters .filter-chip', (els) => els.map((e) => ({ id: e.dataset.filter, count: +e.dataset.count, unread: +e.dataset.unread, active: e.classList.contains('active'), h: e.getBoundingClientRect().height })));
  const rows = (page) => page.$$eval('#convList [data-conv-id]', (els) => els.map((e) => ({ id: e.dataset.convId, type: e.dataset.type, unread: e.classList.contains('unread'), badge: (e.querySelector('.unread-badge') || {}).textContent || '' })));

  try {
    /* ── ready state, chips, filters, unread ── */
    let b = await open('ready', 1280);
    const loadingFirst = await listState(b.page);
    const ready = await waitState(b.page, 'ready');
    ck('B6a loading is the first state, then ready (async snapshot)', loadingFirst === 'loading' && ready, { loadingFirst, ready });
    const cs = await chips(b.page);
    const expectedVisible = Chat.categorySummary(Object.values(FIX.items)).filter((c) => c.visible).map((c) => c.id);
    ck('B1 every registry category renders as a chip, in registry order, incl. Other (legacy row present): ' + expectedVisible.length + ' chips',
      cs.map((c) => c.id).join() === expectedVisible.join(), cs.map((c) => c.id));
    const sum = {}; Chat.categorySummary(Object.values(FIX.items)).forEach((s) => { sum[s.id] = s; });
    const countOk = cs.every((c) => c.count === sum[c.id].count && c.unread === sum[c.id].unread);
    ck('B3a chip counts and unread badges equal the fixture', countOk, cs);
    const rs = await rows(b.page);
    ck('B3b ' + expectedRows + ' rows render under All; per-row unread badge equals the fixture; the non-participant conversation is absent',
      rs.length === expectedRows && !rs.some((r) => r.id === STRANGER_ID) && rs.every((r) => (FIX.items[r.id].unreadCount > 0) === r.unread && (r.unread ? +r.badge === FIX.items[r.id].unreadCount : true)), { n: rs.length });
    const totalUnread = Object.values(FIX.items).reduce((s, r) => s + (r.unreadCount > 0 ? r.unreadCount : 0), 0);
    const hdr = await b.page.$eval('#unreadTotal', (e) => ({ hidden: e.hidden, text: e.textContent }));
    ck('B3c header unread total = ' + totalUnread, !hdr.hidden && +hdr.text === totalUnread, hdr);

    let filterOk = true, filterDetail = [];
    for (const c of expectedVisible) {
      await b.page.click('#filters [data-filter="' + c + '"]');
      await b.page.waitForTimeout(30);
      const got = (await rows(b.page)).map((r) => r.id).sort();
      const exp = Object.values(FIX.items).filter((r) => Chat.categoryMatches(c, r)).map((r) => r.conversationId).sort();
      const st = await listState(b.page);
      const ok = got.join() === exp.join() && (exp.length ? st === 'ready' : st === 'empty-filter');
      if (!ok) { filterOk = false; filterDetail.push({ c, got, exp, st }); }
    }
    ck('B2 each chip filters to exactly the registry\'s rows (Unread, Invoices, Other included); an empty category says "Nothing here", never "No conversations"', filterOk, filterDetail);
    await b.page.click('#filters [data-filter="all"]');
    await b.page.fill('#searchInput', 'zzzz-no-such');
    await b.page.waitForTimeout(300);
    ck('B2b search with no hit is the empty-filter state (not empty)', (await listState(b.page)) === 'empty-filter');
    await b.page.fill('#searchInput', '');
    await b.page.waitForTimeout(300);

    /* ── open every type ── */
    let openOk = true, openDetail = [];
    for (const id of Object.keys(FIX.items)) {
      await b.page.click('#convList [data-conv-id="' + id + '"]');
      const st = await b.page.waitForSelector('#threadPane[data-state="ready"]', { timeout: 4000 }).then(() => 'ready').catch(() => null);
      const got = await b.page.$$eval('#tBody [data-msg-id]', (els) => els.map((e) => ({ id: e.dataset.msgId, mine: e.dataset.mine, sys: e.classList.contains('sys'), text: e.textContent })));
      const name = await b.page.$eval('#tName', (e) => e.textContent);
      const sub = await b.page.$eval('#tSub', (e) => e.textContent);
      const ro = await b.page.$eval('#tBanner', (e) => e.hidden);
      const comp = await b.page.$eval('#composer', (e) => e.hidden);
      const expLabel = Chat.getContext(FIX.items[id].transactionType).label;
      const ok = st === 'ready' && got.length === 3 && got[0].id === 'm1' && got[0].mine === 'false' && got[1].mine === 'true' && got[2].sys && /Hello about/.test(got[0].text) &&
        name === 'Amina Wanjiru' && sub.startsWith(expLabel) && (id === 'order_tx1' ? (!ro && comp) : (ro && !comp));
      if (!ok) { openOk = false; openDetail.push({ id, st, got: got.length, name, sub, ro, comp }); }
    }
    ck('B4 a conversation of every type (' + Object.keys(FIX.items).length + ') opens: header name + type label, 3 messages (other / mine / system); order_tx1 is read-only (banner, no composer)', openOk, openDetail);
    const desktopBoth = await b.page.evaluate(() => ({ list: getComputedStyle(document.querySelector('.pane-list')).display !== 'none', thread: getComputedStyle(document.querySelector('.pane-thread')).display !== 'none', back: getComputedStyle(document.getElementById('backBtn')).display === 'none' }));
    ck('B7a 1280: list and thread side by side, back button hidden', desktopBoth.list && desktopBoth.thread && desktopBoth.back, desktopBoth);

    /* ── composer ── */
    await b.page.click('#convList [data-conv-id="rfq_tx17"]');
    await b.page.waitForSelector('#threadPane[data-state="ready"]');
    const before = await b.page.$$eval('#tBody [data-msg-id]', (els) => els.length);
    await b.page.fill('#msgInput', 'Quote accepted, thanks');
    await b.page.click('#sendBtn');
    const opsAfterClick = await b.page.evaluate(() => window.__ops.filter((o) => o.fn === 'messagesDispatch' && o.data.op === 'sendMessage'));
    const immediate = await b.page.$$eval('#tBody [data-msg-id]', (els) => els.length);
    await b.page.waitForTimeout(250);
    const cleared = await b.page.$eval('#msgInput', (e) => e.value);
    const writes = await b.page.evaluate(() => window.__ops.filter((o) => o.write));
    ck('B9 send goes through messagesDispatch{op:sendMessage} with the text; nothing is appended locally before the callable resolves; no client Firestore write of any kind',
      opsAfterClick.length === 1 && opsAfterClick[0].data.text === 'Quote accepted, thanks' && opsAfterClick[0].data.conversationId === 'rfq_tx17' && immediate === before && cleared === '' && writes.length === 0,
      { ops: opsAfterClick.length, immediate, before, cleared, writes: writes.length });
    const ours = b.errors.filter((e) => /messages\.html|sokoni-chat-engine\.js/.test(e));
    ck('B0 no page errors from messages.html or sokoni-chat-engine.js in the ready run (all errors listed)', ours.length === 0, b.errors);
    await b.ctx.close();

    /* ── negative control via deep link ── */
    b = await open('ready', 1280, '/messages.html?id=' + STRANGER_ID);
    await waitState(b.page, 'ready');
    const neg = await b.page.waitForSelector('#threadPane[data-state="unreadable"]', { timeout: 4000 }).then(() => true).catch(() => false);
    const negMsgs = await b.page.$$eval('#tBody [data-msg-id]', (els) => els.length);
    const negText = await b.page.$eval('#tBody', (e) => e.textContent);
    ck('B5 negative control: ?id= of a conversation the user is NOT in renders Unavailable — zero messages, never a message body', neg && negMsgs === 0 && /unavailable/i.test(negText) && !/Hello about/.test(negText), { neg, negMsgs });
    await b.ctx.close();

    /* ── four states ── */
    b = await open('empty', 390);
    ck('B6b empty: a real empty snapshot says "No conversations yet" (state=empty) and chips show 0', (await waitState(b.page, 'empty')) && /No conversations yet/.test(await b.page.$eval('#convList', (e) => e.textContent)) && (await chips(b.page)).every((c) => c.count === 0));
    await b.ctx.close();
    b = await open('unauth', 390);
    const un = await waitState(b.page, 'unauth');
    const unTxt = await b.page.$eval('#convList', (e) => e.textContent);
    const unHref = await b.page.$eval('#convList a.btn', (e) => e.getAttribute('href')).catch(() => null);
    ck('B6c unauthenticated: a sign-in panel with a login link (no silent redirect, no "no messages")', un && /Sign in/.test(unTxt) && !/No conversations/.test(unTxt) && unHref === 'login.html?redirect=messages.html' && b.page.url().includes('messages.html'), { unHref });
    await b.ctx.close();
    b = await open('denied', 390);
    const dn = await waitState(b.page, 'unreadable');
    const dnTxt = await b.page.$eval('#convList', (e) => e.textContent);
    ck('B6d unreadable (permission-denied): "Messages unavailable" with the code and a retry — never "No conversations"', dn && /Messages unavailable/.test(dnTxt) && /permission-denied/.test(dnTxt) && !/No conversations/.test(dnTxt) && !!(await b.page.$('#retryBtn')));
    await b.ctx.close();

    /* ── layouts ── */
    for (const w of [360, 390, 768, 1280]) {
      b = await open('ready', w);
      await waitState(b.page, 'ready');
      const m = await b.page.evaluate(() => {
        const chip = document.querySelector('#filters .filter-chip'); const row = document.querySelector('#convList [data-conv-id]');
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, bsw: document.body.scrollWidth,
          chipH: chip.getBoundingClientRect().height, rowH: row.getBoundingClientRect().height,
          list: getComputedStyle(document.querySelector('.pane-list')).display !== 'none', thread: getComputedStyle(document.querySelector('.pane-thread')).display !== 'none' };
      });
      await b.page.click('#convList [data-conv-id="rfq_tx17"]');   /* an ACTIVE thread: the composer must be on screen */
      await b.page.waitForSelector('#threadPane[data-state="ready"]');
      const t = await b.page.evaluate(() => {
        const back = document.getElementById('backBtn'), r = back.getBoundingClientRect(), send = document.getElementById('sendBtn').getBoundingClientRect();
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, list: getComputedStyle(document.querySelector('.pane-list')).display !== 'none', thread: getComputedStyle(document.querySelector('.pane-thread')).display !== 'none',
          backW: r.width, backH: r.height, backShown: getComputedStyle(back).display !== 'none', sendW: send.width, sendH: send.height, view: document.getElementById('app').dataset.view };
      });
      let backOk = true;
      if (w < 769) { await b.page.click('#backBtn'); backOk = (await b.page.evaluate(() => document.getElementById('app').dataset.view)) === 'list' && (await b.page.evaluate(() => getComputedStyle(document.querySelector('.pane-list')).display !== 'none')); }
      const phone = w < 769;
      const ok = m.sw <= m.iw && m.bsw <= m.iw && t.sw <= t.iw && m.chipH >= 44 && m.rowH >= 72 && t.sendW >= 44 && t.sendH >= 44 &&
        (phone ? (m.list && !m.thread && !t.list && t.thread && t.backShown && t.backW >= 44 && t.backH >= 44 && backOk) : (m.list && m.thread && t.list && t.thread && !t.backShown));
      ck('B7 ' + w + 'px: no horizontal overflow; chips ≥44px; rows ≥72px; ' + (phone ? 'one pane at a time, thread opens with a ≥44px back button that returns to the list' : 'both panes, no back button'), ok, { m, t, backOk });
      await b.ctx.close();
    }

    /* ── legacy ?with= ── */
    b = await open('ready', 390, '/messages.html?with=en_123&name=Provider%20X&type=customer-provider');
    await waitState(b.page, 'ready');
    const notice = await b.page.$eval('#notice', (e) => ({ hidden: e.hidden, text: e.textContent }));
    ck('B8 legacy ?with= arrival shows the honest notice (conversations start from a transaction) and still lists the inbox', !notice.hidden && /Provider X/.test(notice.text) && /order, a booking or an enquiry/.test(notice.text) && (await rows(b.page)).length === expectedRows, notice);
    await b.ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
}
