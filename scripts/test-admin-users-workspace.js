#!/usr/bin/env node
'use strict';
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
     U8  both pages mount the workspace in their Users panel (sidebars untouched) with THEIR existing action authorities
   NODE_PATH=<functions/node_modules> node scripts/test-admin-users-workspace.js */
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 260) + ']')); ok ? pass++ : fail++; };

/* ── fake Firestore with count() / select() / in / equality filters ── */
const DOCS = new Map();
function q(coll, filters, sel) {
  const rows = () => [...DOCS.entries()].filter(([k]) => k.startsWith(coll + '/') && k.split('/').length === 2).map(([k, v]) => ({ id: k.split('/')[1], v }))
    .filter(({ v }) => filters.every(([f, op, val]) => op === '==' ? v[f] === val : op === 'in' ? val.includes(v[f]) : op === '>=' ? (v[f] && v[f]._ms >= val._ms) : true));
  return {
    where: (f, op, val) => q(coll, filters.concat([[f, op, val]]), sel),
    select: () => q(coll, filters, true), limit: () => q(coll, filters, sel), orderBy: () => q(coll, filters, sel),
    count: () => ({ get: async () => ({ data: () => ({ count: rows().length }) }) }),
    get: async () => { const r = rows(); return { size: r.length, empty: !r.length, docs: r.map(({ id, v }) => ({ id, data: () => JSON.parse(JSON.stringify(v)), exists: true })) }; },
    doc: (id) => ({ get: async () => { const v = DOCS.get(coll + '/' + id); return { exists: !!v, data: () => v && JSON.parse(JSON.stringify(v)) }; } }),
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
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: { serverTimestamp: () => 'ts' }, Timestamp: { fromMillis: (m) => ({ _ms: m }) } };
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
  ck('U1', st.total === 6 && st.active === 2 && st.suspended === 4 && st.joinedLast30 === 2 && st.suspendedExact === true,
    'stats are server aggregates: total 6, active 2 (u1,u6 — flagged u2 excluded), suspended 4 (u2,u3,u4,u5 — u4 once), joined in 30 days 2', st);
  let refused = false; try { await AO._h.adminUserStats({ auth: { uid: 'x', token: {} } }); } catch (_) { refused = true; }
  ck('U2', refused, 'a non-admin is refused');
  const sr = await AO._h.adminSearchUsers({ ...ADMIN, data: { limit: 50 } });
  const u1 = sr.users.find((u) => u.id === 'u1'), u2 = sr.users.find((u) => u.id === 'u2'), u5 = sr.users.find((u) => u.id === 'u5');
  AUTH_FAIL = true; const sr2 = await AO._h.adminSearchUsers({ ...ADMIN, data: { limit: 50 } }); AUTH_FAIL = false;
  ck('U3', u1.lastSignIn === Date.parse('Sat, 04 Oct 2026 08:00:00 GMT') && u1.team === 'Ops' && u1.photoURL === 'https://x/p.png' && u2.suspended === true && u5.photoURL === null
    && sr.scanned === 6 && sr2.users.every((u) => u.lastSignIn === null),
    'search rows: Auth last sign-in, team claim, https-only photo, suspended flag, scanned; Auth failure → null', { u1, u5, scanned: sr.scanned });
  const gu = await AO._h.adminGetUser({ ...ADMIN, data: { uid: 'u1' } });
  ck('U4', gu.authRecord.mfaEnrolled === 2 && gu.authRecord.tokensValidAfter === 'Fri, 03 Oct 2026 10:00:00 GMT', 'adminGetUser carries MFA enrolment + session revocation time from Auth', gu.authRecord);

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
  ck('U7', !/Math\.random|\b(?:128|96|14)\b(?![\d%])/.test(src.replace(/aus-[a-z0-9-]+|#[0-9a-f]{3,6}|\d+px|rgba\([^)]*\)/gi, '')) && metricSources.includes('adminUserStats') && metricSources.includes('listInvitations')
    && /setK\('total', st \? num\(st\.total\) : DASH\)/.test(src), 'KPIs come only from adminUserStats / listInvitations; unknown renders "—"; no hard-coded mock-up figures', metricSources);
  const aosJs = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8'), aosHtml = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8'), sa = fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8');
  ck('U8', /id="panel-users"[\s\S]{0,300}id="ausRootAos"/.test(aosHtml) && /sokoni-admin-users\.js/.test(aosHtml) && /fn: "adminUpdateUserRole"/.test(aosJs) && /fn: "tsBanUser", payload: \(uid, x\) => \(\{ uid, action: "suspend"/.test(aosJs)
    && /id="panel-users"[\s\S]{0,300}id="ausRootSa"/.test(sa) && /fn:'setUserRole'/.test(sa) && /fn:'suspendUser',\s+payload:\(uid,x\)=>\(\{uid,suspend:true/.test(sa)
    && /data-section="users"/.test(aosHtml) && /data-section="users"/.test(sa), 'both pages mount in their Users panel (sidebar nav intact) and keep their own action authorities');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
