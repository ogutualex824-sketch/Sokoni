#!/usr/bin/env node
'use strict';

/** Tests for sokoni-image.js render logic (string output, srcset, CLS, fallback). */

const path = require('path');
const SI = require(path.resolve(__dirname, '..', 'sokoni-image.js'));

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('  ✗ ' + name); } }

/* Base render */
(() => {
  const h = SI.render({ src: 'https://s/x.webp', alt: 'Mango' });
  ok('renders an <img>', /<img /.test(h));
  ok('lazy by default', /loading="lazy"/.test(h));
  ok('decoding async', /decoding="async"/.test(h));
  ok('carries the src', h.includes('src="https://s/x.webp"'));
  ok('escapes alt', SI.render({ src: 'https://s/x', alt: '<b>"hi"' }).includes('alt="&lt;b&gt;&quot;hi&quot;"'));
  ok('applies sk-img class', /class="[^"]*sk-img/.test(h));
})();

/* Fallback / bad src */
ok('empty src → placeholder', SI.render({ src: '' }).includes('src="assets/default-product.png"'));
/* v1.2: base64 data: URIs now RENDER (the homepage OOM was fixed by bounding the
   catalogue listener, not by hiding images) — so a data: src is carried through,
   not swapped for the placeholder. Real Storage URLs are still preferred via pick(). */
ok('data: URI src → renders (base64 allowed)', SI.render({ src: 'data:image/png;base64,AAA' }).includes('src="data:image/png;base64,AAA"'));
ok('carries data-sk-fallback for the error handler', SI.render({ src: 'https://s/x' }).includes('data-sk-fallback='));

/* Priority */
(() => {
  const h = SI.render({ src: 'https://s/hero.webp', priority: true });
  ok('priority → eager', /loading="eager"/.test(h));
  ok('priority → fetchpriority high', /fetchpriority="high"/.test(h));
})();

/* CLS */
ok('no dimensions → aspect-ratio wrapper (reserves space)',
  /class="sk-img-box"[^>]*aspect-ratio:/.test(SI.render({ src: 'https://s/x' })));
ok('explicit width/height → no wrapper, dimensions on img',
  (() => { const h = SI.render({ src: 'https://s/x', width: 300, height: 300 });
    return h.includes('width="300"') && h.includes('height="300"') && !h.includes('sk-img-box'); })());
ok('custom aspectRatio honoured',
  SI.render({ src: 'https://s/x', aspectRatio: '4/3' }).includes('aspect-ratio:4/3'));

/* srcset (future — lights up when variants provided) */
ok('no variants → no srcset (today)', !/srcset=/.test(SI.render({ src: 'https://s/x' })));
(() => {
  const h = SI.render({ src: 'https://s/x', variants: { 200: 'https://s/200.webp', 600: 'https://s/600.webp', 1200: 'https://s/1200.webp' } });
  ok('variants → srcset with width descriptors, sorted',
    h.includes('srcset="https://s/200.webp 200w, https://s/600.webp 600w, https://s/1200.webp 1200w"'));
  ok('variants → sizes attribute', /sizes="/.test(h));
})();

/* buildSrcset helper directly */
ok('buildSrcset returns "" for null', SI.buildSrcset(null) === '');
ok('buildSrcset skips zero/empty widths',
  SI.buildSrcset({ 0: 'x', 300: 'https://s/300.webp' }) === 'https://s/300.webp 300w');

/* CDN rewrite hook (off by default; enabling it routes urls) */
(() => {
  SI.configure({ cdnRewrite: (url, w) => url + '?w=' + w });
  const s = SI.buildSrcset({ 200: 'https://s/x.webp' });
  ok('cdnRewrite hook applied when configured', s === 'https://s/x.webp?w=200 200w');
  SI.configure({ cdnRewrite: null }); // reset
})();

/* isBadSrc — v1.2: only empty/blank is "bad"; base64 is allowed (renders). */
ok('isBadSrc: data: allowed (false)', SI.isBadSrc('data:x') === false);
ok('isBadSrc: https false', SI.isBadSrc('https://s/x') === false);
ok('isBadSrc: empty true', SI.isBadSrc('') === true);
ok('isBadSrc: blank true', SI.isBadSrc('   ') === true);

/* pick — canonical field resolver: prefers a real Storage URL, then base64, then ''. */
ok('pick: imageStorageUrls[0] wins', SI.pick({ imageStorageUrls: ['https://s/a.jpg'], image: 'data:x' }) === 'https://s/a.jpg');
ok('pick: real URL preferred over base64 image', SI.pick({ image: 'data:x', imageUrl: 'https://s/b.jpg' }) === 'https://s/b.jpg');
ok('pick: images[] entry (string)', SI.pick({ images: ['https://s/c.jpg'] }) === 'https://s/c.jpg');
ok('pick: images[] entry (object .url)', SI.pick({ images: [{ url: 'https://s/d.jpg' }] }) === 'https://s/d.jpg');
ok('pick: base64 only when no URL', SI.pick({ image: 'data:img' }) === 'data:img');
ok('pick: root-absolute path is a URL', SI.pick({ image: '/assets/x.png' }) === '/assets/x.png');
ok('pick: empty object → ""', SI.pick({}) === '');
ok('pick: null/undefined string skipped', SI.pick({ image: 'null', imageUrl: 'https://s/e.jpg' }) === 'https://s/e.jpg');
ok('render {product} resolves via pick', SI.render({ product: { imageStorageUrls: ['https://s/p.jpg'] } }).includes('src="https://s/p.jpg"'));

/* Fallback modes (v1.1) */
ok('default mode → no fallmode attr (placeholder, v1.0 behaviour)',
  !/data-sk-fallmode/.test(SI.render({ src: 'https://s/x' })));
ok('css-hide mode → emits fallmode + failClass',
  (() => { const h = SI.render({ src: 'https://s/x', fallbackMode: 'css-hide', failClass: 'img-failed' });
    return h.includes('data-sk-fallmode="css-hide"') && h.includes('data-sk-failclass="img-failed"'); })());
ok('remove mode → emits fallmode',
  SI.render({ src: 'https://s/x', fallbackMode: 'remove' }).includes('data-sk-fallmode="remove"'));
ok('always keeps sk-img + data-sk-fallback regardless of mode',
  (() => { const h = SI.render({ src: 'https://s/x', fallbackMode: 'remove' });
    return h.includes('sk-img') && h.includes('data-sk-fallback'); })());

/* Version + diagnostics */
ok('exposes a version constant', SI.version === '1.2.0');
ok('checkAdoption is callable (no-op without a DOM)',
  (() => { const r = SI.checkAdoption(); return r && typeof r.unmanaged === 'number'; })());

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
