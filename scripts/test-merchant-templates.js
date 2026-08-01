#!/usr/bin/env node
/* Merchant category templates — contract.

   The value of a template is that it stays DATA. The assertions that matter most
   are the negative ones: no price is invented, no barcode is invented, nothing
   is listed before a merchant prices it, and the template declares capabilities
   rather than implementing them. */
'use strict';

const path = require('path');
const T = require(path.resolve(__dirname, '..', 'sokoni-merchant-templates.js'));
const fs = require('fs');

let pass = 0, fail = 0;
const ok  = (n, d) => { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d) => { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const check = (c, n, d) => { c ? ok(n, d) : bad(n, d); };

console.log('\nMerchant templates');
console.log('──────────────────');

check(T.list().includes('water-supplier'), 'water-supplier template exists');
check(T.get('nonexistent-category') === null,
  'an unknown category returns null, not a throw', 'no preset is a valid outcome');

const w = T.get('water-supplier');
check(!!w && w.hub === 'shopping', 'declares its hub', w && w.hub);

/* The category must exist in the registry too, or onboarding cannot offer it. */
const reg = fs.readFileSync(path.resolve(__dirname, '..', 'hub-register.js'), 'utf8');
check(/id:'water-supplier'/.test(reg), 'category is registered in hub-register.js CATS');

console.log('\nCapabilities are declared, not implemented');
console.log('──────────────────────────────────────────');
for (const cap of ['pos', 'multi-till', 'shared-inventory', 'delivery', 'staff',
                   'reports', 'barcode', 'wholesale-pricing', 'credit-accounts',
                   'returnable-units']) {
  check(T.has('water-supplier', cap), `capability: ${cap}`);
}
const src = fs.readFileSync(path.resolve(__dirname, '..', 'sokoni-merchant-templates.js'), 'utf8');
check(!/if\s*\(\s*categoryId\s*===\s*['"]water/.test(src),
  'no per-category branching in the template module',
  'a category needing code means the capability belongs in the platform');
check(!/firestore|addDoc|setDoc|collection\(/i.test(src),
  'the template performs no writes', 'it is data, not a provisioning script');

console.log('\nProduct presets — nothing invented');
console.log('──────────────────────────────────');
const prods = T.productsFor('water-supplier', 'DASH01');
check(prods.length === 6, 'six presets', String(prods.length));
check(prods.every(p => p.price === null),
  'no price is invented', 'a made-up price would face a real customer');
check(prods.every(p => p.barcode === ''),
  'no barcode is invented', 'a barcode belongs to the product, not to us');
check(prods.every(p => p.status === 'draft'),
  'nothing is listed until the merchant prices it');
check(new Set(prods.map(p => p.sku)).size === 6, 'SKUs are unique');
check(prods.every(p => p.sku.startsWith('DASH01')),
  'SKUs are bound to the merchant', prods[0].sku + ' …');
check(T.productsFor('water-supplier', 'OTHER1')[0].sku !== prods[0].sku,
  'two merchants cannot collide on SKU');
check(prods.filter(p => p.returnable).length === 3,
  'the three large formats are returnable', '20L refill, 20L bottle, 10L');
check(prods.every(p => 'batchNumber' in p && 'expiryDate' in p),
  'batch and expiry are carried on every preset');

console.log('\nReturnable units are inventory subtypes');
console.log('───────────────────────────────────────');
check(w.returnableUnits && w.returnableUnits.enabled, 'declared');
check(JSON.stringify(w.returnableUnits.subtypes) ===
      JSON.stringify(['filled', 'empty', 'on-loan', 'damaged']),
  'four subtypes on one product');
check(w.returnableUnits.reconcileAgainst === 'product',
  'reconciled against the product, not a separate ledger',
  'a second inventory is the split this platform has been removing');

console.log('\nDelivery is configurable, never hardcoded');
console.log('─────────────────────────────────────────');
check(w.deliveryModes.length === 5, 'five modes offered', w.deliveryModes.join(', '));
check(w.deliveryModes.includes('free') && w.deliveryModes.includes('pickup-only'),
  'free and pickup-only are both available');
check(w.defaultDeliveryMode !== 'free',
  'free is NOT the default', 'defaulting to free would give away a merchant’s margin');

console.log('\nIsolation');
console.log('─────────');
const a = T.get('water-supplier'); a.capabilities.push('mutated');
check(T.get('water-supplier').capabilities.indexOf('mutated') === -1,
  'get() returns a copy', 'a caller cannot corrupt the registry');

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
