/* CENSUS — legacy 'banned' accounts and suspensions without an end date (owner 2026-10-04, Users security release).
   ==========================================================================
   READ-ONLY. Lists and classifies; never writes, never deletes, has no flag that would let it.
   Run (Admin SDK credentials, e.g. gcloud application-default):  node scripts/census-legacy-banned.js [--out <file.json>]

   For every users/{uid} with status == 'banned' (the old tsBanUser / tsReviewReport wrote these WITHOUT an Auth lockout):
     auth        exists · disabled · could still sign in
     session     lastRefreshTime within 1 h (may hold a still-valid ID token) · within 30 d
     capability  governed role claims present (admin / superAdmin / moderator / seller / driver) · non-role claim KEYS
                 (merchantId, posId …) — values are never printed
     money       wallets/{uid} balance non-zero (boolean only) · open payoutRequests (pending / processing / approved)
   Plus: suspended accounts with NO readable suspendedUntil — the expiry job never lifts these (fail closed).

   Output prints a uid PREFIX and flags only — no names, emails, phones or amounts. --out writes the full uid list
   (keep it outside the repo). If credentials are absent it EXITS NON-ZERO; it never estimates a count it did not read.
   ==========================================================================*/
'use strict';
const fs = require('fs');
let admin;
try { admin = require('firebase-admin'); } catch (_) { console.error('census: firebase-admin not resolvable (set NODE_PATH to a functions/node_modules)'); process.exit(2); }
const PROJECT = 'sokoni-aeb26';
try { admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT }); }
catch (e) { console.error('census: no Admin credentials — ' + e.message); process.exit(2); }
const db = admin.firestore(), auth = admin.auth();
const GOV = ['superAdmin', 'admin', 'moderator', 'seller', 'driver'];
const OPEN_PAYOUT = ['pending', 'processing', 'approved', 'queued'];
const H = 3600e3, D30 = 30 * 24 * H;
const pfx = (u) => String(u).slice(0, 6) + '…';
const ms = (v) => (v && typeof v.toMillis === 'function') ? v.toMillis() : (v instanceof Date ? v.getTime() : null);

