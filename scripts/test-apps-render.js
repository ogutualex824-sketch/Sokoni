#!/usr/bin/env node
/* ============================================================================
   Applications panel — render contract
   ============================================================================
   Lifts renderApps and its helpers verbatim out of admin.html and runs them
   against a stub DOM. Testing the shipped source rather than a copy is the
   point: a test that passes against a reimplementation proves nothing about the
   page that is actually served.

   Three rules, each of which was broken in production on 2026-08-01:

     1. Every applications container is rendered. #bizAppsGrid was declared once
        by the markup and written to by nothing, so the Business → Applications
        tab was an empty box while four applications sat in Firestore.
     2. A blank area is never a valid outcome — empty says "No applications
        found.", failure says it failed.
     3. One malformed document cannot abort the batch. The old code built the
        whole list inside a single .map(); a throw on record 3 meant records
        1, 2, 4 and 5 never reached the DOM either.

   Usage:  node scripts/test-apps-render.js
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

/* ── Lift the real functions ──────────────────────────────────────────────── */
function slice(from, to) {
  const a = src.indexOf(from);
  if (a === -1) return null;
  const b = src.indexOf(to, a);
  if (b === -1) return null;
  return src.slice(a, b);
}

const block = slice('var _APPS_TARGETS =', 'function _renderAppCard(');
if (!block) {
  console.error('Could not lift renderApps from admin.html — markers moved.');
  process.exit(1);
}

/* ── Stub DOM ─────────────────────────────────────────────────────────────── */
function makeCtx(targets) {
  const els = {};
  for (const id of targets) els[id] = { id, innerHTML: '', style: {}, textContent: '' };
  const logs = { info: [], warn: [], error: [] };
  const ctx = {
    document: { getElementById: id => els[id] || null },
    console: {
      info:  (...a) => logs.info.push(a),
      warn:  (...a) => logs.warn.push(a),
      error: (...a) => logs.error.push(a),
      log:   () => {},
    },
    /* admin.html helpers the lifted code calls */
    h: s => String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    empty: (icon, msg) => `<div class="empty">${icon} ${msg}</div>`,
    /* The card renderer is stubbed so this test targets the NEW batching and
       isolation logic; the card body itself is unchanged from before the fix. */
    _renderAppCard: (a) => {
      if (a && a.__explode) throw new Error('bad record: ' + (a.__explode));
      return `<div class="adm-card">${a && a.name ? a.name : '?'}</div>`;
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(block, ctx, { filename: 'admin.html:renderApps' });
  return { ctx, els, logs };
}

const BOTH = ['appsGrid', 'bizAppsGrid', 'biz-app-count'];

console.log('\nApplications render contract');
console.log('────────────────────────────');

/* 1 ── every container is rendered, not just the desktop one */
{
  const { ctx, els } = makeCtx(BOTH);
  ctx.renderApps([{ name: 'Kasindi holdings limited', status: 'approved' },
                  { name: 'Hometown Movers kenya',    status: 'pending' }]);
  check(/Kasindi/.test(els.appsGrid.innerHTML),    'desktop #appsGrid is rendered');
  check(/Kasindi/.test(els.bizAppsGrid.innerHTML), 'mobile #bizAppsGrid is rendered',
    'this is the container that was blank in production');
  check(els.appsGrid.innerHTML === els.bizAppsGrid.innerHTML,
    'both containers show the same list');
  check(els['biz-app-count'].textContent === 1,
    'the pending badge is populated', `got ${JSON.stringify(els['biz-app-count'].textContent)}`);
}

/* 2 ── empty is stated, never left blank */
{
  const { ctx, els } = makeCtx(BOTH);
  ctx.renderApps([]);
  check(/No applications found\./.test(els.appsGrid.innerHTML),
    'empty says "No applications found."', 'not a blank box');
  check(/No applications found\./.test(els.bizAppsGrid.innerHTML),
    'the empty state reaches every container');
  check(els['biz-app-count'].style.display === 'none', 'the badge hides at zero');
}

/* 3 ── a non-array argument must not blank the panel either */
{
  const { ctx, els } = makeCtx(BOTH);
  let threw = null;
  try { ctx.renderApps(undefined); } catch (e) { threw = e; }
  check(!threw, 'renderApps(undefined) does not throw', threw ? threw.message : '');
  check(/No applications found\./.test(els.appsGrid.innerHTML),
    'renderApps(undefined) shows the empty state');
}

/* 4 ── one bad record cannot take the batch down */
{
  const { ctx, els, logs } = makeCtx(BOTH);
  ctx.renderApps([
    { name: 'Good one' },
    { __explode: 'missing role' },
    { name: 'Good two' },
    { name: 'Good three' },
  ]);
  const html = els.appsGrid.innerHTML;
  check(/Good one/.test(html) && /Good two/.test(html) && /Good three/.test(html),
    'the three healthy records still render', 'a throw no longer aborts the batch');
  check(/could not be displayed/.test(html),
    'the malformed record is shown as a visible failure', 'not silently dropped');
  check(logs.error.length === 1, 'the failure is logged once with its id',
    `${logs.error.length} error log(s)`);
}

/* 5 ── failure is reported, and is distinguishable from empty */
{
  const { ctx, els } = makeCtx(BOTH);
  ctx.renderAppsError('permission-denied');
  check(/Could not load applications/.test(els.appsGrid.innerHTML),
    'a load failure is stated');
  check(/not an empty queue/.test(els.appsGrid.innerHTML),
    'the failure is distinguished from "nobody has applied"',
    'the two used to look identical');
  check(!/No applications found\./.test(els.appsGrid.innerHTML),
    'a failure never renders as an empty queue');
}

/* 6 ── the loading state is written, so it can be seen to resolve */
{
  const { ctx, els } = makeCtx(BOTH);
  ctx.renderAppsLoading();
  check(/Loading applications/.test(els.bizAppsGrid.innerHTML),
    'the loading state reaches every container');
  ctx.renderApps([{ name: 'Arrived' }]);
  check(!/Loading applications/.test(els.bizAppsGrid.innerHTML),
    'the loading state resolves', 'a spinner that never resolves is the same bug');
}

/* 7 ── a missing container is reported, not silently skipped */
{
  const { ctx, logs } = makeCtx([]);            /* no targets in the DOM at all */
  let threw = null;
  try { ctx.renderApps([{ name: 'x' }]); } catch (e) { threw = e; }
  check(!threw, 'a missing container does not throw');
  check(logs.warn.length === 1, 'a missing container is warned about',
    'the old code returned silently, which is how #bizAppsGrid stayed invisible');
}

/* 8 ── diagnostics */
{
  const { ctx, logs } = makeCtx(BOTH);
  ctx.renderApps([{ name: 'a', status: 'pending' }, { name: 'b', status: 'approved' }]);
  const d = logs.info.find(a => a[0] === '[Admin][applications]');
  check(!!d, 'a diagnostics line is emitted');
  if (d) {
    const o = d[1];
    check(o.documents === 2 && o.pending === 1, 'documents and pending counts',
      `documents=${o.documents} pending=${o.pending}`);
    check(o.collection === 'applications' && /createdAt/.test(o.ordering),
      'active collection and ordering', `${o.collection} / ${o.ordering}`);
    check('listenerAttached' in o && 'listenerUpdates' in o,
      'listener state is reported');
    check(/appsGrid/.test(o.targets) && /bizAppsGrid/.test(o.targets),
      'render targets are reported', o.targets);
  }
  const r = logs.info.find(a => a[0] === '[Admin][applications] rendered');
  check(!!r && r[1].rendered === 2 && r[1].failed === 0, 'render count is reported');
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
