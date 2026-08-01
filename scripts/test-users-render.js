#!/usr/bin/env node
/* ============================================================================
   Users pane — render contract
   ============================================================================
   Lifts the Users pipeline verbatim out of admin.html and runs it against a stub
   DOM, using the SHAPES THAT ACTUALLY EXIST in production. Measured 2026-08-01
   over 61 documents:

       roles[] on 59 · role string on 8 · NEITHER on 2
       city 0% · joined 0% · suspended 0% · verified 2% · phone 5% (phoneNumber 75%)

   Those two role-less documents are the point. A filter that reads only roles[]
   hides eight real accounts; one that reads only `role` hides fifty-nine. And a
   renderer that reads u.phone shows "no phone" for three quarters of the
   directory while phoneNumber sits right there.

   Usage:  node scripts/test-users-render.js
   Exit:   0 all pass · 1 any failure
   ========================================================================= */

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.resolve(__dirname, '..');
const src  = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');

let pass = 0, fail = 0;
const ok  = (n, d) => { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d) => { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const check = (c, n, d) => { c ? ok(n, d) : bad(n, d); return !!c; };

const a = src.indexOf('var _usersAll     = [];');
const b = src.indexOf('function _usersRenderPager(');
const c = src.indexOf('function usersGoPage(');
if (a === -1 || b === -1 || c === -1) {
  console.error('Could not lift the Users pipeline from admin.html — markers moved.');
  process.exit(1);
}
/* Everything from the state vars to the end of the pager helper, plus goPage. */
const block = src.slice(a, src.indexOf('\n', c + 60));

function ctxFor(users, opts = {}) {
  const els = {
    usersBody:  { innerHTML: '' },
    usersCount: { textContent: '' },
    usersPager: { innerHTML: '' },
    userSearch: { value: opts.q || '' },
    userRoleFilter: { value: opts.role || '' },
    userStatusFilter: { value: opts.status || '' },
  };
  const logs = { info: [], warn: [], error: [] };
  const ctx = {
    document: { getElementById: id => els[id] || null },
    console: { info: (...x) => logs.info.push(x), warn: (...x) => logs.warn.push(x),
               error: (...x) => logs.error.push(x), log: () => {} },
    h: s => String(s).replace(/[&<>"']/g, ch =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])),
    D: {},
    Math, Date, Array, String, Number, JSON, isNaN, parseInt,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(block, ctx, { filename: 'admin.html:users' });
  ctx._usersAll = users;
  ctx._usersLoaded = opts.loaded !== false;
  ctx._usersError = opts.error || null;
  ctx._usersPage = opts.page || 0;
  return { ctx, els, logs };
}

/* Real production shapes. */
const U_ROLES   = { uid: 'u1', name: 'Kariuki', email: 'k@x.com', phoneNumber: '+254700000001',
                    roles: ['buyer', 'seller'], status: 'active', createdAt: '2026-07-01T00:00:00Z' };
const U_STRING  = { uid: 'u2', name: 'Wanjiru', email: 'w@x.com', role: 'provider',
                    status: 'active', createdAt: '2026-06-01T00:00:00Z' };
const U_NOROLE  = { uid: 'u3', name: 'Otieno', email: 'o@x.com', createdAt: '2026-05-01T00:00:00Z' };
const U_BARE    = { uid: 'u4' };                       /* no name, email, phone, role, date */

console.log('\nUsers render contract');
console.log('─────────────────────');

/* 1 ── loading is not empty */
{
  const { ctx, els } = ctxFor([], { loaded: false });
  ctx.renderUsers();
  check(/Loading users…/.test(els.usersBody.innerHTML), 'loading state renders');
  check(!/No users found/.test(els.usersBody.innerHTML),
    'loading is not reported as empty', 'the two used to be indistinguishable');
  check(els.usersCount.textContent === '…', 'count shows … while loading');
}

/* 2 ── error is not empty, and offers retry */
{
  const { ctx, els } = ctxFor([], { error: 'permission-denied' });
  ctx.renderUsers();
  check(/Could not load users/.test(els.usersBody.innerHTML), 'error state renders');
  check(/not an empty directory/.test(els.usersBody.innerHTML), 'error is distinguished from empty');
  check(/usersRetry\(\)/.test(els.usersBody.innerHTML), 'retry control is offered');
}

/* 3 ── genuinely empty vs filtered-to-nothing */
{
  const e1 = ctxFor([]);        e1.ctx.renderUsers();
  check(/No users found\./.test(e1.els.usersBody.innerHTML), 'empty directory says so');
  const e2 = ctxFor([U_ROLES], { q: 'zzzzz' }); e2.ctx.renderUsers();
  check(/No users match this filter\./.test(e2.els.usersBody.innerHTML),
    'no-match is worded differently from empty', 'an admin can tell which it is');
}

/* 4 ── role filter spans BOTH storage shapes */
{
  const all = [U_ROLES, U_STRING, U_NOROLE];
  const seller = ctxFor(all, { role: 'seller' });   seller.ctx.renderUsers();
  check(seller.els.usersCount.textContent === 1, 'roles[] is matched', `count=${seller.els.usersCount.textContent}`);
  const prov = ctxFor(all, { role: 'provider' });   prov.ctx.renderUsers();
  check(prov.els.usersCount.textContent === 1, 'role string is matched',
    `count=${prov.els.usersCount.textContent} — 8 production docs use this shape`);
  const none = ctxFor(all, {});                     none.ctx.renderUsers();
  check(none.els.usersCount.textContent === 3, 'a role-less user still appears unfiltered',
    'two production documents carry neither field');
  check(/no role set/.test(none.els.usersBody.innerHTML),
    'a role-less user is labelled, not blank');
}

/* 5 ── phoneNumber is the real field */
{
  const { ctx, els } = ctxFor([U_ROLES]);
  ctx.renderUsers();
  check(/\+254700000001/.test(els.usersBody.innerHTML),
    'phoneNumber is rendered', 'u.phone covers only 5% of documents');
  const q = ctxFor([U_ROLES], { q: '254700000001' }); q.ctx.renderUsers();
  check(q.els.usersCount.textContent === 1, 'search matches on phoneNumber');
}

/* 6 ── absent fields are labelled, never invented */
{
  const { ctx, els } = ctxFor([U_BARE]);
  ctx.renderUsers();
  const html = els.usersBody.innerHTML;
  check(/unnamed/.test(html), 'a missing name is labelled "unnamed"');
  check(/no phone/.test(html), 'a missing phone is labelled');
  check(/—/.test(html), 'absent city and date render as an explicit dash');
  check(!/undefined|null|NaN/.test(html), 'no undefined/null/NaN leaks into the table');
}

/* 7 ── search covers name, email, uid */
{
  const all = [U_ROLES, U_STRING];
  for (const [q, expect, what] of [['kariuki', 1, 'name'], ['w@x.com', 1, 'email'], ['u1', 1, 'uid']]) {
    const r = ctxFor(all, { q }); r.ctx.renderUsers();
    check(r.els.usersCount.textContent === expect, `search matches on ${what}`,
      `"${q}" -> ${r.els.usersCount.textContent}`);
  }
}

/* 8 ── status filter */
{
  const all = [U_ROLES, U_STRING, U_NOROLE];
  const r = ctxFor(all, { status: 'active' }); r.ctx.renderUsers();
  check(r.els.usersCount.textContent === 2, 'status filter uses the status field',
    `count=${r.els.usersCount.textContent}`);
}

/* 9 ── pagination */
{
  const many = Array.from({ length: 120 }, (_, i) =>
    ({ uid: 'p' + i, name: 'User ' + i, email: i + '@x.com', roles: ['buyer'], createdAt: '2026-07-01T00:00:00Z' }));
  const r = ctxFor(many);
  r.ctx.renderUsers();
  const rows = (r.els.usersBody.innerHTML.match(/<tr>/g) || []).length;
  check(rows === 50, 'first page holds 50 rows', `${rows}`);
  check(r.els.usersCount.textContent === 120, 'the count reports the full match, not the page');
  check(/Page 1 of 3/.test(r.els.usersPager.innerHTML), 'pager reports 3 pages',
    r.els.usersPager.innerHTML.replace(/<[^>]+>/g, ' ').trim().slice(0, 40));
  r.ctx.usersGoPage(2);
  check(/Page 3 of 3/.test(r.els.usersPager.innerHTML), 'paging forward works');
  const last = (r.els.usersBody.innerHTML.match(/<tr>/g) || []).length;
  check(last === 20, 'last page holds the remainder', `${last}`);
}

/* 10 ── newest first, and an undated user is not dropped */
{
  const r = ctxFor([U_NOROLE, U_ROLES, U_BARE]);
  r.ctx.renderUsers();
  const html = r.els.usersBody.innerHTML;
  check(html.indexOf('u1') < html.indexOf('u3'), 'newest sorts first');
  check(/u4/.test(html), 'a user with no createdAt still appears',
    'server-side orderBy would have dropped it');
  check(r.els.usersCount.textContent === 3, 'all three are counted');
}

/* 11 ── one bad record cannot take the table down */
{
  const bomb = { uid: 'bad', get roles() { throw new Error('corrupt roles'); } };
  const r = ctxFor([U_ROLES, bomb, U_STRING]);
  r.ctx.renderUsers();
  const html = r.els.usersBody.innerHTML;
  check(/Kariuki/.test(html) && /Wanjiru/.test(html), 'healthy rows still render');
  check(/could not be displayed/.test(html), 'the bad row is shown as a visible failure');
  check(r.logs.error.length === 1, 'the failure is logged once');
}

/* 12 ── diagnostics */
{
  const r = ctxFor([U_ROLES, U_STRING]);
  r.ctx.renderUsers();
  const d = r.logs.info.find(x => x[0] === '[Admin][users]');
  check(!!d, 'diagnostics emitted');
  if (d) {
    check(d[1].collection === 'users' && d[1].source === 'firestore',
      'diagnostics name the canonical source', `${d[1].collection}/${d[1].source}`);
    check(d[1].documents === 2 && d[1].matching === 2, 'documents and matching counts');
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
