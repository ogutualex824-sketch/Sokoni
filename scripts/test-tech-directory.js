#!/usr/bin/env node
/* test-tech-directory.js — Tech Hub slice 1: real providers, canonical booking, in-app chat, no fabrication
 *
 *   node scripts/test-tech-directory.js
 *
 * EXECUTES sokoni-tech-directory.js in a sandbox with a stub DOM and stub SokoniProviders / SokoniBookService /
 * SokoniInbox, then checks phone-repair.html and electrical.html statically. Each behaviour check has a sabotage.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const MOD = fs.readFileSync(path.join(ROOT, 'sokoni-tech-directory.js'), 'utf8');

function sandbox(modSrc, listResult) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '', __listeners: {}, addEventListener(t, f) { this.__listeners[t] = f; } });
  const calls = { list: [], book: [], chat: [] };
  const win = {
    firebaseDB: {},
    SokoniProviders: { list: async (o) => { calls.list.push(o); return listResult; } },
    SokoniBookService: { open: (o) => calls.book.push(o) },
    SokoniInbox: { openChat: (o) => calls.chat.push(o) },
  };
  const ctx = { window: win, document: { getElementById: el }, setTimeout, Promise, console, location: { href: '' } };
  ctx.globalThis = ctx; Object.assign(ctx, win); win.window = win;
  vm.createContext(ctx); vm.runInContext(modSrc, ctx);
  return { ctx, els, calls, api: win.SokoniTechDirectory };
}
const P = (o) => Object.assign({ uid: 'u1', name: 'Fix Ltd', categoryLabel: 'Phone Repair', category: 'phone-repair', categories: ['phone-repair'], location: 'Nairobi', city: 'Nairobi', description: 'Screens and batteries', skills: ['iPhone', 'Samsung'], rating: null, reviewCount: 0, jobsCompleted: 0, rate: null, rateType: '', photo: '', verified: false, acceptsBookings: true, chatEnabled: true, emoji: '📱', profileUrl: 'provider-profile.html?uid=u1' }, o);
const CFG = { grid: 'g', count: 'c', category: 'phone-repair', prefix: 'pg', noun: 'technician', applyUrl: 'business-apply.html?offer=services&category=phone-repair' };

async function behaviour(modSrc) {
  const r = {};
  /* list with two providers: one with real rating + jobs, one new; one hostile name */
  {
    const s = sandbox(modSrc, { providers: [P({ uid: 'a', name: 'Pro <b>A</b>', rating: 4.6, reviewCount: 12, jobsCompleted: 40, verified: true }), P({ uid: 'b', name: 'Newbie', location: 'Mombasa', skills: ['Tecno'] })], error: null });
    await s.api.mount(Object.assign({}, CFG, { search: () => '', type: () => '', location: () => '' }));
    const h = s.els.g.innerHTML;
    r.T1 = s.calls.list.length === 1 && s.calls.list[0].category === 'phone-repair' && /data-uid="a"/.test(h) && /data-uid="b"/.test(h) && /2 technicians/.test(s.els.c.textContent);
    r.T2 = /4\.6 · 12 reviews/.test(h) && /40 jobs/.test(h) && /New on SOKONI/.test(h) && !/[^0-9]0 jobs/.test(h) && (h.match(/✓ Verified/g) || []).length === 1;
    r.T3 = !/<b>A<\/b>/.test(h) && /Pro &lt;b&gt;A&lt;\/b&gt;/.test(h);
    /* actions */
    s.els.g.__listeners.click({ target: { closest: () => ({ getAttribute: (k) => (k === 'data-tech-act' ? 'book' : 'a') }) } });
    s.els.g.__listeners.click({ target: { closest: () => ({ getAttribute: (k) => (k === 'data-tech-act' ? 'chat' : 'b') }) } });
    r.T6 = s.calls.book.length === 1 && s.calls.book[0].providerId === 'a' && s.calls.chat.length === 1 && s.calls.chat[0].otherUid === 'b';
    /* filters */
    const s2 = sandbox(modSrc, { providers: [P({ uid: 'a', location: 'Nairobi', skills: ['iPhone'] }), P({ uid: 'b', location: 'Mombasa', skills: ['Tecno'] })], error: null });
    await s2.api.mount(Object.assign({}, CFG, { search: () => '', type: () => 'tecno', location: () => 'mombasa' }));
    r.T7 = /data-uid="b"/.test(s2.els.g.innerHTML) && !/data-uid="a"/.test(s2.els.g.innerHTML);
  }
  /* unreachable registry is NOT an empty list */
  {
    const s = sandbox(modSrc, { providers: [], error: new Error('unavailable') });
    await s.api.mount(Object.assign({}, CFG));
    r.T4 = /not an empty list/.test(s.els.g.innerHTML) && !/No approved/.test(s.els.g.innerHTML);
  }
  /* a real, server-confirmed empty registry invites applications */
  {
    const s = sandbox(modSrc, { providers: [], error: null });
    await s.api.mount(Object.assign({}, CFG));
    r.T5 = /No approved technicians are listed here yet/.test(s.els.g.innerHTML) && /business-apply\.html\?offer=services&amp;category=phone-repair|business-apply\.html\?offer=services&category=phone-repair/.test(s.els.g.innerHTML);
  }
  return r;
}

