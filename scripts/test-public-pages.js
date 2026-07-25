#!/usr/bin/env node
'use strict';

/**
 * Tests for the server-rendered public pages behind /profile/{uid} and
 * /shop/{handle}.
 *
 * These pages write other people's display names, bios and shop names into
 * markup, so the tests that matter most are the injection ones. A profile
 * whose display name is `</title><script>…` must not be able to execute in
 * the browser of anyone who opens the link.
 *
 * No Firestore connection required — rendering is pure.
 *
 * Run: node scripts/test-public-pages.js
 */

const { renderProfilePage, renderProfileError } = require('../functions/profile-page');
const { esc, attr, httpsUrl, metaBlock, injectMeta, fetchTemplate } = require('../functions/html-render');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m', name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m', name, detail ? '\n      ' + detail : ''); }
};
const group = (n) => console.log('\n' + n);

/* Payloads shaped exactly like profileGetPublicProfile's output. */
const XSS = '</title></head><body><script>alert(1)</script><img src=x onerror=alert(2)>';

const FULL = {
  found: true,
  uid: 'aBcDeF1234567890aBcDeF12',
  sokoniId: 'SKN-ABCDEF12',
  displayName: 'Amina Wanjiru',
  photoURL: 'https://firebasestorage.googleapis.com/v0/b/x/o/a.jpg?alt=media',
  headline: 'Fresh produce supplier',
  location: 'Nairobi',
  skills: ['Logistics', 'Wholesale'],
  isVerified: true,
  verifiedTypes: ['email', 'phone', 'identity'],
  trustLevel: 'Gold',
  memberSince: '2025-03',
  shop: { handle: 'amina-fresh', url: 'https://mysokoni.co.ke/shop/amina-fresh' },
  profileUrl: 'https://mysokoni.co.ke/profile/aBcDeF1234567890aBcDeF12',
};

const MINIMAL = {
  found: true,
  uid: 'zZzZzZ1234567890zZzZzZ12',
  sokoniId: 'SKN-ZZZZZZ12',
  displayName: '',
  photoURL: null,
  headline: '',
  location: '',
  skills: [],
  isVerified: false,
  verifiedTypes: [],
  trustLevel: 'Bronze',
  memberSince: '',
  shop: null,
  profileUrl: 'https://mysokoni.co.ke/profile/zZzZzZ1234567890zZzZzZ12',
};

const HOSTILE = {
  ...FULL,
  displayName: XSS,
  headline: XSS,
  location: XSS,
  skills: [XSS],
  verifiedTypes: [XSS],
  sokoniId: XSS,
  photoURL: 'javascript:alert(1)',
  shop: { handle: XSS, url: 'javascript:alert(1)' },
  profileUrl: 'javascript:alert(1)',
};

