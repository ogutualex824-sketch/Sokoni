#!/usr/bin/env node
/* Construction category → server mapping (owner 2026-10-03: "a category must not appear in the UI with no functioning
   backend capability"). For every construction category in the ONE intake (hub-register.js on INTAKE_REF):
     - business-category.FROM_BUSINESS_ID classifies it to an EXISTING category (map, don't add);
     - its service capabilities (if any) all exist in shared/service-capabilities CAPABILITIES;
     - the materials supplier stays a goods seller (merchant-v2), with no service capability.
   The intake is read from git; if unreadable the parity rows FAIL (an unchecked mapping is not a pass). */
'use strict';
const path = require('path'), { execSync } = require('child_process');
const R = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (id, c, m, got) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (c || got === undefined ? '' : '   [' + JSON.stringify(got).slice(0, 200) + ']')); c ? pass++ : fail++; };
const BC = require(path.join(R, 'functions', 'business-category.js'));
const SC = require(path.join(R, 'functions', 'shared', 'service-capabilities.js'));
const ref = process.env.INTAKE_REF || 'hosting/construction-intake-on-d824b58';
let HR = null; try { HR = execSync('git show ' + ref + ':hub-register.js', { cwd: R, encoding: 'utf8', maxBuffer: 64 << 20 }); } catch (e) { HR = null; }
ok('P0', !!HR, 'intake read from ' + ref);
const cats = HR ? (HR.match(/\{ id:'[a-z-]+',\s+label:'[^']+',\s+hub:'construction'/g) || []).map((m) => m.match(/id:'([a-z-]+)'/)[1]) : [];
ok('P1', cats.length >= 8, 'the intake lists the construction trades', cats);
const FROM = BC.FROM_BUSINESS_ID || (BC._internal && BC._internal.FROM_BUSINESS_ID);
const CATS = BC.CATEGORIES || (BC._internal && BC._internal.CATEGORIES);
const SFROM = SC.FROM_BUSINESS_ID || (SC._internal && SC._internal.FROM_BUSINESS_ID);
const CAPS = SC.CAPABILITIES || (SC._internal && SC._internal.CAPABILITIES);
ok('P2', !!FROM && !!CATS && !!SFROM && !!CAPS, 'mapping tables are exported for certification');
const unmapped = cats.filter((c) => !(FROM && Object.prototype.hasOwnProperty.call(FROM, c) && FROM[c] && CATS[FROM[c]]));
ok('M1', cats.length > 0 && unmapped.length === 0, 'every construction trade classifies to an EXISTING business category', unmapped);
const badCaps = cats.filter((c) => (SFROM[c] || []).some((k) => !CAPS[k]));
ok('M2', badCaps.length === 0, 'every service capability granted to a construction trade exists (none invented)', badCaps);
ok('M3', FROM && FROM.hardware === 'hardware' && !(SFROM.hardware || []).length, 'materials supplier = hardware (goods seller on merchant-v2), no service capability');
const service = cats.filter((c) => c !== 'hardware');
const noCaps = service.filter((c) => !(SFROM[c] || []).length);
ok('M4', noCaps.length === 0, 'every construction SERVICE trade has a booking / quote capability (no dead category)', noCaps);
ok('M5', service.every((c) => (SFROM[c] || []).indexOf('QUOTE_REQUEST') !== -1), 'every construction service is quote-capable (contractor model: quotes, 0% commission)');
ok('M6', FROM && FROM.architect === 'professional_services' && FROM['construction-architect'] === 'professional_services', 'bare architect untouched; construction-architect → professional_services');
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
