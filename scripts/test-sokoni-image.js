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
ok('empty src → placeholder', SI.render({ src: '' }).includes('assets/default-product.png'));
ok('data: URI src → placeholder', SI.render({ src: 'data:image/png;base64,AAA' }).includes('assets/default-product.png'));
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

/* isBadSrc */
ok('isBadSrc: data: true', SI.isBadSrc('data:x') === true);
ok('isBadSrc: https false', SI.isBadSrc('https://s/x') === false);
ok('isBadSrc: empty true', SI.isBadSrc('') === true);

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
