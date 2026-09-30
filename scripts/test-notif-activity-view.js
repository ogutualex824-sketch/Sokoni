#!/usr/bin/env node
/**
 * test-notif-activity-view.js — executes sokoni-notif-engine.js in a stub
 * browser and proves the ⚡ Activity view (2026-09-30):
 *   - getAll({category:'activity'}) returns ONLY ACTIVITY_CATEGORIES items, read or unread
 *   - unread counts carry an `activity` aggregate
 *   - markAllRead('activity') / ('unread') / ('important') act on the virtual tab
 *     (before: they matched n.category === 'unread' and did nothing)
 *   - dayLabel() yields Today / Yesterday / a weekday-date
 *   - the bell panel and notifications.html both declare the Activity tab
 *
 * Run: node scripts/test-notif-activity-view.js   (exit 1 on any failure)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  FAIL ' + msg); } }

/* ── stub browser ── */
const store = {};
const window = {
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  document: { readyState: 'loading', addEventListener() {}, hidden: false },
  addEventListener() {}, setTimeout, clearTimeout, Date, JSON, Math, Object, Array, String, Number, Promise, console,
};
window.window = window;
const ctx = vm.createContext(window);
ctx.localStorage = window.localStorage; ctx.document = window.document;
vm.runInContext(fs.readFileSync(path.join(ROOT, 'sokoni-notif-engine.js'), 'utf8'), ctx, { filename: 'sokoni-notif-engine.js' });
const eng = ctx.SokoniNotifEngine;
ok(!!eng, 'engine loads in a stub window');

/* ── seed the cache through the public seam the Firestore listener uses ── */
const now = Date.now();
const mk = (id, category, extra) => Object.assign({
  id, category, priority: 'normal', type: 'generic', title: id, body: '', icon: '', actionUrl: '',
  groupKey: id, actions: [], read: false, archived: false, pinned: false, createdAt: now, metadata: {},
}, extra || {});
const updates = [];
eng._update = (id, u) => { updates.push([id, u]); return Promise.resolve(); };
const seed = [
  mk('o1', 'orders'),
  mk('p1', 'payments', { read: true }),
  mk('d1', 'deliveries', { createdAt: now - 86400000 }),
  mk('s1', 'security', { priority: 'high' }),
  mk('m1', 'messages'),
  mk('x1', 'system', { archived: true }),
  mk('b1', 'business', { createdAt: now - 3 * 86400000 }),
];
/* _onSnapshot is private. Re-evaluate the engine with it exported on the test
   seam only, then replay a fake snapshot through it — the same path prod uses. */
const src = fs.readFileSync(path.join(ROOT, 'sokoni-notif-engine.js'), 'utf8');
ok(/function _onSnapshot\(snap\)/.test(src), '_onSnapshot exists to replay through');
vm.runInContext(
  src.replace('  global.SokoniNotifEngine = SokoniNotifEngine;',
              '  SokoniNotifEngine._onSnapshotForTest = _onSnapshot;\n  global.SokoniNotifEngine = SokoniNotifEngine;'),
  ctx, { filename: 'sokoni-notif-engine.patched.js' });
ctx.SokoniNotifEngine._update = eng._update;
ctx.SokoniNotifEngine._onSnapshotForTest({ forEach: fn => seed.forEach(n => fn({ id: n.id, data: () => Object.assign({}, n) })) });
const E = ctx.SokoniNotifEngine;

/* ── ACTIVITY_CATEGORIES + CATEGORIES ── */
ok(Array.isArray(E.ACTIVITY_CATEGORIES) && E.ACTIVITY_CATEGORIES.indexOf('orders') !== -1, 'ACTIVITY_CATEGORIES exported and includes orders');
ok(E.CATEGORIES.activity && E.CATEGORIES.activity.icon === '⚡', 'CATEGORIES.activity is ⚡');
ok(E.PANEL_CATEGORIES.indexOf('activity') === 3, 'Activity tab sits after Important in the bell panel');
ok(E.PREF_CATEGORIES.indexOf('activity') === -1, 'Activity is a VIEW, not a preference toggle (no duplicate pref row)');

