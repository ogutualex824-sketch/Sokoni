#!/usr/bin/env node
/* census-approval-remediation.js — READ ONLY. Partitions every account into exactly one primary approval state and
 * records the evidence behind it. Writes nothing to Firestore or Auth; writes two local files.
 *
 *   node scripts/census-approval-remediation.js --out <dir>      (owner-authorized production reads)
 *
 * POPULATION  every uid seen in Auth, users/, providers/, sellers/, businesses/, shops/ or applications.uid.
 *
 * STATES (one primary per account, evaluated in this order; every flag is also reported)
 *   REFUSED               providers.approvalDecision.decision == 'refuse' (source admin_decision), or every application rejected
 *                         and no live registry record
 *   VALIDLY_APPROVED      an approved application whose decidedBy is a RESOLVABLE Auth account holding admin|superAdmin
 *                         (the deployed trigger's authority test), or approvalDecision.decision == 'approve' by admin_decision
 *   INVALID_LEGACY        an approval ARTEFACT exists (application approved / provider or seller approvedAt / adminApproved)
 *                         but no decision passes the authority test (e.g. decidedBy "reindex", "self", a non-admin, absent)
 *   NO_APPROVAL_EVIDENCE  a provider / seller / business / shop record is live by STATUS alone — no approvedAt, no decision
 *   PENDING_APPLICATION   an undecided application (pending / info_requested / submitted…) and no live registry record
 *   BUYER_ONLY            none of the above: no registry record, no application, roles ⊆ {buyer}, no provider/seller claim
 *
 * PER ACCOUNT (3–6 get full evidence)   registry records and their status/evidence fields; applications with decidedBy and the
 *   authority test result; activity counts; whether PRODUCTION currently routes the account to a provider/business dashboard
 *   (approximation stated in the doc: provider/seller role or claim, or a live registry status — the live shell routes on
 *   these, not on approval evidence); whether the account is PUBLICLY SEARCHABLE (searchable || isPublic on a registry
 *   record) without valid approval; reusable application vs fresh application; historical decisions to PRESERVE; and the
 *   c4 resolver's verdict (business-workspace.js) for comparison.
 */