/* ── 1. Structure ───────────────────────────────────────────────────────── */
group('Profile page — structure');
{
  const h = renderProfilePage(FULL);
  ok('is a complete document', h.startsWith('<!doctype html>') && h.includes('</html>'));
  ok('exactly one <title>', (h.match(/<title>/g) || []).length === 1);
  ok('title names the member', /<title>Amina Wanjiru — SOKONI<\/title>/.test(h));
  ok('og:title names the member', h.includes('content="Amina Wanjiru — SOKONI"'));
  ok('og:image is the member photo', h.includes('og:image" content="https://firebasestorage.googleapis.com'));
  ok('og:url is the canonical profile URL', h.includes('og:url" content="https://mysokoni.co.ke/profile/aBcDeF1234567890aBcDeF12"'));
  ok('description carries real detail', /og:description" content="[^"]*Fresh produce supplier/.test(h));
  ok('indexable', h.includes('content="index, follow"'));
  ok('renders headline, location, badges, skills, shop',
    h.includes('Fresh produce supplier') && h.includes('Nairobi') &&
    h.includes('Gold') && h.includes('Logistics') && h.includes('amina-fresh'));
  ok('renders without any client JS', !/<script/i.test(h));
}

/* ── 2. Degradation ─────────────────────────────────────────────────────── */
group('Profile page — sparse data degrades cleanly');
{
  const h = renderProfilePage(MINIMAL);
  ok('falls back to "SOKONI Member"', h.includes('SOKONI Member'));
  ok('initials placeholder replaces missing photo', h.includes('pp-initials'));
  ok('no empty headline element', !h.includes('<p class="pp-headline"></p>'));
  ok('no empty meta row', !h.includes('<div class="pp-meta"></div>'));
  ok('no empty skills row', !h.includes('<div class="pp-skills"></div>'));
  /* Matches the rendered element, not the class name — the stylesheet always
     defines .pp-shop, so a bare substring check passes vacuously. */
  ok('no shop button when there is no shop', !h.includes('class="pp-shop"'));
  ok('og:image falls back to the SOKONI logo', h.includes('assets/logosokoni.png'));
  ok('no literal undefined/null leaked', !/undefined|null/.test(h.replace(/[a-z-]+:\s*null/g, '')));
}

/* ── 3. Injection — the ones that matter ────────────────────────────────── */
group('Profile page — hostile member data cannot execute');
{
  const h = renderProfilePage(HOSTILE);
  const body = h.slice(h.indexOf('<body>'));

  /* The strongest assertion available without a parser: enumerate every tag
     the renderer actually emitted and require the set to be exactly what this
     page is built from. Any tag the payload managed to open — script, img,
     iframe, svg — shows up here immediately. A substring check for "onerror"
     cannot do this, because the escaped payload legitimately contains that
     text as inert body copy. */
  const EXPECTED_TAGS = new Set([
    'html', 'head', 'meta', 'title', 'link', 'style', 'body',
    'div', 'main', 'a', 'img', 'span', 'section', 'h1', 'p',
  ]);
  const emitted = new Set([...h.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map(m => m[1].toLowerCase()));
  const unexpected = [...emitted].filter(t => !EXPECTED_TAGS.has(t));
  ok('emits no tag the page does not own', unexpected.length === 0, 'unexpected: ' + unexpected.join(', '));

  ok('no <script> tag anywhere', !/<script/i.test(h));
  /* The single <img> the page may emit is the avatar, and its src is
     httpsUrl-checked. The payload's `<img src=x onerror=…>` must not survive
     as a real element. */
  /* Attribute NAMES only. The escaped payload legitimately appears inside the
     og:description value as inert text, so quoted values are stripped before
     the check — otherwise this flags `content="…onerror=alert(2)…"`, which is
     a string, not a handler. */
  const handlerTags = [...h.matchAll(/<[a-zA-Z][^>]*>/g)]
    .map(m => m[0].replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''"))
    .filter(t => /\son[a-z]+\s*=/i.test(t));
  ok('no event-handler attribute on any real tag', handlerTags.length === 0, handlerTags[0]);
  ok('no raw <img> injected', !/<img[^>]*src=x/i.test(h));
  ok('still exactly one <title>', (h.match(/<title>/g) || []).length === 1);
  ok('no premature </head>', (h.match(/<\/head>/g) || []).length === 1);
  ok('no premature </body>', (h.match(/<\/body>/g) || []).length === 1);
  ok('payload appears only escaped', body.includes('&lt;script&gt;'));
  ok('javascript: photo rejected', !h.includes('src="javascript:'));
  ok('javascript: shop link rejected', !h.includes('href="javascript:'));
  ok('javascript: canonical rejected', !/href="javascript:/.test(h) && !/og:url" content="javascript:/.test(h));
  ok('shop button omitted when its URL is unsafe', !h.includes('class="pp-shop"'));
}

/* ── 4. Error page ──────────────────────────────────────────────────────── */
group('Profile error page');
{
  const h = renderProfileError('Profile unavailable', 'This profile is private or no longer exists.');
  ok('is a complete document', h.startsWith('<!doctype html>') && h.includes('</html>'));
  ok('is noindex', h.includes('content="noindex, nofollow"'));
  ok('states the reason', h.includes('This profile is private or no longer exists.'));
  /* Checked against the rendered body, not the whole document — the shared
     stylesheet in <head> always defines .pp-badge and .pp-skill. */
  const errBody = h.slice(h.indexOf('<body>'));
  ok('invents no member data', !/SKN-|class="pp-badge|class="pp-skill|class="pp-card"/.test(errBody));
  ok('offers a way out', h.includes('href="/"'));
  const evil = renderProfileError(XSS, XSS);
  ok('escapes hostile headings', !/<script/i.test(evil));
}

/* ── 5. Shared helpers ──────────────────────────────────────────────────── */
group('html-render helpers');
{
  ok('esc neutralises tag characters', !/[<>]/.test(esc('<b>&"\'')));
  ok('attr collapses newlines', attr('a\n\nb') === 'a b');
  ok('attr truncates', attr('x'.repeat(500), 10).length === 10);
  ok('httpsUrl blocks javascript:', httpsUrl('javascript:alert(1)') === null);
  ok('httpsUrl blocks data:', httpsUrl('data:text/html,<script>') === null);
  ok('httpsUrl blocks protocol-relative', httpsUrl('//evil.com/a.png') === null);
  ok('httpsUrl blocks http', httpsUrl('http://evil.com/a.png') === null);
  ok('httpsUrl allows https', httpsUrl('https://a.example/b.png') !== null);

  const tpl = '<html><head><title>Shop on SOKONI</title>' +
    '<meta property="og:title" content="Shop on SOKONI">' +
    '<meta property="og:image" content="/old.png">' +
    '<meta name="description" content="old">' +
    '<meta charset="utf-8"><link rel="stylesheet" href="/a.css"></head><body>STOREFRONT</body></html>';
  const out = injectMeta(tpl, metaBlock({
    title: 'KASS SHOP', description: 'Fresh produce daily',
    image: 'https://mysokoni.co.ke/cover.png', url: 'https://mysokoni.co.ke/shop/kass',
  }));
  ok('stale og:title removed', (out.match(/og:title/g) || []).length === 1);
  ok('stale og:image removed', !out.includes('/old.png'));
  ok('stale description removed', !out.includes('content="old"'));
  ok('new metadata present', out.includes('KASS SHOP') && out.includes('Fresh produce daily'));
  ok('charset preserved', out.includes('charset="utf-8"'));
  ok('stylesheet preserved', out.includes('/a.css'));
  ok('body untouched', out.includes('<body>STOREFRONT</body>'));
  ok('template without </head> returned unchanged', injectMeta('<p>x</p>', 'M') === '<p>x</p>');
  ok('non-string template returned as-is', injectMeta(null, 'M') === null);
}

/* ── 6. Template cache ──────────────────────────────────────────────────── */
group('Template cache');
{
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { ok: true, text: async () => '<html><head></head><body>' + 'x'.repeat(300) + '</body></html>' };
  };

  (async () => {
    const url = 'https://example.test/t.html';
    await fetchTemplate(url, { now: 1000 });
    await fetchTemplate(url, { now: 2000 });
    ok('second call inside TTL is served from memory', calls === 1, `fetch called ${calls}×`);

    await fetchTemplate(url, { now: 1000 + 6 * 60 * 1000 });
    ok('expired entry is refetched', calls === 2, `fetch called ${calls}×`);

    global.fetch = async () => { throw new Error('network down'); };
    const stale = await fetchTemplate(url, { now: 1000 + 20 * 60 * 1000 });
    ok('serves stale copy when refetch fails', typeof stale === 'string' && stale.includes('<body>'));

    const missing = await fetchTemplate('https://example.test/never.html', { now: 1 });
    ok('returns null when nothing was ever cached', missing === null);

    global.fetch = realFetch;
    done();
  })();
}

function done() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