(async () => {
  const outIdx = process.argv.indexOf('--out'); const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
  const now = Date.now();
  /* POSITIVE CONTROL: the SAME query shape must find a value known to exist, or an empty result proves nothing */
  const control = await db.collection('users').where('status', '==', 'active').limit(1).get();
  const totalUsers = (await db.collection('users').count().get()).data().count;
  if (control.size !== 1) { console.error('census: POSITIVE CONTROL FAILED — status=="active" returned ' + control.size + '; result would be meaningless'); process.exit(3); }
  const banned = await db.collection('users').where('status', '==', 'banned').get();
  const rows = [];
  for (const d of banned.docs) {
    const u = d.data() || {};
    let a = null, authErr = null;
    try { a = await auth.getUser(d.id); } catch (e) { authErr = e.code || 'error'; }
    const cc = (a && a.customClaims) || {};
    const lastRefresh = a && a.metadata && a.metadata.lastRefreshTime ? Date.parse(a.metadata.lastRefreshTime) : null;
    let wallet = null; try { const w = await db.collection('wallets').doc(d.id).get(); wallet = w.exists ? (Number((w.data() || {}).balance || 0) !== 0) : false; } catch (_) { wallet = 'unreadable'; }
    let openPayouts = null; try { const p = await db.collection('payoutRequests').where('sellerUid', '==', d.id).where('status', 'in', OPEN_PAYOUT).limit(20).get(); openPayouts = p.size; } catch (_) { openPayouts = 'unreadable'; }
    rows.push({
      uid: d.id,
      authExists: !!a, authError: authErr, authDisabled: a ? a.disabled === true : null,
      canSignIn: a ? a.disabled !== true : false,
      sessionWithin1h: lastRefresh != null ? now - lastRefresh < H : null,
      sessionWithin30d: lastRefresh != null ? now - lastRefresh < D30 : null,
      governedRoles: GOV.filter((k) => cc[k] === true), nonRoleClaimKeys: Object.keys(cc).filter((k) => !GOV.includes(k) && k !== 'buyer' && k !== 'permsVersion'),
      roleField: u.role || null, hasBanReason: !!u.banReason, bannedAtKnown: !!ms(u.bannedAt),
      walletNonZero: wallet, openPayoutRequests: openPayouts,
    });
  }
  /* suspensions with no readable end date (status suspended OR suspended:true) */
  const [s1, s2] = await Promise.all([db.collection('users').where('status', '==', 'suspended').get(), db.collection('users').where('suspended', '==', true).get()]);
  const susp = new Map(); for (const d of [...s1.docs, ...s2.docs]) susp.set(d.id, d.data() || {});
  const noEnd = [...susp.entries()].filter(([, u]) => u.status !== 'banned' && ms(u.suspendedUntil) == null).map(([uid, u]) => ({ uid, status: u.status || null, suspendedFlag: u.suspended === true }));

  const review = rows.filter((r) => r.canSignIn || r.governedRoles.length || r.nonRoleClaimKeys.length || r.walletNonZero === true || (typeof r.openPayoutRequests === 'number' && r.openPayoutRequests > 0));
  console.log('LEGACY BANNED CENSUS (read-only) — project ' + PROJECT + ' — ' + new Date(now).toISOString());
  console.log('  positive control: status=="active" query returned ' + control.size + ' (expected 1) · users collection size ' + totalUsers);
  console.log('  users with status == "banned": ' + rows.length + ' (query read ' + banned.size + ' docs)');
  console.log('  ├ no Auth account: ' + rows.filter((r) => !r.authExists).length);
  console.log('  ├ CAN STILL SIGN IN (Auth enabled): ' + rows.filter((r) => r.canSignIn).length);
  console.log('  ├ session refreshed < 1 h: ' + rows.filter((r) => r.sessionWithin1h).length + ' · < 30 d: ' + rows.filter((r) => r.sessionWithin30d).length);
  console.log('  ├ governed role claims (admin/superAdmin/moderator/seller/driver): ' + rows.filter((r) => r.governedRoles.length).length);
  console.log('  ├ non-role claims (e.g. merchantId/posId): ' + rows.filter((r) => r.nonRoleClaimKeys.length).length);
  console.log('  ├ wallet balance non-zero: ' + rows.filter((r) => r.walletNonZero === true).length + (rows.some((r) => r.walletNonZero === 'unreadable') ? ' (some unreadable)' : ''));
  console.log('  └ open payout requests: ' + rows.filter((r) => typeof r.openPayoutRequests === 'number' && r.openPayoutRequests > 0).length + (rows.some((r) => r.openPayoutRequests === 'unreadable') ? ' (some unreadable)' : ''));
  console.log('  NEEDS EXPLICIT REVIEW (can sign in, capability, or money): ' + review.length);
  for (const r of review) console.log('    ' + pfx(r.uid) + '  signIn=' + r.canSignIn + ' s1h=' + r.sessionWithin1h + ' roles=[' + r.governedRoles.join(',') + '] claimKeys=[' + r.nonRoleClaimKeys.join(',') + '] wallet≠0=' + r.walletNonZero + ' openPayouts=' + r.openPayoutRequests);
  console.log('  suspended accounts with NO readable suspendedUntil (never auto-lifted; would be flagged): ' + noEnd.length);
  if (outFile) { fs.writeFileSync(outFile, JSON.stringify({ at: new Date(now).toISOString(), banned: rows, suspendedNoEnd: noEnd }, null, 2)); console.log('  full list → ' + outFile); }
  process.exit(0);
})().catch((e) => { console.error('census: FAILED — ' + (e.code || '') + ' ' + e.message); process.exit(1); });
