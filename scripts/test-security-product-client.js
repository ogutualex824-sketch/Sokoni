#!/usr/bin/env node
/* SECURITY CONVERGENCE 2026-10-03 — merchant-v2's product adapter writes NOTHING to products/{id} itself; every write is
 * the merchantProduct callable, and "delete" is an archive.  SOURCE-LEVEL (the executed authority is functions/
 * merchant-product.js, certified by scripts/test-merchant-product.js on its own branch).
 *   node scripts/test-security-product-client.js        BASE=32c16ee node scripts/test-security-product-client.js (must FAIL) */
'use strict';
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'ignore'] }) : fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
let pass = 0, fail = 0;
const ck = (id, ok, m) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m); ok ? pass++ : fail++; };
console.log('\nmerchant-v2 product client   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '  (source-level)\n');
const MV2 = read('merchant-v2.html'), MP = read('sokoni-merchant-products.js');
const body = (name) => { const i = MV2.indexOf(name + ': function (o)'); if (i < 0) return ''; const j = MV2.indexOf('\n    },', i); return MV2.slice(i, j); };
const wp = body('writeProduct'), dp = body('deleteProduct');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
ck('C-1', !!wp && !/m\.fs\.(doc|setDoc|runTransaction|updateDoc|addDoc)|tx\.set|setDoc\(/.test(strip(wp)), 'writeProduct makes no direct Firestore write');
ck('C-2', /_callable\('merchantProduct'\)\(\{ op: 'write'/.test(wp) && /mode: o\.mode === 'create' \? 'create' : 'update'/.test(wp), 'writeProduct requests the server (op write, create | update)');
ck('C-3', /_refuseAuthorityFields\(o && o\.data, 'writeProduct'\)/.test(wp) && wp.indexOf('_refuseAuthorityFields') < wp.indexOf("_callable('merchantProduct')"), 'the stock-field guard still runs before the request');
ck('C-4', /\['id', 'shopId', 'sellerUid', 'createdAt', 'updatedAt'\]\.forEach/.test(wp), 'server-owned fields are not sent (the server ignores them anyway)');
ck('C-5', !!dp && !/deleteDoc/.test(strip(dp)) && /op: 'archive'/.test(dp), 'deleteProduct is an ARCHIVE request — no deleteDoc');
ck('C-6', !/deleteDoc\([^)]*'products'/.test(strip(MV2)), 'merchant-v2 has no products deleteDoc anywhere');
ck('C-7', /Archive this product\?/.test(MP) && /you can restore it later/.test(MP) && !/This cannot be undone/.test(MP), 'the Products dialog says Archive, and no longer claims it cannot be undone');
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
