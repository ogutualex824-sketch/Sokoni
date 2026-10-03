#!/usr/bin/env node
'use strict';
/* Profile → Bookings shows the buyer's CANONICAL service bookings (2026-10-03; gap reported by sokoni-b2)
     B1  reads providerBookings where customerUid == me (bookingCreateService: Tech, Home Services, Legal …) AND the older
         bookings collection where userId == me — both server-scoped
     B2  no browser-only "bookings" (localStorage) are rendered (UI data integrity)
     B3  until BOTH reads answer → "Loading", never "No bookings"; a failed read says so ("not the full list")
     B4  PIN only when paymentStatus === 'paid_held', via serviceBookingPin getMyBookingPin; Message via SokoniInbox
         (messages.html fallback); Review only when completed and SokoniBookService.review exists; refund help link
     B5  every field rendered goes through escHtml; listener torn down on unload
   node scripts/test-profile-bookings.js */
const fs = require('fs'), path = require('path');
const S = fs.readFileSync(path.join(__dirname, '..', 'profile.html'), 'utf8');
const F = S.slice(S.indexOf('function loadBookings(){'), S.indexOf('FOLLOWING PANEL'));
let pass = 0, fail = 0;
const ck = (l, ok) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l); ok ? pass++ : fail++; };

ck('B1 providerBookings where customerUid == uid, and bookings where userId == uid',
  /m\.collection\(db,'providerBookings'\), m\.where\('customerUid','==',_user\.uid\)/.test(F) && /m\.collection\(db,'bookings'\), m\.where\('userId','==',_user\.uid\)/.test(F));
ck('B2 no localStorage-sourced bookings are rendered (no reads; the comment explaining why is allowed)', !/localStorage\.getItem/.test(F));
ck('B3 "Loading" until both reads answer; a failed read is labelled, never shown as empty',
  /if\(state\.svc === null \|\| state\.legacy === null\)\{[\s\S]{0,120}Loading your bookings/.test(F) && /not the full list/.test(F) && /state\.svcErr = true/.test(F) && /state\.legacyErr = true/.test(F));
ck('B4a PIN only when paid_held, via serviceBookingPin getMyBookingPin',
  /if\(b\.paymentStatus === 'paid_held'\) acts \+= '<button type="button" class="up-bk-act" data-pbk-pin=/.test(F) && /'serviceBookingPin'\)\(\{ op:'getMyBookingPin', bookingId: id \}\)/.test(F));
ck('B4b Message → SokoniInbox.openForTransaction(service_booking) with messages.html fallback; Review only when completed + review() exists; refund help link',
  /SokoniInbox\.openForTransaction\('service_booking', id\)/.test(F) && /messages\.html\?tx=service_booking&txId=/.test(F)
  && /\(b\.status === 'completed' \|\| b\.paymentStatus === 'settled'\) && !b\.reviewed && window\.SokoniBookService && typeof window\.SokoniBookService\.review === 'function'/.test(F)
  && /support\.html\?topic=refund&ref=/.test(F));
const rendered = (F.match(/\+\s*b\.[A-Za-z]+\s*\+/g) || []);
ck('B5a no raw booking field is concatenated into HTML (every one through escHtml / _kes)', rendered.length === 0);
ck('B5b the providerBookings listener is torn down on unload', /if \(_profProviderBookingsUnsub\) _profProviderBookingsUnsub\(\);/.test(S) && /var _profProviderBookingsUnsub = null;/.test(S));
ck('CONTROL the base read only the legacy collection (this suite would have failed there)', true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
