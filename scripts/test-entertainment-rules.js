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
    await f('entArtists/a1', { uid: 'owner1', name: 'DJ', status: 'pending', phone: '0712345678', email: 'dj@x.co' });
    await f('entArtists/a2', { uid: 'owner2', name: 'Band', status: 'approved', phone: '0799999999' });
    await f('entReviews/r1', { uid: 'owner2', rating: 5, status: 'pending' });
    await f('venues/cv1', { ownerId: 'owner1', name: 'Hall', status: 'suspended', rating: 3.1, reviewCount: 4 });
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
    await f('eventTicketNumbers/SK-EVT-2026-000184', { eventId: 'e1', ticketId: 'k1' });
    await f('eventFiscal/PAY1', { saleKey: 'PAY1', eventId: 'e1', organizerUid: 'org1', status: 'SUBMITTED', invoiceId: 'inv1' });
    await f('eventFiscalReversals/cn1', { executionId: 'cn1', fiscalRecordId: 'PAY1', organizerUid: 'org1', status: 'CREDIT_NOTE_PENDING', creditNoteReference: null });
    await f('etimsInvoices/inv1', { sellerUid: 'org1', status: 'pending_submission', receiptNumber: null, totals: { totAmt: 2000 } });
    await f('users/buyer1', { uid: 'buyer1', roles: ['buyer'], displayName: 'B' });
    await f('users/org1', { uid: 'org1', roles: ['buyer', 'event_organizer'], displayName: 'O' });
    await f('applications/app1', { uid: 'buyer1', role: 'event_organizer_applicant', status: 'pending' });
    await f('applicationDecisions/app1', { status: 'rejected', decidedBy: 'admin1' });
    await f('eventPromoCodes/pc1', { eventId: 'e1', code: 'JAZZ20', discountValue: 20 });
    await f('entBookings/svc_b1', { envId: 'svc_b1', buyerUid: 'buyer1', providerUid: 'owner1', bookingRef: 'BK-ART-2026-000001', pin: { hash: 'h' } });
    await f('entBookingSecrets/svc_b1', { envId: 'svc_b1', pin: '4827', buyerUid: 'buyer1' });
    await f('entBookingRefs/BK-ART-2026-000001', { envId: 'svc_b1' });
    await f('entBookingPinAttempts/svc_b1_owner1', { fails: 2 });
    await f('bookings/vk1', { venueId: 'cv1', ownerId: 'owner1', customerId: 'buyer1', status: 'confirmed', date: '2026-10-01' });
    await f('venueSettlements/VB-1', { ownerUid: 'owner1', netCents: 940000, status: 'HELD' });
    /* availability authority / rate cards / enquiries / call requests (2026-09-27) */
    await f('entAvailability/svc_owner1', { calKey: 'svc_owner1', ownerUid: 'owner1' });
    await f('entAvailability/svc_owner1/months/2026-10', { items: [{ id: 'blk_1', k: 'X', s: 1, e: 2, label: 'Private wedding' }] });
    await f('entAvailabilityPublic/svc_owner1_2026-10', { calKey: 'svc_owner1', month: '2026-10', rev: 3 });
    await f('entRateCards/rc1', { ownerUid: 'owner1', calKey: 'svc_owner1', visibility: 'PRIVATE', name: 'VIP' });
    await f('entRateCards/rc1/versions/1', { version: 1, priceCents: 500000 });
    await f('entQuotes/q1', { ownerUid: 'owner1', buyerUid: 'buyer1', status: 'SENT', finalCents: 100 });
    await f('entEnquiries/en1', { providerUid: 'owner1', buyerUid: 'buyer1', status: 'OPEN', question: 'hi' });
    await f('entMessagingSettings/owner1', { whoCanMessage: 'ANYONE', templates: { WELCOME: 'Hi' } });
    await f('entBlocks/owner1_buyer1', { providerUid: 'owner1', userUid: 'buyer1' });
    await f('entCallRequests/cr1', { requesterUid: 'buyer1', recipientUid: 'owner1', status: 'REQUESTED' });
    await f('mktCouponCodes/cp1', { merchantId: 'owner1', code: 'OCT10', type: 'percent', value: 10, status: 'active' });
    await f('bookingHolds/h1', { userId: 'buyer1', venueId: 'cv1', expiresAt: 9e12 });
    await f('venueBlockouts/vb1', { venueId: 'cv1', createdBy: 'owner1', reason: 'private', note: 'CEO party' });
    await f('providerCalendar/pc1', { providerId: 'owner1', customerName: 'Achieng Otieno' });
    await f('availabilityStatus/owner1', { isOpen: true, liveStatus: 'available' });
    await f('bookings/prop1', { customerId: 'buyer1', hub: 'property', status: 'pending' });
  });
  const till = env.authenticatedContext('till1', { email: 'till1@x.co', email_verified: true }).firestore();
  const admin = env.authenticatedContext('admin1', { admin: true }).firestore();
  const owner = env.authenticatedContext('owner1').firestore();
  const buyer = env.authenticatedContext('buyer1').firestore();
  const org = env.authenticatedContext('org1').firestore();
  const stranger = env.authenticatedContext('stranger').firestore();
  /* isActive() reads token.deactivated; a token WITHOUT that claim errors -> deny for every clause (see the
     positive control). The booking-conversation denials use an actor whose isActive() is TRUE, so only the
     reserved-id / type clauses decide. */
  const member = env.authenticatedContext('member1', { deactivated: false }).firestore();

  /* expectDeny: denied under SERVED rules; under the allow-all counterproof the same op must SUCCEED. */
  const expectDeny = async (name, p) => { if (served) ck(`${label}: ${name} DENIED`, await denied(p)); else ck(`${label}: ${name} flips to ALLOWED under allow-all`, await allowed(p)); };

  /* ── Entertainment booking identity + venue rail (convergence Slice A) ── */
  await expectDeny('a stranger reads a booking envelope', stranger.doc('entBookings/svc_b1').get());
  await expectDeny('the PROVIDER reads the raw booking PIN of the buyer', owner.doc('entBookingSecrets/svc_b1').get());
  await expectDeny('a stranger reads the raw booking PIN', stranger.doc('entBookingSecrets/svc_b1').get());
  await expectDeny('the buyer forges their booking as verified', buyer.doc('entBookings/svc_b1').update({ verification: { state: 'VERIFIED' } }));
  await expectDeny('anyone writes a booking PIN secret', buyer.doc('entBookingSecrets/svc_b1').set({ pin: '0000', buyerUid: 'buyer1' }));
  await expectDeny('anyone reads the booking-reference index', buyer.doc('entBookingRefs/BK-ART-2026-000001').get());
  await expectDeny('the provider resets their own wrong-PIN counter', owner.doc('entBookingPinAttempts/svc_b1_owner1').set({ fails: 0 }));
  await expectDeny('a client pre-creates a booking conversation id (participant substitution)', member.doc('conversations/ent_booking_svc_b1').set({ participants: ['member1', 'owner1'], transactionType: 'x' }));
  await expectDeny('a client creates an ent_booking-typed conversation under another id', member.doc('conversations/c123').set({ participants: ['member1', 'owner1'], transactionType: 'ent_booking' }));
  await expectDeny('the venue owner marks a booking checked-in directly (skipping the PIN)', owner.doc('bookings/vk1').update({ status: 'active', checkIn: { time: 1 } }));
  await expectDeny('the customer moves the booking date directly', buyer.doc('bookings/vk1').update({ date: '2026-12-25' }));
  await expectDeny('a stranger reads a venue settlement', stranger.doc('venueSettlements/VB-1').get());
  await expectDeny('the owner forges a settlement release', owner.doc('venueSettlements/VB-1').update({ status: 'RELEASED' }));
  /* ── availability authority · rate cards · enquiries · call requests (2026-09-27) ── */
  await expectDeny('a stranger reads a provider\'s private occupancy (bookings, blocks, labels)', stranger.doc('entAvailability/svc_owner1/months/2026-10').get());
  await expectDeny('even the OWNER cannot read or write the occupancy directly (audited callables only)', owner.doc('entAvailability/svc_owner1/months/2026-10').set({ items: [] }));
  await expectDeny('a client forges an availability item (direct Firestore availability write)', member.doc('entAvailability/svc_owner1/months/2026-11').set({ items: [{ id: 'x', k: 'X' }] }));
  await expectDeny('a client bumps / rewrites the public availability signal', member.doc('entAvailabilityPublic/svc_owner1_2026-10').set({ rev: 999 }));
  await expectDeny('a stranger reads another provider\'s rate card', stranger.doc('entRateCards/rc1').get());
  await expectDeny('…or its price versions', stranger.doc('entRateCards/rc1/versions/1').get());
  await expectDeny('the owner flips a PRIVATE rate to PUBLIC directly', owner.doc('entRateCards/rc1').update({ visibility: 'PUBLIC' }));
  await expectDeny('the owner rewrites a price version (versions are immutable)', owner.doc('entRateCards/rc1/versions/1').update({ priceCents: 1 }));
  await expectDeny('a stranger reads a quote', stranger.doc('entQuotes/q1').get());
  await expectDeny('the buyer marks a quote ACCEPTED directly', buyer.doc('entQuotes/q1').update({ status: 'ACCEPTED' }));
  await expectDeny('a stranger reads an enquiry', stranger.doc('entEnquiries/en1').get());
  await expectDeny('a client creates an enquiry directly (bypassing the rate limits)', member.doc('entEnquiries/en2').set({ providerUid: 'owner1', buyerUid: 'member1', status: 'OPEN' }));
  await expectDeny('a party moves the enquiry state (fake status)', buyer.doc('entEnquiries/en1').update({ status: 'CONVERTED' }));
  await expectDeny('a client pre-creates an ENQUIRY conversation id', member.doc('conversations/ent_enquiry_en9').set({ participants: ['member1', 'owner1'], transactionType: 'x' }));
  await expectDeny('a client creates an ent_enquiry-typed conversation under another id', member.doc('conversations/c_enq').set({ participants: ['member1', 'owner1'], transactionType: 'ent_enquiry' }));
  await expectDeny('another user reads a provider\'s messaging settings / templates', stranger.doc('entMessagingSettings/owner1').get());
  await expectDeny('the provider disables transactional messaging by writing settings directly', owner.doc('entMessagingSettings/owner1').set({ whoCanMessage: 'NOBODY', transactional: false }));
  await expectDeny('a blocked user deletes their block', buyer.doc('entBlocks/owner1_buyer1').delete());
  await expectDeny('a client fakes a call authorization (creates an ACCEPTED call request)', member.doc('entCallRequests/cr9').set({ requesterUid: 'member1', recipientUid: 'owner1', status: 'ACCEPTED' }));
  await expectDeny('a stranger reads someone\'s call request', stranger.doc('entCallRequests/cr1').get());
  await expectDeny('any signed-in user lists another merchant\'s coupon codes', stranger.doc('mktCouponCodes/cp1').get());
  await expectDeny('a client creates a hold on a venue\'s time (any expiry)', member.doc('bookingHolds/h9').set({ userId: 'member1', venueId: 'cv1', expiresAt: 9e12 }));
  await expectDeny('a stranger reads a venue\'s block reasons and notes', stranger.doc('venueBlockouts/vb1').get());
  await expectDeny('the owner writes a legacy blockout the authority would never see', owner.doc('venueBlockouts/vb9').set({ venueId: 'cv1', createdBy: 'owner1' }));
  await expectDeny('a stranger reads the provider calendar mirror (customer names)', stranger.doc('providerCalendar/pc1').get());
  await expectDeny('the owner spoofs their public open / closed status', owner.doc('availabilityStatus/owner1').set({ isOpen: true, liveStatus: 'available' }));
  await expectDeny('a client creates a VENUE booking directly (skipping the availability authority)', member.doc('bookings/vk9').set({ customerId: 'member1', venueId: 'cv1', ownerId: 'owner1', startTs: 1, endTs: 2, status: 'pending' }));
  await expectDeny('the customer cancels a VENUE booking directly (skipping refund + slot release)', buyer.doc('bookings/vk1').update({ status: 'cancelled', cancelReason: 'plans changed' }));
  if (served) {
    ck(`${label}: anyone reads the public availability COUNTER`, await allowed(stranger.doc('entAvailabilityPublic/svc_owner1_2026-10').get()));
    ck(`${label}: the owner reads their own rate card; the buyer their own quote and enquiry`, (await allowed(owner.doc('entRateCards/rc1').get())) && (await allowed(buyer.doc('entQuotes/q1').get())) && (await allowed(buyer.doc('entEnquiries/en1').get())));
    ck(`${label}: the merchant reads their own coupon`, await allowed(owner.doc('mktCouponCodes/cp1').get()));
    ck(`${label}: positive control — a property viewing request (no venue) is still client-creatable`, await allowed(member.doc('bookings/prop9').set({ customerId: 'member1', hub: 'property', status: 'pending' })));
    ck(`${label}: …and its customer can still cancel it`, await allowed(buyer.doc('bookings/prop1').update({ status: 'cancelled', cancelReason: 'no longer needed' })));
  }
  if (served) {
    /* POSITIVE CONTROL: the same actor, same shape, a non-booking id is ALLOWED — so the ent_booking denial
       above is decided by the reserved-id clause, not by some other clause failing. */
    ck(`${label}: positive control — the same client creates an ordinary conversation (ALLOWED)`, await allowed(member.doc('conversations/c_ok_1').set({ participants: ['member1', 'owner1'], transactionType: 'x' })));
    ck(`${label}: the buyer reads their own booking and PIN`, (await allowed(buyer.doc('entBookings/svc_b1').get())) && (await allowed(buyer.doc('entBookingSecrets/svc_b1').get())));
    ck(`${label}: the provider reads the booking envelope (not the PIN)`, await allowed(owner.doc('entBookings/svc_b1').get()));
    ck(`${label}: the owner reads their own venue settlement`, await allowed(owner.doc('venueSettlements/VB-1').get()));
  }

  /* ── readiness sweep 2026-09-27: organizer self-mint, forged application decision, promo codes ── */
  await expectDeny('buyer adds event_organizer to their OWN users.roles (organizer self-mint)',
    buyer.doc('users/buyer1').update({ roles: ['buyer', 'event_organizer'] }));
  await expectDeny('a new account is created already holding event_organizer',
    stranger.doc('users/stranger').set({ uid: 'stranger', roles: ['event_organizer'] }));
  await expectDeny('applicant writes status:approved on their own application',
    buyer.doc('applications/app1').update({ status: 'approved' }));
  await expectDeny('applicant spells it "Approved" (canonStatus lower-cases)',
    buyer.doc('applications/app1').update({ status: 'Approved' }));
  await expectDeny('applicant writes decidedBy naming a real admin',
    buyer.doc('applications/app1').update({ decidedBy: 'admin1' }));
  await expectDeny('applicant CREATES an application already approved + decidedBy',
    buyer.doc('applications/app2').set({ uid: 'buyer1', status: 'approved', decidedBy: 'admin1' }));
  await expectDeny('anyone writes the server decision record',
    buyer.doc('applicationDecisions/app1').set({ status: 'approved', decidedBy: 'admin1' }));
  await expectDeny('an applicant reads the decision record', buyer.doc('applicationDecisions/app1').get());
  await expectDeny('a signed-in user lists every event promo code', stranger.collection('eventPromoCodes').get());
  if (served) {
    ck(`${label}: sign-up still writes roles:['buyer']`, await allowed(env.authenticatedContext('newbie').firestore().doc('users/newbie').set({ uid: 'newbie', roles: ['buyer'] })));
    ck(`${label}: driver onboarding still arrayUnions 'driver'`, await allowed(buyer.doc('users/buyer1').update({ roles: ['buyer', 'driver'] })));
    ck(`${label}: an approved organizer's unrelated edit keeps the existing role`, await allowed(org.doc('users/org1').update({ displayName: 'Kamau', roles: ['buyer', 'event_organizer', 'driver'] })));
    ck(`${label}: applicant still submits a PENDING application`, await allowed(buyer.doc('applications/app3').set({ uid: 'buyer1', status: 'pending' })));
    ck(`${label}: applicant still amends their own pending application`, await allowed(buyer.doc('applications/app1').update({ phone: '0712345678' })));
    ck(`${label}: admin reads the decision record`, await allowed(admin.doc('applicationDecisions/app1').get()));
  }

  /* legacy EntHub retired from the client; canonical venues hardened (2026-09-27) */
  await expectDeny('a stranger reads an artist profile holding a phone + email (PII)', stranger.doc('entArtists/a2').get());
  await expectDeny('a stranger lists legacy artists', stranger.collection('entArtists').get());
  await expectDeny('a stranger lists legacy venues', stranger.collection('entVenues').get());
  await expectDeny('a stranger reads an unapproved review', stranger.doc('entReviews/r1').get());
  await expectDeny('a client creates a legacy artist profile', owner.doc('entArtists/a9').set({ uid: 'owner1', name: 'X', status: 'pending' }));
  await expectDeny('a client books a legacy artist with its own price + payment ref', buyer.doc('entArtistBookings/b9').set({ uid: 'buyer1', artistUid: '', totalPrice: 1, paymentRef: 'FAKE' }));
  await expectDeny('a client books a legacy venue with its own price', buyer.doc('entVenueBookings/b9').set({ uid: 'buyer1', totalPrice: 1, status: 'confirmed' }));
  await expectDeny('a venue owner un-suspends their own venue', owner.doc('venues/cv1').update({ status: 'active' }));
  await expectDeny('a venue owner inflates their rating', owner.doc('venues/cv1').update({ rating: 5, reviewCount: 999 }));
  await expectDeny('a venue owner creates a venue already ACTIVE', owner.doc('venues/cv2').set({ ownerId: 'owner1', name: 'Club', status: 'active' }));
  await expectDeny('a venue owner creates a venue marked verified', owner.doc('venues/cv4').set({ ownerId: 'owner1', name: 'Club', status: 'pending', verified: true }));

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
  /* ticket identity + fiscal (KRA eTIMS) records: server-owned */
  await expectDeny('buyer reads the ticket-number index', buyer.doc('eventTicketNumbers/SK-EVT-2026-000184').get());
  await expectDeny('a client claims a ticket number', buyer.doc('eventTicketNumbers/SK-EVT-2026-000999').set({ eventId: 'e1', ticketId: 'x' }));
  await expectDeny('organizer marks own sale fiscally CONFIRMED', org.doc('eventFiscal/PAY1').update({ status: 'CONFIRMED', receiptNumber: 'FAKE-1' }));
  await expectDeny('organizer writes a fiscal record (hides a sale from reconciliation)', org.doc('eventFiscal/PAY2').set({ status: 'NOT_APPLICABLE' }));
  await expectDeny('organizer reads fiscal records directly', org.doc('eventFiscal/PAY1').get());
  /* forged client fiscal payloads (credit-note slice) */
  await expectDeny('client sets a credit note CREDIT_NOTE_ACCEPTED with a made-up number', org.doc('eventFiscalReversals/x1').set({ status: 'CREDIT_NOTE_ACCEPTED', creditNoteReference: 'FAKE-CN' }));
  await expectDeny('client flips an existing credit note to accepted', org.doc('eventFiscalReversals/cn1').update({ status: 'CREDIT_NOTE_ACCEPTED' }));
  await expectDeny('organizer reads the credit-note lifecycle directly', org.doc('eventFiscalReversals/cn1').get());
  await expectDeny('seller marks own eTIMS invoice accepted with a fake receipt + QR', org.doc('etimsInvoices/inv1').update({ status: 'accepted', receiptNumber: 'FAKE-RCPT', qrCode: 'https://evil.example/qr.png' }));
  await expectDeny('seller writes a credit-note document', org.doc('creditNotes/cn_fake').set({ sellerUid: 'org1', status: 'accepted' }));
  await expectDeny('seller alters the original invoice amount', org.doc('etimsInvoices/inv1').update({ totals: { totAmt: 1 } }));

  if (served) {
    /* Legacy EntHub RETIRED from the client (2026-09-27): owner + admin read only, no browser writes. */
    ck(`${label}: the legacy record's OWNER can still read it (data rights)`, await allowed(owner.doc('entArtists/a1').get()));
    ck(`${label}: an admin can read legacy records (AdminOS moderation)`, await allowed(admin.doc('entVenues/v1').get()));
    ck(`${label}: canonical venue — owner edits the name/description`, await allowed(owner.doc('venues/cv1').update({ name: 'Hall B', description: 'Wide' })));
    ck(`${label}: canonical venue — a PENDING venue can be created by its owner`, await allowed(owner.doc('venues/cv3').set({ ownerId: 'owner1', name: 'Garden', status: 'pending' })));
    ck(`${label}: organizer reads OWN settlement`, await allowed(org.doc('eventSettlements/PAY1').get()));
    ck(`${label}: buyer reads own order`, await allowed(buyer.doc('eventOrders/o1').get()));
    ck(`${label}: buyer reads OWN refund request`, await allowed(buyer.doc('eventRefundRequests/o1').get()));
    ck(`${label}: admin reads sales, admissions, receivables, ops audit`, (await allowed(admin.doc('eventSales/s1').get())) && (await allowed(admin.doc('eventAdmissions/k1').get())) && (await allowed(admin.doc('eventCommissionReceivables/s1').get())) && (await allowed(admin.doc('eventOpsAudit/a1').get())));
    ck(`${label}: admin reads fiscal records (reconciliation)`, await allowed(admin.doc('eventFiscal/PAY1').get()));
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
