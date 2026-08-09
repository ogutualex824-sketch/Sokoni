'use strict';
/**
 * users collection — what is ACTUALLY stored.
 *
 *   node functions/scripts/probe-users-schema.js
 *
 * Written before wiring the admin Users pane to Firestore. Designing a role
 * filter against a field that does not exist produces a pane that looks correct
 * and silently matches nothing — the same class of failure as the blank
 * Applications panel. So: measure the schema, then build to it.
 *
 * Read-only.
 */

const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'sokoni-aeb26' });
const db = admin.firestore();

(async () => {
  const snap = await db.collection('users').get();
  console.log('users documents: ' + snap.size + '\n');

  const present = {};      /* field -> count */
  const types   = {};      /* field -> Set of types */
  const roleVals = {};     /* value -> count, from every role-ish field */
  let withRolesArray = 0, withRoleString = 0, withNeither = 0;

  snap.forEach(d => {
    const x = d.data();
    for (const [k, v] of Object.entries(x)) {
      present[k] = (present[k] || 0) + 1;
      const t = Array.isArray(v) ? 'array' : (v && v.toDate ? 'timestamp' : typeof v);
      (types[k] = types[k] || new Set()).add(t);
    }
    if (Array.isArray(x.roles) && x.roles.length) {
      withRolesArray++;
      x.roles.forEach(r => { roleVals['roles[]:' + r] = (roleVals['roles[]:' + r] || 0) + 1; });
    }
    if (typeof x.role === 'string' && x.role) {
      withRoleString++;
      roleVals['role:' + x.role] = (roleVals['role:' + x.role] || 0) + 1;
    }
    if (!(Array.isArray(x.roles) && x.roles.length) && !x.role) withNeither++;
  });

  const rows = Object.entries(present).sort((a, b) => b[1] - a[1]);
  console.log('field'.padEnd(26) + 'docs'.padEnd(7) + 'coverage'.padEnd(11) + 'types');
  console.log('-'.repeat(70));
  rows.forEach(([k, n]) => {
    console.log(k.padEnd(26) + String(n).padEnd(7)
      + (Math.round(n / snap.size * 100) + '%').padEnd(11)
      + [...types[k]].join('|'));
  });

  console.log('\nROLE SHAPE');
  console.log('-'.repeat(70));
  console.log('  roles[] present : ' + withRolesArray + '/' + snap.size);
  console.log('  role string     : ' + withRoleString + '/' + snap.size);
  console.log('  NEITHER         : ' + withNeither + '/' + snap.size
    + (withNeither ? '   <-- these match no role filter' : ''));
  console.log('\n  distinct role values:');
  Object.entries(roleVals).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log('    ' + k.padEnd(30) + v));

  /* Fields the admin pane wants. Report what is missing rather than inventing it. */
  console.log('\nFIELDS THE ADMIN PANE NEEDS');
  console.log('-'.repeat(70));
  const wanted = ['name', 'displayName', 'email', 'phone', 'phoneNumber', 'city', 'location',
                  'createdAt', 'joined', 'updatedAt', 'suspended', 'verified', 'status',
                  'photoURL', 'roles', 'role'];
  wanted.forEach(f => {
    const n = present[f] || 0;
    console.log('  ' + f.padEnd(16) + String(n).padEnd(6)
      + (n === 0 ? 'ABSENT — do not filter or sort on this'
        : n < snap.size ? 'partial (' + Math.round(n / snap.size * 100) + '%)'
        : 'complete'));
  });

  /* orderBy drops documents missing the ordering field entirely. */
  console.log('\nORDERING SAFETY');
  console.log('-'.repeat(70));
  for (const f of ['createdAt', 'updatedAt', 'joined']) {
    try {
      const s = await db.collection('users').orderBy(f, 'desc').limit(500).get();
      console.log('  orderBy(' + f + ')'.padEnd(22) + s.size + '/' + snap.size
        + (s.size < snap.size ? '   <-- DROPS ' + (snap.size - s.size) + ' documents' : '   safe'));
    } catch (e) { console.log('  orderBy(' + f + ') -> ' + (e.code || e.message)); }
  }

  process.exit(0);
})().catch(e => { console.error('FAILED:', e.code || '', e.message); process.exit(1); });
