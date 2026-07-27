#!/usr/bin/env node
'use strict';

/**
 * Tests for the MiniShop config schema — the module that reconciles the two
 * stores and two key schemes a shop's branding was historically split across.
 *
 * The cases that matter are the convergence ones: a config written by the old
 * admin controller must come back out under the names the storefront reads, and
 * a shop whose data only ever landed in the legacy store must still resolve.
 *
 * Run: node scripts/test-minishop-config-schema.js
 */

const {
  normalize, resolve, forWrite, readVersion, assertNoProtected,
  SCHEMA_VERSION, PROTECTED_FIELDS,
} = require('../functions/minishop-config-schema');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m', name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m', name, detail ? '\n      ' + JSON.stringify(detail) : ''); }
};
const group = (n) => console.log('\n' + n);

/* Exactly what minishop-admin.html's built-in controller emits. */
const LEGACY = {
  coverImage: 'https://cdn.example/cover.jpg',
  logoImage:  'https://cdn.example/logo.png',
  tagline:    'Fresh groceries daily',
  description:'We deliver across Nairobi',
  location:   'Nairobi',
  phone:      '+254700000000',
  email:      'shop@example.com',
  whatsapp:   '254700000000',
  instagram:  'kassshop',
  website:    'https://kassshop.example',
  deliveryAreas: 'Westlands, Kilimani, CBD',
  deliveryPolicy:'Same day within Nairobi',
  accentColor:'#71ff00',
};

/* Exactly what sokoni-minishop.js emits. */
const CANONICAL = {
  contactPhone: '+254711111111',
  contactEmail: 'hello@example.com',
  brandColor:   '#00d4ff',
  responseTime: 'Within an hour',
  deliveryPolicy: 'Next day',
  socialLinks:  { whatsapp: '254711111111', tiktok: 'kass' },
  coverUrl:     'https://cdn.example/canonical-cover.jpg',
  paymentMethods: ['mpesa', 'card'],
};

/* ── 1. Legacy names must survive as canonical ──────────────────────────── */
group('normalize — legacy names map to what the storefront reads');
{
  const n = normalize(LEGACY);
  ok('coverImage -> coverUrl',   n.coverUrl === LEGACY.coverImage, n);
  ok('logoImage -> logoUrl',     n.logoUrl === LEGACY.logoImage, n);
  ok('phone -> contactPhone',    n.contactPhone === LEGACY.phone, n);
  ok('email -> contactEmail',    n.contactEmail === LEGACY.email, n);
  ok('accentColor -> brandColor',n.brandColor === LEGACY.accentColor, n);
  ok('flat socials fold into socialLinks',
    n.socialLinks && n.socialLinks.whatsapp === '254700000000' &&
    n.socialLinks.instagram === 'kassshop' && n.socialLinks.website === 'https://kassshop.example', n.socialLinks);
  ok('no legacy key survives',
    !('coverImage' in n) && !('logoImage' in n) && !('phone' in n) &&
    !('email' in n) && !('accentColor' in n) && !('whatsapp' in n), Object.keys(n));
  ok('these are the seven the old allowlist dropped',
    n.tagline && n.location && n.deliveryPolicy && n.brandColor, n);
}

/* ── 2. Fields the old allowlist silently discarded ─────────────────────── */
group('normalize — fields the previous allowlist dropped on every save');
{
  const n = normalize(CANONICAL);
  ok('brandColor kept',     n.brandColor === '#00d4ff', n);
  ok('responseTime kept',   n.responseTime === 'Within an hour', n);
  ok('deliveryPolicy kept', n.deliveryPolicy === 'Next day', n);
  const t = normalize({ tagline: 'x', location: 'y', category: 'z', fontFamily: 'Inter' });
  ok('tagline/location/category/fontFamily kept',
    t.tagline === 'x' && t.location === 'y' && t.category === 'z' && t.fontFamily === 'Inter', t);
}

/* ── 3. Hostile / malformed input ───────────────────────────────────────── */
group('normalize — sanitisation and rejection');
{
  const n = normalize({
    description: '<script>alert(1)</script>Real text',
    tagline: '   padded   ',
    contactPhone: 'x'.repeat(300),
    sellerUid: 'attacker',           // mass-assignment attempt
    bankDetails: { acct: '123' },    // ditto
    totalProducts: 9999,             // counter, not display config
    deliveryAreas: ['a', 'b', 'c', 'd'.repeat(500)],
  });
  ok('strips tags', n.description === 'Real text', n.description);
  ok('trims', n.tagline === 'padded', n.tagline);
  ok('truncates to field max', n.contactPhone.length === 20, n.contactPhone.length);
  ok('drops unknown key sellerUid', !('sellerUid' in n), Object.keys(n));
  ok('drops unknown key bankDetails', !('bankDetails' in n), Object.keys(n));
  ok('drops counter totalProducts', !('totalProducts' in n), Object.keys(n));
  ok('caps array item length', n.deliveryAreas[3].length === 100, n.deliveryAreas[3].length);
  ok('non-object input yields {}', JSON.stringify(normalize(null)) === '{}');
  ok('array input yields {}', JSON.stringify(normalize([1,2])) === '{}');
  ok('absent keys stay absent (safe for merge writes)',
    Object.keys(normalize({ tagline: 'only' })).join() === 'tagline');
}

