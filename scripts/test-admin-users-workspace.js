#!/usr/bin/env node
'use strict';
require('./lib/net-firewall').install();
/* Users workspace (sokoni-admin-users.js + admin-os.js additions) — server truth, no fabricated figures
     U1  adminUserStats: total / active / suspended / joinedLast30 are server count() aggregates; suspended combines
         status 'suspended'|'banned' with suspended:true WITHOUT double counting; active excludes flagged accounts
     U2  adminUserStats refuses a non-admin
     U3  adminSearchUsers: lastSignIn comes from Firebase Auth (not a client presence field), plus suspended / team /
         photo (https only) / scanned; an Auth failure leaves lastSignIn null ("—"), never a guess
     U4  adminGetUser: mfaEnrolled + tokensValidAfter straight from the Auth record
     U5  client module: status / access derive from server fields (suspended flag wins; unknown role → its own label)
     U6  client module: every template interpolation of user-controlled data goes through esc() (or a helper that does)
     U7  client module: no fabricated metric — KPI/count sources are only adminUserStats / listInvitations; unknown → "—"
     U9-U12 SERVER pagination (cursor) · server role/status filters · server sort · export (super admin, displayed columns, filtered, audited)
     U13 live-only audit.read capability pilot carried (explicit false denies) · U14 adminGetUser returns the wallet (live)
     U8  both pages mount the workspace in their Users panel (sidebars untouched) with THEIR existing action authorities
   NODE_PATH=<functions/node_modules> node scripts/test-admin-users-workspace.js */
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 260) + ']')); ok ? pass++ : fail++; };

/* ── fake Firestore with count() / select() / in / equality filters ── */
const DOCS = new Map(); let AUTO_ID = 0;
function q(coll, filters, sel, ord, lim, after) {
  const rows = () => [...DOCS.entries()].filter(([k]) => k.startsWith(coll + '/') && k.split('/').length === 2).map(([k, v]) => ({ id: k.split('/')[1], v }))
    .filter(({ v }) => filters.every(([f, op, val]) => op === '==' ? v[f] === val : op === 'in' ? val.includes(v[f]) : op === '>=' ? (v[f] && v[f]._ms >= val._ms) : true));
  return {
    where: (f, op, val) => q(coll, filters.concat([[f, op, val]]), sel, ord, lim, after),
    select: () => q(coll, filters, true, ord, lim, after), limit: (n) => q(coll, filters, sel, ord, n, after),
    orderBy: (f, dir) => q(coll, filters, sel, [f, dir || 'asc'], lim, after), startAfter: (snap) => q(coll, filters, sel, ord, lim, snap.id),
    startAt: () => q(coll, filters, sel, ord, lim, after), endAt: () => q(coll, filters, sel, ord, lim, after),
    count: () => ({ get: async () => ({ data: () => ({ count: rows().length }) }) }),
    get: async () => { let r = rows();
      if (ord) r.sort((x, y) => { const a = x.v[ord[0]], b = y.v[ord[0]]; const av = a && a._ms != null ? a._ms : a, bv = b && b._ms != null ? b._ms : b; return (av > bv ? 1 : av < bv ? -1 : 0) * (ord[1] === 'desc' ? -1 : 1); });
      if (after) { const i = r.findIndex((x) => x.id === after); r = r.slice(i + 1); }
      if (lim) r = r.slice(0, lim);
      return { size: r.length, empty: !r.length, docs: r.map(({ id, v }) => ({ id, data: () => JSON.parse(JSON.stringify(v)), exists: true })) }; },
    doc: (id) => ({ id, get: async () => { const v = DOCS.get(coll + '/' + id); return { id, exists: !!v, data: () => v && JSON.parse(JSON.stringify(v)) }; } }),
    add: async (v) => { const id = 'x' + (++AUTO_ID); DOCS.set(coll + '/' + id, v); return { id }; },
  };
}
const db = { collection: (c) => q(c, [], false) };
let AUTH_FAIL = false;
const AUTH = {
  getUsers: async (ids) => { if (AUTH_FAIL) throw new Error('auth down'); return { users: ids.map(({ uid }) => ({ uid, disabled: uid === 'u3', metadata: { lastSignInTime: uid === 'u1' ? 'Sat, 04 Oct 2026 08:00:00 GMT' : null } })) }; },
  getUser: async (uid) => ({ email: uid + '@x.ke', emailVerified: true, disabled: false, metadata: { lastSignInTime: null, creationTime: null }, providerData: [{ providerId: 'google.com' }], multiFactor: { enrolledFactors: [{}, {}] }, tokensValidAfterTime: 'Fri, 03 Oct 2026 10:00:00 GMT' }),
};
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: { serverTimestamp: () => 'ts' }, Timestamp: { fromMillis: (m) => ({ _ms: m }), fromDate: (d) => ({ _ms: +d }) } };
  if (id === 'firebase-admin/auth') return { getAuth: () => AUTH };
  if (id === 'firebase-functions/v2/https') return { onCall: (o, h) => h, HttpsError: class extends Error { constructor (c, m) { super(m); this.code = c; } } };
  return orig.apply(this, arguments);
};
const AO = require(path.join(FN, 'admin-os.js'));
Module.prototype.require = orig;
const ADMIN = { auth: { uid: 'a', token: { admin: true } } };
const now = Date.now(), recent = { _ms: now - 2 * 86400000 }, old = { _ms: now - 90 * 86400000 };

