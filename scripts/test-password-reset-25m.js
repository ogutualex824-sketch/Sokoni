#!/usr/bin/env node
'use strict';
/* ============================================================================
   Password reset — 25-minute, single-use, server-hashed link (owner requirement 2026-10-01)
   ----------------------------------------------------------------------------
   Real module (functions/password-reset-gate.js). firebase-admin is replaced at the SDK boundary
   by the in-memory Firestore fake (scripts/lib/fake-firestore-txn.js) plus a recording Auth
   stub; the email transport is captured, never sent. The clock is injected.
     A  request: existing and unknown emails get the IDENTICAL response; only a hash is stored;
        link in the email; expiresAt = issuedAt + 25 min exactly; disabled account → no mail
     B  lifetime: 24m59s → password changes; a fresh link at 25m01s → refused, password unchanged
     C  single use: second use refused; a NEWER link revokes the older one
     D  tampered / malformed / unknown token → refused with the same generic message
     E  after success: refresh tokens revoked, owner notified, securityEvents written,
        no plaintext token or email stored anywhere in Firestore
     F  rate limits: 4th request for one email in 15 min → resource-exhausted (+retryAfter);
        limiter failure → refused (fail closed)
     G  weak password refused before the token is spent; a failed updateUser reopens the link
     H  exported by name from functions/index.js; App Check enforced; no client rule opens the
        two collections
   node scripts/test-password-reset-25m.js
   ============================================================================ */
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };

let now = Date.UTC(2026, 9, 1, 8, 0, 0);
const F = makeFakeFirestore({ clock: () => now });
const users = new Map([
  ['alice@example.com', { uid: 'uA', email: 'alice@example.com', disabled: false, password: 'OldPass123' }],
  ['dis@example.com', { uid: 'uD', email: 'dis@example.com', disabled: true, password: 'x' }],
]);
const revoked = [];
let failNextUpdate = null;
const auth = {
  getUserByEmail: async (e) => { const u = users.get(e); if (!u) { const err = new Error('no user'); err.code = 'auth/user-not-found'; throw err; } return u; },
  getUser: async (uid) => [...users.values()].find((u) => u.uid === uid),
  updateUser: async (uid, p) => { if (failNextUpdate) { const e = failNextUpdate; failNextUpdate = null; throw e; } const u = [...users.values()].find((x) => x.uid === uid); u.password = p.password; return u; },
  revokeRefreshTokens: async (uid) => { revoked.push(uid); },
};
const mail = [];
const send = async (m) => { mail.push(m); return { provider: 'captured' }; };

