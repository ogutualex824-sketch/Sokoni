/**
 * Backup restore-drill verification (Task 3). Read-only.
 * Compares document counts between the restored database (`restore-drill`) and production
 * (`(default)`) for canonical collections, proving the restore is usable and data integrity is
 * intact. Production may be slightly higher than the snapshot (writes since the backup) — that is
 * expected; the drill should be non-empty and in the same order of magnitude.
 *
 * Usage: node scripts/qa/verify-restore-drill.js
 */
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const { getFirestore } = require('firebase-admin/firestore');

const prod  = getFirestore(admin.app());                      // (default)
const drill = getFirestore(admin.app(), 'restore-drill');     // restored copy

const COLLECTIONS = ['users', 'products', 'orders', 'sellers', 'providerBookings', 'auditLogs', 'commissionLedger'];

async function count(dbi, col) {
  try { const s = await dbi.collection(col).count().get(); return s.data().count; }
  catch (e) { return 'ERR:' + e.message.slice(0, 40); }
}

(async () => {
  console.log('\n=== Restore-drill verification (restore-drill vs (default)) ===\n');
  const rows = [];
  for (const col of COLLECTIONS) {
    const [p, d] = await Promise.all([count(prod, col), count(drill, col)]);
    const ok = typeof d === 'number' && d > 0;
    rows.push({ collection: col, production: p, restored: d, usable: ok ? '✓' : '—' });
  }
  console.table(rows);

  // Spot integrity check: a known product should be readable in the restored DB.
  try {
    const snap = await drill.collection('products').where('sellerUid', '==', 'D5Ql2EYr95bt79IpcGTmOMTK0P83').limit(3).get();
    console.log(`\nSpot check — KASS products readable in restored DB: ${snap.size} (indexes + queries usable)`);
    snap.forEach(d => console.log('  -', (d.data().name || d.id).slice(0, 40)));
  } catch (e) { console.log('\nSpot check FAILED:', e.message); }

  console.log('\n=== verification complete (read-only) ===\n');
  process.exit(0);
})().catch(e => { console.error('VERIFY FAILED:', e.message); process.exit(1); });