/* ── 4. Comma-separated form input ──────────────────────────────────────── */
group('normalize — the admin form submits deliveryAreas as one string');
{
  const n = normalize({ deliveryAreas: 'Westlands, Kilimani ,CBD' });
  ok('splits and trims to an array',
    Array.isArray(n.deliveryAreas) && n.deliveryAreas.length === 3 &&
    n.deliveryAreas[1] === 'Kilimani' && n.deliveryAreas[2] === 'CBD', n.deliveryAreas);
}

/* ── 5. resolve — the actual bug ────────────────────────────────────────── */
group('resolve — precedence across the two stores');
{
  const r = resolve(CANONICAL, LEGACY, {});
  ok('canonical store wins where both have a value',
    r.contactPhone === '+254711111111' && r.brandColor === '#00d4ff', r);
  ok('legacy fills gaps the canonical store lacks',
    r.logoUrl === LEGACY.logoImage && r.tagline === 'Fresh groceries daily' &&
    r.location === 'Nairobi', r);
  ok('canonical cover beats legacy cover',
    r.coverUrl === 'https://cdn.example/canonical-cover.jpg', r.coverUrl);
  ok('socialLinks merge, canonical winning per key',
    r.socialLinks.whatsapp === '254711111111' &&   // canonical
    r.socialLinks.tiktok === 'kass' &&             // canonical only
    r.socialLinks.instagram === 'kassshop', r.socialLinks); // legacy only
}

group('resolve — a shop configured only by the old controller still renders');
{
  /* This is the live failure: minishopConfig/{id} empty, everything in
     shops/{id}.minishopConfig. Reading only the canonical store returned
     nothing, so the storefront showed no logo, no cover, no tagline. */
  const r = resolve({}, LEGACY, {});
  ok('cover resolves', r.coverUrl === LEGACY.coverImage, r.coverUrl);
  ok('logo resolves',  r.logoUrl === LEGACY.logoImage, r.logoUrl);
  ok('tagline resolves', r.tagline === 'Fresh groceries daily', r.tagline);
  ok('phone resolves under the canonical name', r.contactPhone === '+254700000000', r);
  ok('socials resolve', r.socialLinks.whatsapp === '254700000000', r.socialLinks);
}

group('resolve — degenerate inputs');
{
  ok('all empty -> {}', JSON.stringify(resolve({}, {}, {})) === '{}');
  ok('nulls tolerated', JSON.stringify(resolve(null, null, null)) === '{}');
  const r = resolve({ coverUrl: '' }, { coverImage: 'https://cdn/x.jpg' }, {});
  ok('empty string does not mask a real legacy value', r.coverUrl === 'https://cdn/x.jpg', r);
  const r2 = resolve({ deliveryAreas: [] }, { deliveryAreas: 'A,B' }, {});
  ok('empty array does not mask a real legacy value',
    Array.isArray(r2.deliveryAreas) && r2.deliveryAreas.length === 2, r2.deliveryAreas);
}

/* ── 6. Mass assignment — every protected field, named individually ─────────
   The point of enumerating these rather than spot-checking two is that the
   test fails the moment someone widens the allowlist or adds a passthrough
   branch, instead of the day a client-supplied sellerUid reaches Firestore. */
group('protected fields — none can survive normalisation');
{
  const hostile = {};
  for (const f of PROTECTED_FIELDS) hostile[f] = 'attacker-controlled';
  hostile.tagline = 'legitimate';                 // one real field must still pass

  const n = normalize(hostile);
  ok('a legitimate field alongside them still passes', n.tagline === 'legitimate', n);

  let leaked = [];
  for (const f of PROTECTED_FIELDS) if (f in n) leaked.push(f);
  ok('zero protected fields in normalize output', leaked.length === 0, leaked);

  /* Name each one so a regression report says which field escaped. */
  for (const f of PROTECTED_FIELDS) ok('rejects ' + f, !(f in n));

  ok('forWrite output is also clean',
    !Object.keys(forWrite(hostile)).some(k => PROTECTED_FIELDS.has(k)));
  ok('assertNoProtected throws if one is smuggled in', (() => {
    try { assertNoProtected({ sellerUid: 'x' }); return false; } catch (_) { return true; }
  })());
  ok('assertNoProtected passes a clean object', (() => {
    try { assertNoProtected({ tagline: 'ok' }); return true; } catch (_) { return false; }
  })());
}

/* ── 7. Schema versioning ───────────────────────────────────────────────── */
group('schema version');
{
  const w = forWrite(LEGACY);
  ok('forWrite stamps the current version', w.schemaVersion === SCHEMA_VERSION, w.schemaVersion);
  ok('forWrite still normalises', w.coverUrl === LEGACY.coverImage && !('coverImage' in w), w);
  ok('normalize alone does NOT stamp — it is also used for reads',
    !('schemaVersion' in normalize(LEGACY)));
  ok('a client cannot forge the version', forWrite({ schemaVersion: 99, tagline: 'x' }).schemaVersion === SCHEMA_VERSION);

  ok('unversioned document reads as v1', readVersion({ tagline: 'x' }) === 1);
  ok('versioned document reads its version', readVersion({ schemaVersion: 2 }) === 2);
  ok('garbage version falls back to v1', readVersion({ schemaVersion: 'two' }) === 1);
  ok('null document reads as v1', readVersion(null) === 1);

  ok('schemaVersion never leaks into resolved display config',
    !('schemaVersion' in resolve(forWrite(CANONICAL), {}, {})));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
