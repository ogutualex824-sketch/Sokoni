#!/usr/bin/env node
'use strict';
/* processTypesenseQueue — the verified badge comes ONLY from the admin-granted `verified` field (owner 2026-10-03)
   Defect (live 09-21 archive, rev 00022-fon): the sellers mapper read `verified: Boolean(data.verified || data.isVerified)`.
   `isVerified` is client-writable (served sellers/{uid} rules: noAdminFields blocks `verified`, not `isVerified`), so any
   signed-in user could appear verified in shop search. Same class in the products mapper: `sellerVerified` (no server writer;
   not in noAdminFields).
     V1  seller isVerified:true, verified absent/false → indexed verified FALSE
     V2  seller verified:true (admin) → indexed verified TRUE
     V3  product sellerVerified:true, verified absent → no verified badge
     V4  product verified:true → badge
     V5  no transformer in the processor reads isVerified / sellerVerified as a trust signal (static, all mappers)
     V6  everything else in the seller / product documents is unchanged (same output for a fixture minus `verified`)
   Run: node scripts/test-typesense-verified-badge.js */
const path = require('path'), fs = require('fs'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'functions', 'typesense-client.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '  -> ' + JSON.stringify(d).slice(0, 200))); ok ? pass++ : fail++; };

/* load the REAL module with network modules stubbed (no I/O happens at load) */
const mod = { exports: {} };
const ctx = { module: mod, exports: mod.exports, require: (id) => (['https', 'http'].includes(id) ? { request () { throw new Error('no network in test'); }, Agent: function () {} } : require(id)),
  process: { env: {} }, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, __dirname: path.join(ROOT, 'functions') };
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'typesense-client.js' });
const X = mod.exports;
const T = X.TRANSFORMERS || X.transformers || (X._internal && X._internal.TRANSFORMERS);
if (!T || typeof T.sellers !== 'function') { ck('TRANSFORMERS reachable', false, Object.keys(X)); console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

const seller = { shopName: 'Mama Mboga', description: 'veg', category: 'grocery', rating: 4.5, reviewCount: 3, status: 'active' };
const s1 = T.sellers('u1', Object.assign({}, seller, { isVerified: true }));
const s1b = T.sellers('u1', Object.assign({}, seller, { isVerified: true, verified: false }));
ck('V1 seller isVerified:true (client-writable) → indexed verified FALSE', s1.verified === false && s1b.verified === false, { s1: s1.verified, s1b: s1b.verified });
ck('V2 seller verified:true (admin-granted) → indexed verified TRUE', T.sellers('u1', Object.assign({}, seller, { verified: true })).verified === true);
const prod = { name: 'Tomatoes', price: 100, sellerUid: 'u1', status: 'active' };
ck('V3 product sellerVerified:true (no server writer) → no verified badge', !T.products('p1', Object.assign({}, prod, { sellerVerified: true })).verified);
ck('V4 product verified:true → badge', T.products('p1', Object.assign({}, prod, { verified: true })).verified === true);
const tblock = SRC.slice(SRC.indexOf('const TRANSFORMERS = {'), SRC.indexOf('module.exports'));
const code = tblock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ck('V5 no transformer reads isVerified / sellerVerified (comments excluded)', !/data\.isVerified|data\.sellerVerified/.test(code));
const drop = (o) => { const c = Object.assign({}, o); delete c.verified; return c; };
ck('V6 every other seller / product field is unchanged by the fix',
  JSON.stringify(drop(T.sellers('u1', Object.assign({}, seller, { isVerified: true })))) === JSON.stringify(drop(T.sellers('u1', seller)))
  && JSON.stringify(drop(T.products('p1', Object.assign({}, prod, { sellerVerified: true })))) === JSON.stringify(drop(T.products('p1', prod))));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
