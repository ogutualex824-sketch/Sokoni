'use strict';
/* Quick admin-claims check — is the browser token that reads `payments` actually admin?
 *   node functions/scripts/probe-admin-claims-quick.js
 * Read-only. */
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26' });

const EMAILS = ['ogutualex824@gmail.com', 'admin@mysokoni.co.ke', 'ceo@mysokoni.co.ke', 'ochisaac@gmail.com'];

(async () => {
  for (const email of EMAILS) {
    try {
      const u = await admin.auth().getUserByEmail(email);
      const c = u.customClaims || {};
      const isAdmin = c.admin === true || c.superAdmin === true;
      console.log(`${email.padEnd(28)} uid=${u.uid.slice(0,10)}  admin=${!!c.admin} superAdmin=${!!c.superAdmin}  => isAdmin(rules)=${isAdmin}  lastRefresh=${u.tokensValidAfterTime||'n/a'}`);
    } catch (e) {
      console.log(`${email.padEnd(28)} NOT FOUND / ERR: ${e.code || e.message}`);
    }
  }
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
