/* test-entertainment-rules.js — Entertainment convergence + event settlement rules on a REAL emulator.
 *
 * Loads the SERVED rules text (firestore.rules.build) explicitly — `emulators:exec` loads no rules
 * and defaults to allow-all. A COUNTERPROOF re-runs every denial under allow-all rules and requires
 * it to flip, so "denied" is evidence and not a harness artefact.
 *
 * PROVES
 *   legacy EntHub  a client can no longer mint an entTickets doc (was: 'valid', own price, no payment)
 *                  a client can no longer create an instantly-published entEvents doc
 *                  a venue / artist profile is created PENDING; the owner cannot flip its status
 *                  (noAdminFields() never covered `status` — self-approval) — ordinary edits still work
 *   events         eventSettlements: organizer reads OWN, stranger denied, nobody writes
 *                  eventExceptions: admin-only read · eventOrders / eventTickets: no client write
 *
 * Fails CLOSED without FIRESTORE_EMULATOR_HOST (never falls back to :8080).
 *   node scripts/run-entertainment-rules.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('@firebase/rules-unit-testing');

const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!FS_HOST) { console.error('REFUSING: FIRESTORE_EMULATOR_HOST must be set (use scripts/run-entertainment-rules.js)'); process.exit(2); }
const [fh, fp] = FS_HOST.split(':');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 90) + ']' : '')); ok ? pass++ : fail++; };
const denied = async (p) => { try { await T.assertFails(p); return true; } catch (_) { return false; } };
const allowed = async (p) => { try { await T.assertSucceeds(p); return true; } catch (_) { return false; } };

async function suite(env, label, served) {
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore(); const f = (p, d) => db.doc(p).set(d);
    await f('entVenues/v1', { uid: 'owner1', name: 'Hall', status: 'pending' });
    await f('entArtists/a1', { uid: 'owner1', name: 'DJ', status: 'pending' });
    await f('eventSettlements/PAY1', { organizerUid: 'org1', status: 'HELD', organizerNetCents: 100 });
    await f('eventExceptions/x1', { kind: 'partial_refund', status: 'OPEN' });
    await f('eventOrders/o1', { buyerUid: 'buyer1', status: 'pending_payment' });
    await f('users/admin1', { role: 'admin' });
  });
  const owner = env.authenticatedContext('owner1').firestore();
  const buyer = env.authenticatedContext('buyer1').firestore();
  const org = env.authenticatedContext('org1').firestore();
  const stranger = env.authenticatedContext('stranger').firestore();

  /* expectDeny: denied under SERVED rules; under the allow-all counterproof the same op must SUCCEED. */
  const expectDeny = async (name, p) => { if (served) ck(`${label}: ${name} DENIED`, await denied(p)); else ck(`${label}: ${name} flips to ALLOWED under allow-all`, await allowed(p)); };

  await expectDeny('client mints a VALID entTickets doc (own price, no payment)',
    buyer.doc('entTickets/t1').set({ uid: 'buyer1', eventId: 'e1', status: 'valid', price: 1, organizerUid: 'x' }));
  await expectDeny('client creates an instantly published entEvents doc',
    owner.doc('entEvents/e1').set({ uid: 'owner1', title: 'Gig', status: 'published' }));
  await expectDeny('venue created ACTIVE (skipping review)',
    owner.doc('entVenues/v2').set({ uid: 'owner1', name: 'Roof', status: 'active' }));
  await expectDeny('owner flips own venue to active',
    owner.doc('entVenues/v1').update({ status: 'active' }));
  await expectDeny('artist profile created APPROVED',
    owner.doc('entArtists/a2').set({ uid: 'owner1', name: 'MC', status: 'approved' }));
  await expectDeny('owner flips own artist profile to approved',
    owner.doc('entArtists/a1').update({ status: 'approved' }));
  await expectDeny('stranger reads another organizer\'s settlement', stranger.doc('eventSettlements/PAY1').get());
  await expectDeny('organizer WRITES their own settlement (e.g. inflates net)',
    org.doc('eventSettlements/PAY1').update({ organizerNetCents: 999999 }));
  await expectDeny('user reads eventExceptions', buyer.doc('eventExceptions/x1').get());
  await expectDeny('buyer marks own order paid', buyer.doc('eventOrders/o1').update({ status: 'paid' }));
  await expectDeny('buyer writes an eventTickets doc', buyer.doc('eventTickets/k1').set({ buyerUid: 'buyer1', status: 'valid' }));

  if (served) {
    ck(`${label}: venue created PENDING is allowed (the product still works)`,
      await allowed(owner.doc('entVenues/v3').set({ uid: 'owner1', name: 'Garden', status: 'pending' })));
    ck(`${label}: owner edits own venue WITHOUT touching status`,
      await allowed(owner.doc('entVenues/v1').update({ name: 'Hall B' })));
    ck(`${label}: artist profile created PENDING is allowed`,
      await allowed(owner.doc('entArtists/a3').set({ uid: 'owner1', name: 'Band', status: 'pending' })));
    ck(`${label}: organizer reads OWN settlement`, await allowed(org.doc('eventSettlements/PAY1').get()));
    ck(`${label}: buyer reads own order`, await allowed(buyer.doc('eventOrders/o1').get()));
  }
}

(async () => {
  const fsRules = fs.readFileSync(path.join(ROOT, 'firestore.rules.build'), 'utf8');
  ck('served rules text loaded (not the emulator default)', fsRules.includes('match /eventSettlements/{paymentRef}') && fsRules.includes('match /entTickets/{ticketId}'));
  const env = await T.initializeTestEnvironment({ projectId: 'demo-ent-rules', firestore: { host: fh, port: Number(fp), rules: fsRules } });
  await suite(env, 'SERVED', true);
  await env.clearFirestore(); await env.cleanup();
  const open = "rules_version = '2';\nservice cloud.firestore { match /databases/{d}/documents { match /{x=**} { allow read, write: if true; } } }";
  const env2 = await T.initializeTestEnvironment({ projectId: 'demo-ent-rules-open', firestore: { host: fh, port: Number(fp), rules: open } });
  await suite(env2, 'COUNTERPROOF', false);
  await env2.cleanup();
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS CRASHED', e); process.exit(2); });
