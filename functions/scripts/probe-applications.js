'use strict';
/**
 * Applications collection probe — production ground truth.
 *
 *   node functions/scripts/probe-applications.js
 *
 * Written for the 2026-08-01 P0 where the admin Applications panel was blank.
 * The first question is always 'is Firestore actually empty?', and answering it
 * by reading the panel is circular. This answers it from the server, and prints
 * the exact query shapes the three consoles use so an ordering trap shows up as
 * a row count instead of an empty screen.
 *
 * Read-only. Writes nothing.
 */
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();

(async () => {
  const snap = await db.collection('applications').get();
  console.log('applications total docs:', snap.size);

  const byStatus = {}, byRole = {}, missing = { createdAt: 0, updatedAt: 0, status: 0, role: 0 };
  const rows = [];
  snap.forEach(d => {
    const x = d.data();
    byStatus[x.status || '(absent)'] = (byStatus[x.status || '(absent)'] || 0) + 1;
    byRole[x.role || x.applicationType || '(absent)'] = (byRole[x.role || x.applicationType || '(absent)'] || 0) + 1;
    if (x.createdAt === undefined) missing.createdAt++;
    if (x.updatedAt === undefined) missing.updatedAt++;
    if (x.status === undefined) missing.status++;
    if (x.role === undefined) missing.role++;
    rows.push({
      id: d.id.slice(0, 20),
      status: x.status, role: x.role || x.applicationType,
      name: (x.businessName || x.name || x.fullName || '').slice(0, 24),
      phone: x.phone || x.phoneNumber || '',
      createdAt: x.createdAt ? 'yes' : 'NO', updatedAt: x.updatedAt ? 'yes' : 'NO',
      projectionStatus: x.projectionStatus,
    });
  });

  console.log('\nby status :', JSON.stringify(byStatus));
  console.log('by role   :', JSON.stringify(byRole));
  console.log('missing   :', JSON.stringify(missing));

  console.log('\n-- rows --');
  rows.slice(0, 25).forEach(r => console.log(' ', JSON.stringify(r)));

  /* The exact queries each console issues. */
  console.log('\n=== query shapes each console uses ===');
  const lim = await db.collection('applications').limit(300).get();
  console.log('collection(applications).limit(300)                 ->', lim.size);
  for (const f of ['createdAt', 'updatedAt', 'submittedAt']) {
    try {
      const s = await db.collection('applications').orderBy(f, 'desc').limit(300).get();
      console.log(`orderBy(${f},desc).limit(300)`.padEnd(50), '->', s.size,
        s.size < snap.size ? '  <-- DROPS ' + (snap.size - s.size) + ' docs missing this field' : '');
    } catch (e) { console.log(`orderBy(${f})`.padEnd(50), '-> ERROR', e.code || e.message); }
  }
  for (const st of ['pending', 'approved', 'rejected', 'archived']) {
    const s = await db.collection('applications').where('status', '==', st).get();
    console.log(`where(status==${st})`.padEnd(50), '->', s.size);
  }

  process.exit(0);
})().catch(e => { console.error('FAILED:', e.code || '', e.message); process.exit(1); });