function pages(read) {
  const out = {};
  for (const [f, cat] of [['phone-repair.html', 'phone-repair'], ['electrical.html', 'electrical']]) {
    const s = read(f);
    out[f] = {
      noArray: !/const PROVIDERS ?= ?\[/.test(s),
      noWhatsApp: !/wa\.me|waConnect\(/.test(s),
      noFakeInvoice: !/SokoniInvoice\.generate\(/.test(s),
      noFakeReviews: !/class="pg-reviews"/.test(s),
      register: s.includes(`business-apply.html?offer=services&category=${cat}`) && !/HubRegister\.open\(/.test(s),
      modules: ['firebase.js', 'sokoni-providers.js', 'sokoni-book-service.js', 'sokoni-inbox.js', 'sokoni-tech-directory.js'].every((m) => s.includes(`src="${m}"`)),
      mounted: new RegExp("category: '" + cat + "'").test(s) && /SokoniTechDirectory\.mount\(_TECH\)/.test(s),
    };
  }
  return out;
}

(async () => {
  let pass = 0, fail = 0, caught = 0;
  const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
  console.log('\nTECH DIRECTORY — slice 1\n');
  const LABELS = { T1: 'lists approved providers from the registry by category', T2: 'ratings / jobs only when real; "New on SOKONI" otherwise; verified only from the record', T3: 'provider text is escaped', T4: 'an unreachable registry is NOT shown as an empty list', T5: 'a real empty registry invites applications (business-apply)', T6: 'Book → SokoniBookService.open(providerId); Message → in-app chat', T7: 'search / type / location filters' };
  const b = await behaviour(MOD);
  for (const k of Object.keys(LABELS)) ck(k + '  ' + LABELS[k], b[k] === true);
  const pg = pages((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
  for (const f of Object.keys(pg)) for (const [k, v] of Object.entries(pg[f])) ck('P   ' + f + ': ' + k, v);

  console.log('\n  [sabotage]');
  const SAB = {
    T2: MOD.replace("'<span class=\"' + x + '-prov-rnum\">New on SOKONI</span>'", "'<span class=\"' + x + '-prov-rnum\">4.9 · 0 jobs</span>'"),
    T3: MOD.replace("+ esc(p.name) + '</a>'", "+ p.name + '</a>'"),
    T4: MOD.replace("if (r.error && !all.length) {", "if (false) {"),
    T6: MOD.replace("G.SokoniBookService.open({ providerId: p.uid, providerName: p.name });", "location.href = 'https://wa.me/254700000000';"),
  };
  for (const [k, src] of Object.entries(SAB)) {
    if (src === MOD) { ck('sabotage ' + k + ' anchor missing', false); continue; }
    const rb = await behaviour(src);
    const red = rb[k] !== true;
    console.log('  ' + (red ? 'CAUGHT' : 'MISSED') + '  ' + k); red ? caught++ : fail++;
  }
  const pageSab = pages((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace('<script>\n/* 2026-10-03 (Tech Hub', '<script>\nconst PROVIDERS=[{id:"X"}];\n/* 2026-10-03 (Tech Hub').replace('<script>\r\n/* 2026-10-03 (Tech Hub', '<script>\r\nconst PROVIDERS=[{id:"X"}];\r\n/* 2026-10-03 (Tech Hub'));
  const redP = !pageSab['phone-repair.html'].noArray;
  console.log('  ' + (redP ? 'CAUGHT' : 'MISSED') + '  P noArray'); redP ? caught++ : fail++;
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + caught + '/5 sabotages caught');
  console.log('  NOT proven here: a real browser render and a real booking (needs a browser run and an approved provider with services).\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