'use strict';
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2); const outDir = args[args.indexOf('--out') + 1] || __dirname;
const REPO = 'C:/Users/USER1/OneDrive/Desktop/SOKONI'; const CAP = path.resolve(__dirname, '..');
const _r = require('module').createRequire(REPO + '/functions/package.json');
const admin = _r('firebase-admin'); const { getFirestore } = _r('firebase-admin/firestore');
const app = admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'sokoni-aeb26' }); const db = getFirestore(app);
const BW = require(CAP + '/functions/business-workspace.js');
const cleanup = require(REPO + '/docs/release-gates/c3-cleanup-manifest.json');
const norm = (v) => (v == null ? null : JSON.parse(JSON.stringify(v, (k, x) => (x && x._seconds !== undefined ? new Date(x._seconds * 1000).toISOString() : (x && x.toDate ? x.toDate().toISOString() : x)))));
const sha = (o) => require('crypto').createHash('sha256').update(JSON.stringify(o)).digest('hex');
const LIVE = ['active', 'approved', 'verified'];
const UNDECIDED = ['pending', 'pending_review', 'pending_verification', 'submitted', 'info_requested', 'under_review', 'in_review'];
const REJECTED = ['rejected', 'declined', 'denied'];
const lower = (s) => String(s || '').toLowerCase();
const adminCache = new Map();
async function isAdminAccount(uid) {
  if (!uid || typeof uid !== 'string' || /[:/ ]/.test(uid)) return { ok: false, why: 'not_a_uid' };
  if (adminCache.has(uid)) return adminCache.get(uid);
  let r; try { const u = await admin.auth().getUser(uid); const c = u.customClaims || {}; r = (c.admin === true || c.superAdmin === true) ? { ok: true } : { ok: false, why: 'no_admin_claim' }; } catch (e) { r = { ok: false, why: 'unresolvable_account' }; }
  adminCache.set(uid, r); return r;
}
(async () => {
  const at = new Date().toISOString();
  const authUsers = []; let tok; do { const p = await admin.auth().listUsers(1000, tok); authUsers.push(...p.users); tok = p.pageToken; } while (tok);
  const col = async (c) => (await db.collection(c).get()).docs.map((d) => Object.assign({ __id: d.id }, norm(d.data())));
  const [users, providers, sellers, businesses, shops, applications] = await Promise.all(['users', 'providers', 'sellers', 'businesses', 'shops', 'applications'].map(col));
  const byId = (rows) => Object.fromEntries(rows.map((r) => [r.__id, r]));
  const U = byId(users), P = byId(providers), S = byId(sellers);
  const authByUid = Object.fromEntries(authUsers.map((u) => [u.uid, u]));
  const isAccountId = (id) => !!authByUid[id] || !!U[id] || !!P[id] || !!S[id];
  /* businesses/ and shops/ are keyed by a business id (SOK-…) or a shop id, not always by uid: join each to its OWNER
     account (ownerId / ownerUid / uid / sellerUid / ownerID), else it is a DIRECTORY RECORD WITHOUT AN ACCOUNT. */
  const ownerOf = (d) => [d.ownerId, d.ownerUid, d.uid, d.sellerUid, d.ownerID, d.userId].find((x) => typeof x === 'string' && isAccountId(x)) || (isAccountId(d.__id) ? d.__id : null);
  const B = {}, SH = {}, orphans = [];
  businesses.forEach((d) => { const o = ownerOf(d); if (o) (B[o] = B[o] || []).push(d); else orphans.push({ collection: 'businesses', id: d.__id, name: d.name || d.businessName || null, status: lower(d.status), ownerFields: { ownerId: d.ownerId || null, ownerUid: d.ownerUid || null, uid: d.uid || null }, inCleanupManifest: cleanup.ids.includes('businesses/' + d.__id) }); });
  shops.forEach((d) => { const o = ownerOf(d); if (o) (SH[o] = SH[o] || []).push(d); else orphans.push({ collection: 'shops', id: d.__id, name: d.name || d.storeName || null, status: lower(d.status), ownerFields: { ownerId: d.ownerId || null, ownerUid: d.ownerUid || null, uid: d.uid || null, sellerUid: d.sellerUid || null }, inCleanupManifest: cleanup.ids.includes('shops/' + d.__id) }); });
  const appsByUid = {}; applications.forEach((a) => { if (a.uid) (appsByUid[a.uid] = appsByUid[a.uid] || []).push(a); });
  const uids = new Set([...authUsers.map((u) => u.uid), ...Object.keys(U), ...Object.keys(P), ...Object.keys(S), ...Object.keys(B), ...Object.keys(SH), ...Object.keys(appsByUid)]);
  /* which registry kind an application's role approves */
  const KIND_OF_ROLE = { provider: ['provider'], health: ['provider'], legal: ['provider'], event_organizer: ['provider'], seller: ['seller', 'business', 'shop'], merchant: ['seller', 'business', 'shop'], business: ['seller', 'business', 'shop'], driver: ['driver'], rider: ['driver'], landlord: ['landlord'], hotel: ['business'], property: ['landlord'] };
  const count = async (c, f, v) => { try { return (await db.collection(c).where(f, '==', v).limit(50).get()).size; } catch (e) { return 'unreadable'; } };
  const rows = [];
  for (const uid of uids) {
    const a = authByUid[uid], u = U[uid] || null, p = P[uid] || null, s = S[uid] || null, apps = appsByUid[uid] || [];
    const bList = B[uid] || [], shList = SH[uid] || [];
    const claims = a ? Object.keys(a.customClaims || {}).filter((k) => a.customClaims[k] === true) : [];
    const roles = (u && Array.isArray(u.roles)) ? u.roles.map(lower) : (u && u.role ? [lower(u.role)] : []);
    /* applications with the authority test */
    const appEv = [];
    for (const x of apps) {
      const st = lower(x.statusCanonical || x.status); const by = typeof x.decidedBy === 'string' ? x.decidedBy.trim() : null;
      const auth = by ? await isAdminAccount(by) : { ok: false, why: 'no_decidedBy' };
      const role = lower(x.role);
      appEv.push({ id: x.__id, status: st, decidedBy: by, decidedAt: x.decidedAt || null, authority: auth.ok ? (by === uid ? 'admin_account_SELF_DECISION' : 'admin_account') : auth.why, approvesKinds: KIND_OF_ROLE[role] || ['provider'], agreementAccepted: x.agreementAccepted === true, agreementVersion: x.agreementVersion || null, priorDecisions: Array.isArray(x.priorDecisions) ? x.priorDecisions.length : 0, role, type: x.type || null });
    }
    const regs = [['provider', p], ['seller', s], ...bList.map((d) => ['business', d]), ...shList.map((d) => ['shop', d])].filter(([, d]) => d).map(([kind, d]) => ({ kind, id: d.__id, status: lower(d.status), live: LIVE.includes(lower(d.status)), approvedAt: d.approvedAt || null, approvedBy: d.approvedBy || null, approved: d.approved === true, adminApproved: d.adminApproved === true, searchable: d.searchable === true, isPublic: d.isPublic === true, suspended: d.suspended === true, approvalDecision: d.approvalDecision ? { decision: d.approvalDecision.decision, decidedBy: d.approvalDecision.decidedBy, decidedAt: d.approvalDecision.decidedAt || null, source: d.approvalDecision.source } : null, business: d.business ? { category: d.business.category, source: d.business.source } : null, capabilities: d.capabilities ? Object.keys(d.capabilities).filter((k) => k !== 'version') : null, name: d.name || d.businessName || d.storeName || null, healthcare: !!d.healthcare, inCleanupManifest: cleanup.ids.includes((kind === 'business' ? 'businesses' : kind + 's') + '/' + d.__id) }));
    const activity = regs.length || apps.length ? { bookings: await count('providerBookings', 'providerId', uid), services: await count('providerServices', 'providerId', uid), products: await count('products', 'sellerUid', uid), orders: await count('orders', 'sellerUid', uid), walletTx: await count('walletTransactions', 'uid', uid) } : null;
    /* flags */
    const adminDecision = regs.map((r) => r.approvalDecision).find((d) => d && d.source === 'admin_decision') || null;
    /* a valid approval must be by a (non-self) admin account AND approve the kind of registry record that is live/present;
       a driver application does not approve a seller record */
    const regKinds = regs.map((r) => r.kind);
    const validApp = appEv.find((e) => e.status === 'approved' && e.authority === 'admin_account' && (!regs.length || e.approvesKinds.some((k) => regKinds.includes(k)))) || null;
    const validOtherRole = appEv.filter((e) => e.status === 'approved' && e.authority === 'admin_account' && regs.length && !e.approvesKinds.some((k) => regKinds.includes(k)));
    const selfDecided = appEv.filter((e) => e.authority === 'admin_account_SELF_DECISION');
    const approvedArtefactApps = appEv.filter((e) => e.status === 'approved' && e.authority !== 'admin_account' && !(validOtherRole.includes(e)));
    const approvalArtefactRegs = regs.filter((r) => r.approvedAt || r.approved || r.adminApproved || r.approvedBy);
    const liveRegs = regs.filter((r) => r.live);
    const publicRegs = regs.filter((r) => r.searchable || r.isPublic);
    const undecidedApps = appEv.filter((e) => UNDECIDED.includes(e.status) || (!e.status && !e.decidedBy));
    const rejectedApps = appEv.filter((e) => REJECTED.includes(e.status));
    const providerish = roles.some((r) => ['provider', 'seller', 'merchant', 'business', 'driver', 'landlord', 'organizer', 'creator', 'venue'].includes(r)) || claims.some((c) => ['provider', 'seller', 'merchant', 'driver', 'landlord', 'organizer', 'creator'].includes(c));
    let state, why, subtype = null;
    if (adminDecision && adminDecision.decision === 'refuse') { state = 'REFUSED'; subtype = 'admin_decision_refuse'; why = 'providers.approvalDecision refuse by ' + adminDecision.decidedBy + ' (admin_decision)'; }
    else if (validApp || (adminDecision && adminDecision.decision === 'approve')) { state = 'VALIDLY_APPROVED'; subtype = validApp ? 'application_by_admin_account' : 'admin_decision_approve'; why = validApp ? 'application ' + validApp.id + ' (' + validApp.role + ') approved by admin account ' + validApp.decidedBy : 'approvalDecision approve by ' + adminDecision.decidedBy; }
    else if (approvedArtefactApps.length || approvalArtefactRegs.length) { state = 'INVALID_LEGACY'; subtype = 'approval_artefact_without_authority'; why = [...approvedArtefactApps.map((e) => 'application ' + e.id + ' approved, decidedBy ' + JSON.stringify(e.decidedBy) + ' → ' + e.authority), ...approvalArtefactRegs.map((r) => r.kind + ' carries ' + ['approvedAt', 'approved', 'adminApproved', 'approvedBy'].filter((k) => r[k]).join('/') + ' with no admin decision')].join('; '); }
    else if (liveRegs.length) { state = 'NO_APPROVAL_EVIDENCE'; subtype = 'live_status_only'; why = liveRegs.map((r) => r.kind + (r.id !== uid ? '(' + r.id + ')' : '') + ' status ' + r.status + ', no approvedAt, no decision').join('; ') + (validOtherRole.length ? '; approved application(s) exist for ANOTHER role only: ' + validOtherRole.map((e) => e.id + ' (' + e.role + ')').join(', ') : ''); }
    else if (undecidedApps.length) { state = 'PENDING_APPLICATION'; subtype = 'undecided_application'; why = undecidedApps.map((e) => 'application ' + e.id + ' ' + e.status).join('; '); }
    else if (rejectedApps.length && !regs.length) { state = 'REFUSED'; subtype = 'application_rejected'; why = rejectedApps.map((e) => 'application ' + e.id + ' ' + e.status).join('; '); }
    else if (!regs.length && !apps.length && !providerish) { state = 'BUYER_ONLY'; subtype = 'buyer'; why = 'no registry record, no application, roles ' + JSON.stringify(roles) + ', claims ' + JSON.stringify(claims); }
    else if (regs.length) { state = 'NO_APPROVAL_EVIDENCE'; subtype = 'registry_stub_not_live'; why = 'registry record(s) present but not live: ' + regs.map((r) => r.kind + ':' + (r.status || '<no status>')).join(', ') + '; roles ' + JSON.stringify(roles); }
    else { state = 'NO_APPROVAL_EVIDENCE'; subtype = 'role_without_registry'; why = 'provider/seller role or claim (' + JSON.stringify(roles) + ' / ' + JSON.stringify(claims) + ') with no registry record and no application'; }
    if (selfDecided.length) why += '; SELF-DECIDED application(s): ' + selfDecided.map((e) => e.id + ' (' + e.role + ', ' + e.status + ')').join(', ');
    const valid = state === 'VALIDLY_APPROVED';
    const routedToDashboardNow = providerish || liveRegs.length > 0;
    let resolver = null; if (regs.length || apps.length) { try { const w = await BW.workspaceFor(db, uid); resolver = { state: w.state, reason: w.reason || null, route: w.route || w.workspace || null }; } catch (e) { resolver = { state: 'unreadable' }; } }
    const rawName = (regs[0] && regs[0].name) || (u && (u.name || u.displayName)) || null;
    rows.push({ uid, name: rawName && /^\+?\d[\d\s]{6,}$/.test(String(rawName)) ? '<phone-number-as-name>' : rawName, state, subtype, why, selfDecidedApplications: selfDecided.map((e) => e.id), approvedForOtherRoleOnly: validOtherRole.map((e) => e.id + ':' + e.role), auth: a ? { exists: true, claims, created: a.metadata.creationTime, lastSignIn: a.metadata.lastSignInTime || null, disabled: a.disabled } : { exists: false }, usersDoc: !!u, roles, registry: regs, applications: appEv, activity,
      routedToDashboardWithoutValidApproval: !valid && routedToDashboardNow && state !== 'BUYER_ONLY' && state !== 'REFUSED' ? true : (!valid && routedToDashboardNow && state === 'REFUSED' ? 'refused_but_role_or_status' : false),
      publiclySearchableWithoutValidApproval: !valid && publicRegs.length > 0, publicRecords: publicRegs.map((r) => r.kind),
      applicationPath: appEv.length ? (undecidedApps.length ? 'continue_existing_pending' : (approvedArtefactApps.length ? 'redecide_existing_after_acknowledgement' : (rejectedApps.length && appEv.length === rejectedApps.length ? 'refusal_rules_then_fresh' : 'existing_application_present'))) : 'fresh_application_required',
      preserve: [...appEv.filter((e) => e.decidedBy).map((e) => 'applications/' + e.id + '.decidedBy=' + JSON.stringify(e.decidedBy) + ' @ ' + e.decidedAt), ...regs.filter((r) => r.approvedAt).map((r) => r.kind + '.approvedAt=' + r.approvedAt), ...regs.filter((r) => r.approvalDecision).map((r) => r.kind + '.approvalDecision=' + r.approvalDecision.decision + ' by ' + r.approvalDecision.decidedBy)],
      protectedFromRemediation: valid, inCleanupManifest: cleanup.ids.filter((x) => x.endsWith('/' + uid)), resolver });
  }
  const dist = {}; rows.forEach((r) => { dist[r.state] = (dist[r.state] || 0) + 1; });
  const sub = {}; rows.forEach((r) => { const k = r.state + '/' + r.subtype; sub[k] = (sub[k] || 0) + 1; });
  const out = { at, readOnly: true, population: { accounts: rows.length, auth: authUsers.length, users: users.length, providers: providers.length, sellers: sellers.length, businesses: businesses.length, shops: shops.length, applications: applications.length, directoryRecordsWithoutAccount: orphans.length }, distribution: dist, subtypes: sub, orphanRegistryRecords: orphans, rows: rows.sort((x, y) => x.state.localeCompare(y.state) || String(x.name).localeCompare(String(y.name))) };
  out.digest = sha(out.rows);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'remediation-census.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ at, population: out.population, distribution: dist, digest: out.digest }, null, 1));
  process.exit(0);
})().catch((e) => { console.error('CENSUS FAILED', e.stack || e.message); process.exit(2); });