/* ── getAll activity ── */
const act = E.getAll({ category: 'activity', grouped: false }).map(n => n.id).sort();
ok(JSON.stringify(act) === JSON.stringify(['b1', 'd1', 'o1', 'p1']), 'activity = orders+payments+deliveries+business, read included, archived/security/messages excluded (got ' + act + ')');
const unread = E.getAll({ category: 'unread', grouped: false }).map(n => n.id).sort();
ok(JSON.stringify(unread) === JSON.stringify(['b1', 'd1', 'm1', 'o1', 's1']), 'unread view unchanged by the refactor (got ' + unread + ')');
const imp = E.getAll({ category: 'important', grouped: false }).map(n => n.id);
ok(JSON.stringify(imp) === JSON.stringify(['s1']), 'important view unchanged (got ' + imp + ')');
const ord = E.getAll({ category: 'orders', grouped: false }).map(n => n.id);
ok(JSON.stringify(ord) === JSON.stringify(['o1']), 'stored-category view unchanged (got ' + ord + ')');

/* ── counts ── */
const c = E.getUnreadCounts();
ok(c.activity === 3, 'counts.activity = 3 unread activity items (got ' + c.activity + ')');
ok(c.all === 5 && c.important === 1, 'all/important counts unchanged');

/* ── markAllRead on virtual tabs ── */
async function run() {
  updates.length = 0; await E.markAllRead('activity');
  const ids = updates.map(u => u[0]).sort();
  ok(JSON.stringify(ids) === JSON.stringify(['b1', 'd1', 'o1']), 'markAllRead(activity) marks exactly the unread activity items (got ' + ids + ')');
  updates.length = 0; await E.markAllRead('important');
  ok(updates.length === 1 && updates[0][0] === 's1', 'markAllRead(important) now works (was a no-op)');
  updates.length = 0; await E.markAllRead('unread');
  ok(updates.length === 5, 'markAllRead(unread) now works (was a no-op), got ' + updates.length);
  updates.length = 0; await E.markAllRead('orders');
  ok(updates.length === 1 && updates[0][0] === 'o1', 'markAllRead(stored category) unchanged');

  /* ── dayLabel ── */
  ok(E.dayLabel(now) === 'Today', 'dayLabel today');
  ok(E.dayLabel(now - 86400000) === 'Yesterday', 'dayLabel yesterday');
  ok(/^[A-Z][a-z]+day/.test(E.dayLabel(now - 3 * 86400000)), 'dayLabel older = weekday date (' + E.dayLabel(now - 3 * 86400000) + ')');

  /* ── surfaces declare the tab, once each ── */
  const center = fs.readFileSync(path.join(ROOT, 'sokoni-notif-center.js'), 'utf8');
  ok(/_activeTab === 'activity'/.test(center) && /eng\.dayLabel\(/.test(center), 'bell panel renders Activity as a day-grouped timeline via engine.dayLabel');
  ok((center.match(/\.sk-nc-day\{/g) || []).length === 1, 'one divider style in the panel');
  const page = fs.readFileSync(path.join(ROOT, 'notifications.html'), 'utf8');
  ok((page.match(/data-cat="activity"/g) || []).length === 2, 'notifications.html: sidebar + mobile tab, exactly once each');
  ok(/URLSearchParams\(window\.location\.search\)\.get\('tab'\)/.test(page), 'notifications.html honours ?tab= (the URL the old ⚡ button used)');
  ok(!/if \(d >= today\)\s*\{ label = 'Today'/.test(page), 'page no longer carries its own day-label copy (uses engine.dayLabel)');
  ok(/'activity','orders'/.test(page), 'page badge list includes activity');
  const header = fs.readFileSync(path.join(ROOT, 'shared-header.js'), 'utf8');
  ok(!/sk-activity-btn/.test(header), 'header no longer has the ⚡ button (feature lives in the bell, not duplicated)');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(1); });