(async () => {
  DOCS.set('users/u1', { displayName: 'Ann', status: 'active', createdAt: recent, role: 'seller', customClaims: { department: 'Ops' }, photoURL: 'https://x/p.png' });
  DOCS.set('users/u2', { displayName: 'Ben', status: 'active', suspended: true, createdAt: old });          /* suspendUser: flag, status untouched */
  DOCS.set('users/u3', { displayName: 'Cy', status: 'banned', createdAt: old });                           /* tsBanUser */
  DOCS.set('users/u4', { displayName: 'Di', status: 'suspended', suspended: true, createdAt: recent });     /* both — counted once */
  DOCS.set('users/u5', { displayName: 'Ed', suspended: true, createdAt: old, photoURL: 'javascript:alert(1)' }); /* flag, no status field */
  DOCS.set('users/u6', { displayName: 'Fe', status: 'active', createdAt: old });
  const st = await AO._h.adminUserStats(ADMIN);
  ck('U1', st.totalUsers === 6 && st.activeUsers === 2 && st.suspendedUsers === 4 && st.joinedLast30 === 2 && st.suspendedExact === true && st.available.totalUsers === true && st.available.pendingInvites === true,
    'stats are server aggregates: total 6, active 2 (u1,u6 — flagged u2 excluded), suspended 4 (u2,u3,u4,u5 — u4 once), joined in 30 days 2', st);
  let refused = false; try { await AO._h.adminUserStats({ auth: { uid: 'x', token: {} } }); } catch (_) { refused = true; }
  ck('U2', refused, 'a non-admin is refused');
  const sr = await AO._h.adminSearchUsers({ ...ADMIN, data: { pageSize: 50 } });
  const u1 = sr.users.find((u) => u.id === 'u1'), u2 = sr.users.find((u) => u.id === 'u2'), u5 = sr.users.find((u) => u.id === 'u5');
  AUTH_FAIL = true; const sr2 = await AO._h.adminSearchUsers({ ...ADMIN, data: { pageSize: 50 } }); AUTH_FAIL = false;
  ck('U3', u1.lastSignIn === Date.parse('Sat, 04 Oct 2026 08:00:00 GMT') && u1.team === 'Ops' && u1.photoURL === 'https://x/p.png' && u2.status === 'suspended' && u5.photoURL === null
    && sr.total === 6 && sr2.users.every((u) => u.lastSignIn === null && u.authAvailable === false),
    'search rows: Auth last sign-in, team claim, https-only photo, suspended flag, scanned; Auth failure → null', { u1, u5, scanned: sr.scanned });
  const gu = await AO._h.adminGetUser({ ...ADMIN, data: { uid: 'u1' } });
  ck('U4', gu.authRecord.mfaEnrolled === 2 && gu.security.twoFactor === 'enabled' && gu.security.signInEnabled === true && Array.isArray(gu.security.suspensionHistory) && !('passwordHash' in gu.authRecord) && !('tokens' in gu.authRecord),
    'adminGetUser: security block from Auth (2FA, sign-in), histories, no secrets', gu.security);
  /* SERVER pagination / filters / sort / export */
  for (let i = 0; i < 25; i++) DOCS.set('users/p' + String(i).padStart(2, '0'), { displayName: 'P' + String(i).padStart(2, '0'), status: i % 5 === 0 ? 'suspended' : 'active', role: i % 2 ? 'seller' : 'buyer', createdAt: { _ms: now - i * 60000 } });
  const pg1 = await AO._h.adminSearchUsers({ ...ADMIN, data: { pageSize: 10 } });
  const pg2 = await AO._h.adminSearchUsers({ ...ADMIN, data: { pageSize: 10, cursor: pg1.nextCursor } });
  const ids = new Set([...pg1.users, ...pg2.users].map((u) => u.id));
  ck('U9', pg1.users.length === 10 && pg2.users.length === 10 && ids.size === 20 && pg1.hasMore && pg1.total === 31,
    'SERVER pagination: 10 per page, cursor gives the next 10 (no overlap), total from the server (not a client list)', { n1: pg1.users.length, n2: pg2.users.length, total: pg1.total });
  const fr = await AO._h.adminSearchUsers({ ...ADMIN, data: { pageSize: 50, role: 'seller', status: 'suspended' } });
  ck('U10', fr.users.length > 0 && fr.users.every((u) => u.role === 'seller' && u.status === 'suspended') && fr.total === fr.users.length, 'role + status filters applied by the SERVER query', fr.users.map((u) => u.id));
  const nm = await AO._h.adminSearchUsers({ ...ADMIN, data: { pageSize: 3, sort: 'name' } });
  ck('U11', nm.users.map((u) => u.displayName).join() === 'Ann,Ben,Cy', 'sort by name is the server order', nm.users.map((u) => u.displayName));
  let exRefused = false; try { await AO._h.adminExportUsers({ ...ADMIN, data: {} }); } catch (_) { exRefused = true; }
  const audits0 = [...DOCS.keys()].filter((k) => k.startsWith('adminAudit/')).length;
  const ex = await AO._h.adminExportUsers({ auth: { uid: 'sa', token: { superAdmin: true } }, data: { role: 'buyer', status: 'active' } });
  const exAudit = [...DOCS.entries()].filter(([k, v]) => k.startsWith('adminAudit/') && v.action === 'users_exported');
  ck('U12', exRefused && ex.rows.length > 0 && ex.rows.every((r) => r.role === 'buyer' && r.status === 'active') && ex.columns.join() === 'uid,name,email,phone,role,status,joined,lastSignIn'
    && ex.rows.every((r) => Object.keys(r).join() === ex.columns.join()) && exAudit.length === 1 && exAudit[0][1].rowCount === ex.rows.length && exAudit[0][1].filters.role === 'buyer' && audits0 === 0,
    'EXPORT: ordinary admin refused; super admin gets ONLY the displayed columns, filters applied server-side, one audit record with filters + row count', { n: ex.rows.length, cols: ex.columns, audit: exAudit.length });

  /* LIVE-ONLY controls carried verbatim (b2 live comparison 2026-10-04) */
  DOCS.set('adminAudit/l1', { action: 'x', createdAt: { toDate: () => new Date(0) } });
  DOCS.set('adminPermissions/revoked', { capabilities: { audit: { read: false } } });
  let al1 = null; try { await AO._h.adminGetAuditLogs({ auth: { uid: 'revoked', token: { admin: true } }, data: {} }); al1 = 'allowed'; } catch (e) { al1 = e.code || e.message; }
  let al2 = null; try { const r = await AO._h.adminGetAuditLogs({ auth: { uid: 'plain', token: { admin: true } }, data: {} }); al2 = Array.isArray(r.logs) ? 'allowed' : 'bad'; } catch (e) { al2 = e.code || e.message; }
  ck('U13', al1 === 'permission-denied' && al2 === 'allowed' && typeof AO._adminCapabilityAllows === 'function',
    'AdminOS Authority Core pilot (live, 05df4c9): explicit audit.read=false DENIES audit logs; no override → coarse admin governs', [al1, al2]);
  DOCS.set('wallets/u1', { balance: 4200 });
  const gw = await AO._h.adminGetUser({ ...ADMIN, data: { uid: 'u1' } });
  ck('U14', gw.wallet && gw.wallet.balance === 4200, 'adminGetUser still returns the wallet (live behaviour restored)', gw.wallet);
  /* client module (no DOM needed for these rows) */
  const src = fs.readFileSync(path.join(ROOT, 'sokoni-admin-users.js'), 'utf8');
  const sb = { window: {}, document: {} }; require('vm').runInNewContext(src, sb);
  const I = sb.window.SokoniAdminUsers._internal;
  ck('U5', I.statusOf({ status: 'active', suspended: true }) === 'suspended' && I.statusOf({ status: 'banned' }) === 'banned' && I.statusOf({}) === 'active'
    && I.accessOf('superAdmin').label === 'Full Access' && I.accessOf('weird').label === 'weird' && I.accessOf('weird').caps.length === 0,
    'status: the suspended flag wins; access derives from the role; an unknown role gets no invented capabilities');
  const SAFE = /^(esc|num|statusPill|rolePill|av|DASH|ago|fmtDate|cfg\.pageSize|S\.page|p|pages|i|n|ok|soon|list\.length|slice\.length|a\.tone|.*\.length|Math\.round|r|c|uids\.length|okLabel|title|danger|inner|esc\(.+\)|.*\? .*)/;
  const raw = [...src.matchAll(/\$\{([^{}]*?)\}/g)].map((m) => m[1].trim()).filter((x) => /\b(u|p|d|ar|a|s|x)\.(displayName|email|phone|id|role|team|department|photoURL|status|label|lastSignIn)\b/.test(x) && !/^esc\(|^num\(|^(statusPill|rolePill|av)\(|ago\(|fmtDate\(/.test(x));
  ck('U6', raw.length === 0, 'every interpolation of user-controlled fields is escaped (esc / helpers)', raw);
  const metricSources = [...src.matchAll(/cfg\.call\('([A-Za-z]+)'/g)].map((m) => m[1]);
  ck('U7', !/Math\.random|\b(?:128|96|14)\b(?![\d%])/.test(src.replace(/aus-[a-z0-9-]+|#[0-9a-f]{3,6}|\d+px|rgba\([^)]*\)/gi, '')) && metricSources.includes('adminUserStats') && !metricSources.includes('listInvitations')
    && /setK\('total', av\('totalUsers'\) \? num\(st\.totalUsers\) : DASH\)/.test(src) && !/\.filter\(\(u\) => statusOf\(u\) === S\.filter\.status\)/.test(src),
    'KPIs only from adminUserStats (per-figure availability → "—"); the browser does no status filtering / counting of a partial list', metricSources);
  const aosJs = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8'), aosHtml = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8'), sa = fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8');
  ck('U8', /id="panel-users"[\s\S]{0,300}id="ausRootAos"/.test(aosHtml) && /sokoni-admin-users\.js/.test(aosHtml) && /fn: "setUserRole", payload: \(uid, x\) => \(\{ uid, role: x\.role, requestId: x\.requestId \}\)/.test(aosJs) && !/fn: "adminUpdateUserRole"/.test(aosJs) && /fn: "suspendUser", payload: \(uid, x\) => \(\{ uid, suspend: true/.test(aosJs) && !/tsBanUser/.test(aosJs)
    && /id="panel-users"[\s\S]{0,300}id="ausRootSa"/.test(sa) && /fn:'setUserRole'/.test(sa) && /fn:'suspendUser',\s+payload:\(uid,x\)=>\(\{uid,suspend:true/.test(sa) && /canExport:true/.test(sa) && /canExport: isSuper/.test(aosJs)
    && /data-section="users"/.test(aosHtml) && /data-section="users"/.test(sa), 'both pages mount in their Users panel (sidebar nav intact) and call the SAME suspendUser contract; export gated to super admins');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
