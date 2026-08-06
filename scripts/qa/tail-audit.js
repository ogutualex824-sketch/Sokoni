/**
 * READ-ONLY: print the most recent auditLogs entries — to verify the "Auditable" exit criterion
 * during device testing. After a refund/stock-adjust/price-change/reprint/role-change, run this and
 * paste the entry into VALIDATION_EVIDENCE.md.
 *
 * Usage:
 *   node scripts/qa/tail-audit.js               # last 15 entries (any action)
 *   node scripts/qa/tail-audit.js pos.refund    # filter by action
 *   node scripts/qa/tail-audit.js pos.refund 30 # + custom limit
 */
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();

const ACTION = process.argv[2] && !/^\d+$/.test(process.argv[2]) ? process.argv[2] : null;
const LIMIT  = Number(process.argv[3] || (/^\d+$/.test(process.argv[2] || '') ? process.argv[2] : 15));

(async () => {
  let q = db.collection('auditLogs').orderBy('ts', 'desc').limit(LIMIT);
  if (ACTION) q = db.collection('auditLogs').where('action', '==', ACTION).orderBy('ts', 'desc').limit(LIMIT);
  const snap = await q.get().catch(async (e) => {
    // If the composite (action + ts) index is missing, fall back to an unordered action filter.
    if (ACTION) { console.log('(ordered query needs an index; showing unordered)\n'); return db.collection('auditLogs').where('action', '==', ACTION).limit(LIMIT).get(); }
    throw e;
  });
  console.log(`\n=== ${snap.size} audit entr${snap.size === 1 ? 'y' : 'ies'}${ACTION ? ' for ' + ACTION : ''} ===\n`);
  snap.forEach((d) => {
    const a = d.data() || {};
    const _t = a.ts != null ? a.ts : a.timestamp;
    const when = _t && _t.toDate ? _t.toDate().toISOString()
      : typeof _t === 'number' ? new Date(_t).toISOString()
      : typeof _t === 'string' ? _t : '(no ts)';
    console.log(`${when}  ${a.action || '?'}`);
    console.log(`   actor=${a.actorUid || '?'} role=${a.actorRole || '-'} branch=${a.branchId || '-'} object=${a.objectType || '-'}/${a.objectId || '-'} outcome=${a.outcome || '-'}`);
    if (a.before != null || a.after != null) console.log(`   before=${JSON.stringify(a.before)} after=${JSON.stringify(a.after)}${a.delta != null ? ' delta=' + a.delta : ''}`);
    if (a.reason) console.log(`   reason=${a.reason}`);
    if (a.metadata && Object.keys(a.metadata).length) console.log(`   metadata=${JSON.stringify(a.metadata)}`);
    console.log('');
  });
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
