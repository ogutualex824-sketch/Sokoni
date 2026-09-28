'use strict';
/**
 * kass-stays.js — KASS's read of SOKONI stays: canonical listings, canonical prices, real availability.
 * ============================================================================================
 * Owner rule (2026-09-28): "book_stay must obtain listing → canonical price → availability → booking total, not
 * AI → invented nightly price → booking. The model may select a listing, but it must never be the monetary authority."
 *
 * What was wrong (functions/index.js at 4e9607b, and LIVE — docs/C4_C8_PRODUCTION_PRIVACY_AUTH_CENSUS.md #2):
 *   · book_stay computed totalPrice = pricePerNight × nights from the MODEL's tool input, and wrote it;
 *   · it wrote into `bookings`, a store no host reads (hosts manage stays from `bnbBookings`), so a "booking" KASS
 *     confirmed was invisible to the host;
 *   · search_stays read the legacy `listings` / `hotels` stores raw (no status gate), so the listing ids it handed out
 *     were not SOKONI's canonical, admin-approved stays.
 *
 * The canonical stay listing is `bnbListings/{id}`: created 'pending', public only once AdminOS sets it 'active'
 * (firestore.rules bnbListings; entAdminSetListingStatus). Its price is the listing's own `pricePerNight`. Host
 * bookings live in `bnbBookings` (bnb.html / bnb-hub.html / bnb-manage.html). No server-side stay engine exists yet
 * (business-workspace STAY_ENGINE_PENDING), so this module QUOTES; it does not book — creating the booking is the
 * owner's later "KASS booking actions" step. Nothing here writes.
 */

const MAX_NIGHTS = 60;
const DEFAULT_MAX_GUESTS = 20;
/* bnbBookings statuses that do NOT hold the dates */
const RELEASED = new Set(['cancelled', 'canceled', 'rejected', 'declined', 'expired', 'refunded', 'failed']);

const _str = (v) => (v == null ? '' : String(v)).trim();
const _price = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

/** Today's date in Nairobi (UTC+3, no DST) as YYYY-MM-DD. */
function nairobiToday(nowMs) {
  const d = new Date((nowMs == null ? Date.now() : nowMs) + 3 * 3600000);
  return d.toISOString().slice(0, 10);
}
function _isoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(_str(s))) return null;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? t : null;
}

/** A public card for an ACTIVE listing — or null. Never exposes the host's phone / uid. */
function publicStay(id, d) {
  if (!d || d.status !== 'active') return null;
  const name = _str(d.name || d.title);
  if (!name) return null;
  return {
    type: 'bnb', id, name,
    pricePerNight: _price(d.pricePerNight != null ? d.pricePerNight : d.price),
    city: _str(d.city || d.location), image: _str(d.image || (Array.isArray(d.images) ? d.images[0] : '')) || null,
    maxGuests: Number.isInteger(Number(d.maxGuests)) && Number(d.maxGuests) > 0 ? Number(d.maxGuests) : null,
    url: 'bnb-hub.html?q=' + encodeURIComponent(name),
  };
}

/** Active canonical listings, optionally narrowed by a free-text location and a listing-price ceiling. */
async function listStays(db, { location, maxPrice, limit = 8 } = {}) {
  const snap = await db.collection('bnbListings').where('status', '==', 'active').limit(100).get();
  const loc = _str(location).toLowerCase();
  const cap = _price(maxPrice);
  const out = [];
  for (const doc of snap.docs) {
    const c = publicStay(doc.id, doc.data());
    if (!c) continue;
    if (loc && !c.city.toLowerCase().includes(loc)) continue;
    if (cap && !(c.pricePerNight && c.pricePerNight <= cap)) continue;
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Quote a stay from the listing's OWN price. Refuses — never guesses — when the listing is not an active canonical
 * listing, has no usable price, the dates are invalid or in the past, the party is too large, or the dates are taken.
 * @returns {{ok:true, listing, checkIn, checkOut, nights, guests, pricePerNight, total, source}|{ok:false, reason, message}}
 */
async function quoteStay(db, { listingId, checkIn, checkOut, guests = 1, nowMs } = {}) {
  const id = _str(listingId);
  if (!id || id.includes('/')) return { ok: false, reason: 'no_listing', message: 'Which listing? I need one from the search results.' };
  const snap = await db.collection('bnbListings').doc(id).get();
  const listing = snap.exists ? publicStay(id, snap.data()) : null;
  if (!listing) return { ok: false, reason: 'not_bookable', message: 'That is not an approved SOKONI stay listing, so I cannot quote it.' };
  if (!listing.pricePerNight) return { ok: false, reason: 'no_price', message: `${listing.name} has no nightly price on its listing, so I cannot quote a total.`, listing };

  const cin = _isoDate(checkIn), cout = _isoDate(checkOut);
  if (cin == null || cout == null) return { ok: false, reason: 'bad_dates', message: 'Please give check-in and check-out as YYYY-MM-DD.' };
  if (_str(checkIn) < nairobiToday(nowMs)) return { ok: false, reason: 'past_date', message: 'Check-in cannot be in the past.' };
  const nights = Math.round((cout - cin) / 86400000);
  if (nights <= 0) return { ok: false, reason: 'bad_dates', message: 'Check-out must be after check-in.' };
  if (nights > MAX_NIGHTS) return { ok: false, reason: 'too_long', message: `I can quote up to ${MAX_NIGHTS} nights.` };

  const g = Number(guests == null ? 1 : guests);
  const maxG = listing.maxGuests || DEFAULT_MAX_GUESTS;
  if (!Number.isInteger(g) || g < 1) return { ok: false, reason: 'bad_guests', message: 'How many guests?' };
  if (g > maxG) return { ok: false, reason: 'too_many_guests', message: `${listing.name} takes up to ${maxG} guests.`, listing };

  /* Availability: any live booking on this listing whose stay overlaps [checkIn, checkOut). */
  const bk = await db.collection('bnbBookings').where('listingId', '==', id).limit(200).get();
  const clash = bk.docs.some((d) => {
    const b = d.data() || {};
    if (RELEASED.has(_str(b.status).toLowerCase())) return false;
    const bi = _isoDate(_str(b.checkIn).slice(0, 10)), bo = _isoDate(_str(b.checkOut).slice(0, 10));
    return bi != null && bo != null && bi < cout && bo > cin;
  });
  if (clash) return { ok: false, reason: 'unavailable', message: `${listing.name} is already booked for some of those nights.`, listing };

  return {
    ok: true, listing, checkIn: _str(checkIn), checkOut: _str(checkOut), nights, guests: g,
    pricePerNight: listing.pricePerNight, total: listing.pricePerNight * nights,
    source: 'bnbListings/' + id + '.pricePerNight',
  };
}

module.exports = { listStays, quoteStay, publicStay, nairobiToday, MAX_NIGHTS, RELEASED };
