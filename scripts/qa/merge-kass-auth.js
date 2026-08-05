/* merge-kass-auth.js — STEP 2 of the KASS account merge: move the phone number to the canonical
   Google account so BOTH logins (phone + Google) resolve to D5Ql2.
   Non-destructive: removes the phone from the (now data-empty) phone account and adds it to the
   canonical account. The phone account is left in place (provider-less, orphaned) — NOT deleted.
   Run merge-kass-data.js FIRST. USAGE: node scripts/qa/merge-kass-auth.js */
'use strict';
const admin = require('../../functions/node_modules/firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const auth = admin.auth();

const FROM  = 'xrH21J5GFbW8PluCZ2ny5nIuf602';   // phone account (data already migrated)
const TO    = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';   // Google account (canonical)
const PHONE = '+254705726803';

(async () => {
  const before = await auth.getUser(TO);
  console.log('TO before → providers:', (before.providerData || []).map(p => p.providerId).join(','), '| phone:', before.phoneNumber || 'none');

  // 1 — free the phone from FROM (leaves FROM provider-less; not deleted)
  await auth.updateUser(FROM, { phoneNumber: null });
  console.log('phone removed from FROM (xrH) — freed');

  // 2 — attach the phone to the canonical account
  await auth.updateUser(TO, { phoneNumber: PHONE });
  console.log('phone', PHONE, 'attached to TO (D5Ql2)');

  const after = await auth.getUser(TO);
  console.log('TO after  → providers:', (after.providerData || []).map(p => p.providerId).join(','), '| phone:', after.phoneNumber);
  console.log('\nDONE. Both phone (' + PHONE + ') and Google now resolve to D5Ql2.');
  console.log('The user must LOG OUT and log back in (phone or Google) to get the merged session.');
})().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.code, '-', e.message); process.exit(1); });