/* firebase-admin stub: admin.firestore() is a function WITH static Timestamp/FieldValue */
const firestoreFn = () => F.db;
firestoreFn.Timestamp = F.Timestamp; firestoreFn.FieldValue = F.FieldValue;
const adminStub = { apps: [1], initializeApp() {}, firestore: firestoreFn, auth: () => auth };
const resolveFrom = (req) => Module._resolveFilename(req, { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
const stub = (req, exp) => { const f = resolveFrom(req); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
stub('firebase-admin', adminStub);
stub(path.join(FN, 'email-service.js'), { send, EMAIL_SECRETS: [] });

const G = require(path.join(FN, 'password-reset-gate.js'));
const X = G._internal;
X._setClock(() => now);
const deps = { auth, send };
const raw = (ip) => ({ headers: { 'x-forwarded-for': 'spoofed, ' + (ip || '41.90.0.1') }, ip: '10.0.0.1' });
async function tryCall(fn) { try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, code: e.code, msg: e.message, details: e.details }; } }
const tokenFrom = (m) => (String(m.text).match(/reset-password\?t=([A-Za-z0-9_-]+)/) || [])[1];
const allDocs = () => [...F.db._store.entries()].map(([p, v]) => [p, JSON.stringify(v.data)]);

(async () => {
  console.log('Password reset — 25-minute single-use link\n');

  console.log('A. request');
  const rA = await tryCall(() => X.requestReset({ email: 'Alice@Example.com ' }, raw('41.90.0.1'), deps));
  const rU = await tryCall(() => X.requestReset({ email: 'nobody@example.com' }, raw('41.90.0.2'), deps));
  ck('A1 existing and unknown emails get the IDENTICAL response', rA.ok && rU.ok && JSON.stringify(rA.v) === JSON.stringify(rU.v), { rA, rU });
  ck('A2 exactly one email sent (to the existing account only), category security', mail.length === 1 && mail[0].to === 'alice@example.com' && mail[0].category === 'security', mail.map((m) => m.to));
  const t1 = tokenFrom(mail[0]);
  ck('A3 the link carries a 43-char base64url token', X.TOKEN_RE.test(t1 || ''), t1);
  const crypto = require('crypto'); const h1 = crypto.createHash('sha256').update(t1).digest('hex');
  const doc1 = (await F.db.collection('passwordResetTokens').doc(h1).get());
  ck('A4 only the SHA-256 of the token is stored (doc id = hash)', doc1.exists && !allDocs().some(([, v]) => v.includes(t1)));
  const d1 = doc1.data();
  ck('A5 expiresAt = issuedAt + exactly 25 minutes', d1.expiresAt.toMillis() - d1.issuedAt.toMillis() === 25 * 60 * 1000 && X.TTL_MS === 1500000, [d1.issuedAt.toMillis(), d1.expiresAt.toMillis()]);
  await X.requestReset({ email: 'dis@example.com' }, raw('41.90.0.3'), deps);
  ck('A6 disabled account → no email, same response', mail.length === 1);
  ck('A7 no plaintext email address stored in Firestore', !allDocs().some(([, v]) => /alice@example\.com|nobody@example\.com/.test(v)));

  console.log('\nB. lifetime');
  now += 24 * 60 * 1000 + 59 * 1000;                                   /* 24m59s */
  const b1 = await tryCall(() => X.completeReset({ token: t1, newPassword: 'NewPass123' }, raw(), deps));
  ck('B1 at 24m59s the link works: password changed', b1.ok && users.get('alice@example.com').password === 'NewPass123', b1);
  now += 60 * 1000;
  mail.length = 0;
  await X.requestReset({ email: 'alice@example.com' }, raw('41.90.0.4'), deps);
  const t2 = tokenFrom(mail[0]);
  now += 25 * 60 * 1000 + 1000;                                        /* 25m01s */
  const b2 = await tryCall(() => X.completeReset({ token: t2, newPassword: 'Later9999x' }, raw(), deps));
  ck('B2 at 25m01s the link is refused and the password does NOT change', !b2.ok && b2.code === 'failed-precondition' && users.get('alice@example.com').password === 'NewPass123', b2);

  console.log('\nC. single use + revocation');
  const c1 = await tryCall(() => X.completeReset({ token: t1, newPassword: 'Again12345' }, raw(), deps));
  ck('C1 second use of a spent link → refused, password unchanged', !c1.ok && users.get('alice@example.com').password === 'NewPass123', c1);
  mail.length = 0;
  await X.requestReset({ email: 'alice@example.com' }, raw('41.90.0.5'), deps);
  const t3 = tokenFrom(mail[0]);
  now += 60 * 1000;
  await X.requestReset({ email: 'alice@example.com' }, raw('41.90.0.6'), deps);
  const t4 = tokenFrom(mail[1]);
  const c2 = await tryCall(() => X.completeReset({ token: t3, newPassword: 'Older12345' }, raw(), deps));
  ck('C2 an OLDER link is revoked once a newer one is issued', !c2.ok && users.get('alice@example.com').password === 'NewPass123', c2);

  console.log('\nD. tampering');
  const flip = t4.slice(0, -1) + (t4.slice(-1) === 'A' ? 'B' : 'A');
  const d1r = await tryCall(() => X.completeReset({ token: flip, newPassword: 'Tamper1234' }, raw(), deps));
  const d2r = await tryCall(() => X.completeReset({ token: 'short', newPassword: 'Tamper1234' }, raw(), deps));
  const d3r = await tryCall(() => X.completeReset({ token: crypto.randomBytes(32).toString('base64url'), newPassword: 'Tamper1234' }, raw(), deps));
  ck('D1 modified / malformed / unknown token → refused with ONE generic message', [d1r, d2r, d3r].every((r) => !r.ok && r.msg === X.GENERIC_BAD) && users.get('alice@example.com').password === 'NewPass123', [d1r.msg, d2r.msg, d3r.msg]);

  console.log('\nE. after success');
  revoked.length = 0; mail.length = 0;
  const e1 = await tryCall(() => X.completeReset({ token: t4, newPassword: 'Final12345' }, raw(), deps));
  ck('E1 newest link works; refresh tokens revoked (other sessions signed out)', e1.ok && users.get('alice@example.com').password === 'Final12345' && revoked.includes('uA'), { e1, revoked });
  ck('E2 the account owner is notified that the password changed', mail.some((m) => m.to === 'alice@example.com' && /password was changed/i.test(m.subject)));
  const ev = allDocs().filter(([p]) => p.startsWith('securityEvents/')).map(([, v]) => JSON.parse(v).type);
  ck('E3 securityEvents records requested + completed', ev.includes('password_reset_requested') && ev.includes('password_reset_completed'), ev);
  ck('E4 no plaintext token anywhere in Firestore', ![t1, t2, t3, t4].some((t) => allDocs().some(([, v]) => v.includes(t))));

  console.log('\nF. rate limits');
  mail.length = 0;
  let last = null;
  for (let i = 0; i < 4; i++) last = await tryCall(() => X.requestReset({ email: 'rate@example.com' }, raw('41.90.1.' + i), deps));
  ck('F1 4th request for one email inside 15 min → resource-exhausted with retryAfterSeconds', !last.ok && last.code === 'resource-exhausted' && last.details && last.details.retryAfterSeconds > 0, last);
  now += 15 * 60 * 1000 + 1000;
  const f2 = await tryCall(() => X.requestReset({ email: 'rate@example.com' }, raw('41.90.1.9'), deps));
  ck('F2 after the window the same email is allowed again', f2.ok, f2);
  const spoofA = X._clientKey({ headers: { 'x-forwarded-for': '1.1.1.1, 41.90.9.9' } });
  const spoofB = X._clientKey({ headers: { 'x-forwarded-for': '2.2.2.2, 41.90.9.9' } });
  ck('F3 client key uses the RIGHT-MOST forwarded address (a spoofed left entry does not change it)', spoofA === spoofB);
  const origRT = F.db.runTransaction;
  F.db.runTransaction = async () => { throw new Error('contention'); };
  const f4 = await tryCall(() => X.requestReset({ email: 'alice@example.com' }, raw('41.90.2.1'), deps));
  F.db.runTransaction = origRT;
  ck('F4 limiter failure → refused (fail CLOSED), no email', !f4.ok && f4.code === 'unavailable' && !mail.some((m) => m.to === 'alice@example.com'), f4);

  console.log('\nG. password rules + failure recovery');
  mail.length = 0;
  await X.requestReset({ email: 'alice@example.com' }, raw('41.90.3.1'), deps);
  const t5 = tokenFrom(mail[0]);
  const g1 = await tryCall(() => X.completeReset({ token: t5, newPassword: 'short' }, raw(), deps));
  ck('G1 weak password refused BEFORE the link is spent', !g1.ok && g1.code === 'invalid-argument');
  failNextUpdate = Object.assign(new Error('backend down'), { code: 'auth/internal-error' });
  const g2 = await tryCall(() => X.completeReset({ token: t5, newPassword: 'Good12345x' }, raw(), deps));
  const g3 = await tryCall(() => X.completeReset({ token: t5, newPassword: 'Good12345x' }, raw(), deps));
  ck('G2 a failed updateUser reopens the link; the retry succeeds', !g2.ok && g3.ok && users.get('alice@example.com').password === 'Good12345x', { g2, g3 });

  console.log('\nH. wiring');
  const idx = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
  ck('H1 both functions exported BY NAME from functions/index.js',
    /exports\.authRequestPasswordReset\s*=\s*require\('\.\/password-reset-gate'\)\.authRequestPasswordReset/.test(idx)
    && /exports\.authCompletePasswordReset\s*=\s*require\('\.\/password-reset-gate'\)\.authCompletePasswordReset/.test(idx));
  const src = fs.readFileSync(path.join(FN, 'password-reset-gate.js'), 'utf8');
  ck('H2 App Check enforced on both callables', /enforceAppCheck:\s*true/.test(src));
  const rulesFile = ['firestore.rules', 'firestore.rules.build'].map((f) => path.join(ROOT, f)).find((f) => fs.existsSync(f));
  const rules = rulesFile ? fs.readFileSync(rulesFile, 'utf8') : '';
  ck('H3 no Firestore rule matches passwordResetTokens / passwordResetState / passwordResetRate (default deny)',
    !!rules && !/passwordReset(Tokens|State|Rate)/.test(rules) && !/match \/\{document=\*\*\}/.test(rules.replace(/match \/tenants\/\{tenantId\}\/\{document=\*\*\}/g, '')));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
