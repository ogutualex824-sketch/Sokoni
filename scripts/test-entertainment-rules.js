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
 *   events ops     PIN secrets + PIN index unreadable by anyone (admins included) · staff assignments,
 *                  invitations, admissions, audit, sales, sale / card-ref claims, receivables and
 *                  refund requests: NO client write · reads admin-only, refund requests buyer-own
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
    await f('eventTicketSecrets/k1', { pin: 'ABCD-EFGH', buyerUid: 'buyer1' });
    await f('eventPinAttempts/e1_buyer1', { fails: 10 });
    await f('eventTicketPins/e1_abc', { eventId: 'e1', ticketId: 'k1' });
    await f('eventStaff/e1_till1', { uid: 'till1', eventId: 'e1', role: 'cashier', active: true, organizerUid: 'org1' });
    await f('eventStaffInvites/e1_x', { eventId: 'e1', email: 'till1@x.co', role: 'cashier', status: 'pending', organizerUid: 'org1' });
    await f('eventAdmissions/k1', { ticketId: 'k1', eventId: 'e1', admittedBy: 'gate1' });
    await f('eventOpsAudit/a1', { action: 'event_staff_invited', eventId: 'e1' });
    await f('eventSales/s1', { eventId: 'e1', organizerUid: 'org1', cashierUid: 'till1', status: 'COMPLETED', grossCents: 200000 });
    await f('eventCommissionReceivables/s1', { saleId: 's1', organizerUid: 'org1', amountCents: 6000, collectedCents: 0, status: 'OUTSTANDING' });
    await f('eventRefundRequests/o1', { orderId: 'o1', buyerUid: 'buyer1', status: 'PENDING_REVIEW' });
  });
  const till = env.authenticatedContext('till1', { email: 'till1@x.co', email_verified: true }).firestore();
  const admin = env.authenticatedContext('admin1', { admin: true }).firestore();
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
  await expectDeny('buyer reads a RAW ticket PIN (eventTicketSecrets)', buyer.doc('eventTicketSecrets/k1').get());
  await expectDeny('a user writes themselves an event staff assignment', buyer.doc('eventStaff/e1_buyer1').set({ uid: 'buyer1', role: 'admission', active: true }));
  await expectDeny('a user resets the PIN-attempt lockout', buyer.doc('eventPinAttempts/e1_buyer1').set({ fails: 0 }));
  /* Events ops P1-P6 collections — every write is server-only; reads are admin-only or owner-scoped. */
  await expectDeny('buyer reads the PIN hash index (eventTicketPins)', buyer.doc('eventTicketPins/e1_abc').get());
  await expectDeny('buyer plants a PIN index entry for a ticket', buyer.doc('eventTicketPins/e1_zzz').set({ eventId: 'e1', ticketId: 'k1' }));
  await expectDeny('staff member reads own assignment doc directly', till.doc('eventStaff/e1_till1').get());
  await expectDeny('staff member extends own access (endAt)', till.doc('eventStaff/e1_till1').update({ role: 'manager' }));
  await expectDeny('organizer writes a staff invitation directly (bypassing role/expiry checks)', org.doc('eventStaffInvites/e1_y').set({ eventId: 'e1', email: 'a@b.co', role: 'manager', status: 'pending' }));
  await expectDeny('invitee reads invitations', till.doc('eventStaffInvites/e1_x').get());
  await expectDeny('buyer self-admits (writes eventAdmissions)', buyer.doc('eventAdmissions/k2').set({ ticketId: 'k2', eventId: 'e1' }));
  await expectDeny('organizer reads admissions directly', org.doc('eventAdmissions/k1').get());
  await expectDeny('organizer reads the event ops audit', org.doc('eventOpsAudit/a1').get());
  await expectDeny('anyone writes the event ops audit', admin.doc('eventOpsAudit/a2').set({ action: 'x' }));
  await expectDeny('cashier records a COMPLETED sale directly', till.doc('eventSales/s2').set({ eventId: 'e1', cashierUid: 'till1', status: 'COMPLETED', grossCents: 1 }));
  await expectDeny('cashier reads a sale directly', till.doc('eventSales/s1').get());
  await expectDeny('cashier claims a sale idempotency key', till.doc('eventSaleClaims/e1_k').set({ saleId: 's9' }));
  await expectDeny('organizer reserves a card reference', org.doc('eventCardRefClaims/org1__kcb__REF1').set({ saleId: 's9' }));
  await expectDeny('organizer marks own commission receivable COLLECTED', org.doc('eventCommissionReceivables/s1').update({ status: 'COLLECTED', collectedCents: 6000 }));
  await expectDeny('organizer reads receivables directly', org.doc('eventCommissionReceivables/s1').get());
  await expectDeny('buyer files a refund request directly (bypassing the wizard server)', buyer.doc('eventRefundRequests/o2').set({ orderId: 'o2', buyerUid: 'buyer1', status: 'PENDING_REVIEW' }));
  await expectDeny('buyer approves own refund request', buyer.doc('eventRefundRequests/o1').update({ status: 'REFUNDED' }));
  await expectDeny('stranger reads another buyer\'s refund request', stranger.doc('eventRefundRequests/o1').get());

  if (served) {
    ck(`${label}: venue created PENDING is allowed (the product still works)`,
      await allowed(owner.doc('entVenues/v3').set({ uid: 'owner1', name: 'Garden', status: 'pending' })));
    ck(`${label}: owner edits own venue WITHOUT touching status`,
      await allowed(owner.doc('entVenues/v1').update({ name: 'Hall B' })));
    ck(`${label}: artist profile created PENDING is allowed`,
      await allowed(owner.doc('entArtists/a3').set({ uid: 'owner1', name: 'Band', status: 'pending' })));
    ck(`${label}: organizer reads OWN settlement`, await allowed(org.doc('eventSettlements/PAY1').get()));
    ck(`${label}: buyer reads own order`, await allowed(buyer.doc('eventOrders/o1').get()));
    ck(`${label}: buyer reads OWN refund request`, await allowed(buyer.doc('eventRefundRequests/o1').get()));
    ck(`${label}: admin reads sales, admissions, receivables, ops audit`, (await allowed(admin.doc('eventSales/s1').get())) && (await allowed(admin.doc('eventAdmissions/k1').get())) && (await allowed(admin.doc('eventCommissionReceivables/s1').get())) && (await allowed(admin.doc('eventOpsAudit/a1').get())));
    ck(`${label}: even an admin cannot read a raw PIN or the PIN index`, (await denied(admin.doc('eventTicketSecrets/k1').get())) && (await denied(admin.doc('eventTicketPins/e1_abc').get())));
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
