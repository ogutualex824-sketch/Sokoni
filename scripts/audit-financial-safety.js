#!/usr/bin/env node
/* ================================================================
   SOKONI — Financial Safety Audit  (READ-ONLY, CI-capable)
   scripts/audit-financial-safety.js

   Enforces FINANCIAL_TRANSACTION_STANDARD.md across every money-touching
   code path. It NEVER modifies code.

     node scripts/audit-financial-safety.js          # report + matrix
     node scripts/audit-financial-safety.js --ci     # exit 1 on any violation

   DETECTS (the three defect classes that produced P0-2, P0-3, P0-4):

   V1  auto-ID .add() into a money collection
       → a retry appends a SECOND ledger row. Ledger ids MUST be deterministic.

   V2  FieldValue.increment() on a money field OUTSIDE a transaction handle
       → increments are NOT idempotent. A retry/at-least-once redelivery
         double-counts. (This is exactly how P0-3 double-billed sellers.)

   V3  racy idempotency claim: get() -> if(exists) return -> set()
       → two concurrent deliveries both pass the check. Use create()
         (atomic set-if-not-exists) or a transaction.

   A site is PROTECTED when it either
     (a) uses a transaction handle  (txn./t./tx./t2. .set|.update), or
     (b) lives in a file that acquires an ATOMIC idempotency lock (.create()),
         or writes with a DETERMINISTIC id (.doc(<expr>).set(...)).
================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const CI = process.argv.includes('--ci');
const FN = path.join(__dirname, '..', 'functions');

/* Collections that hold money or money-equivalent value. */
const MONEY_COLLECTIONS = [
  'commissionLedger', 'ledger', 'generalLedger', 'sellerPayments', 'payments',
  'posPayments', 'walletTxns', 'walletTransactions', 'wallets', 'payouts',
  'sellerPayouts', 'settlements', 'fosTransactions', 'transactions',
  'escrow', 'refunds', 'sellerBilling',
];

/* Fields whose value is money / money-equivalent (credits, points redeemable for value). */
const MONEY_FIELD = /(balance|amountCents|amount|commission|gross|net|owed|earnings|payout|settle|credit|debit|revenue|totalPaid|totalSpend|lifetime|withdrawable)/i;

const TXN_HANDLE = /\b(txn|tx|t|t2|transaction)\s*\.\s*(set|update|delete|create)\s*\(/;

const files = fs.readdirSync(FN).filter((f) => f.endsWith('.js'));
const violations = [];
const protectedSites = [];

for (const f of files) {
  const src = fs.readFileSync(path.join(FN, f), 'utf8');
  const lines = src.split('\n');

  /* File-level protections. */
  const hasAtomicLock   = /\.create\s*\(/.test(src);
  const hasTransaction  = /runTransaction\s*\(/.test(src);

  /* Track block-comment state — a financial auditor must never flag prose.
     (An earlier version flagged its own explanatory comment, which is exactly the
     kind of false positive that gets a security tool ignored.) */
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const raw  = line.trim();

    const opens  = (line.match(/\/\*/g) || []).length;
    const closes = (line.match(/\*\//g) || []).length;
    const wasInComment = inBlockComment;
    if (opens > closes) inBlockComment = true;
    else if (closes > opens) inBlockComment = false;
    if (wasInComment || inBlockComment) continue;          // skip block-comment bodies

    if (raw.startsWith('*') || raw.startsWith('//') || raw.startsWith('/*')) continue;

    const ctx = lines.slice(Math.max(0, i - 12), i + 3).join('\n');
    const inTxnBlock = TXN_HANDLE.test(ctx) || /runTransaction\s*\(\s*async/.test(ctx);

    /* ── V1: auto-ID .add() into a money collection ── */
    const addHit = line.match(/collection\(\s*['"]([A-Za-z_]+)['"]\s*\)\s*\.add\(/);
    if (addHit && MONEY_COLLECTIONS.includes(addHit[1])) {
      violations.push({ v: 'V1', file: f, line: i + 1, coll: addHit[1],
        detail: `auto-ID .add() into money collection "${addHit[1]}" — a retry appends a duplicate row`,
        code: raw.slice(0, 90) });
      continue;
    }

    /* ── V2: money increment outside a transaction handle ── */
    if (/increment\s*\(/.test(line) && MONEY_FIELD.test(line.split(':')[0] || '')) {
      if (inTxnBlock) {
        protectedSites.push({ file: f, line: i + 1, why: 'transaction handle', code: raw.slice(0, 70) });
      } else if (hasAtomicLock) {
        protectedSites.push({ file: f, line: i + 1, why: 'file holds an atomic create() idempotency lock', code: raw.slice(0, 70) });
      } else {
        violations.push({ v: 'V2', file: f, line: i + 1,
          detail: 'FieldValue.increment() on a money field with NO transaction handle and NO atomic idempotency lock in file — NOT idempotent; a retry double-counts',
          code: raw.slice(0, 90) });
      }
    }
  }

  /* ── V3: racy idempotency claim (get -> exists -> set) ── */
  for (let i = 0; i < lines.length - 6; i++) {
    const win = lines.slice(i, i + 7).join('\n');
    if (/idem|idempot/i.test(win) && /\.get\(\)/.test(win) && /\.exists/.test(win) && /\.set\(/.test(win) && !/\.create\(/.test(win)) {
      violations.push({ v: 'V3', file: f, line: i + 1,
        detail: 'racy idempotency claim: get() -> if(exists) -> set(). Two concurrent deliveries both pass. Use create().',
        code: lines[i].trim().slice(0, 90) });
      break;
    }
  }
}

/* ── Report ─────────────────────────────────────────────────────── */
console.log('SOKONI — FINANCIAL SAFETY AUDIT\n');
console.log('Scanned', files.length, 'modules in functions/\n');

console.log('COMPLIANCE MATRIX');
console.log('  V1  auto-ID .add() into money collection      :', violations.filter(x => x.v === 'V1').length, 'violation(s)');
console.log('  V2  non-idempotent money increment            :', violations.filter(x => x.v === 'V2').length, 'violation(s)');
console.log('  V3  racy get/exists/set idempotency claim     :', violations.filter(x => x.v === 'V3').length, 'violation(s)');
console.log('  ──  protected money sites                     :', protectedSites.length);

if (violations.length) {
  console.log('\n❌ VIOLATIONS\n');
  for (const x of violations) {
    console.log(`  [${x.v}] ${x.file}:${x.line}`);
    console.log(`        ${x.detail}`);
    console.log(`        > ${x.code}\n`);
  }
} else {
  console.log('\n✅ No violations. Every money-touching site is protected by an atomic');
  console.log('   transaction and/or a deterministic idempotency guard.');
}

if (process.argv.includes('--verbose')) {
  console.log('\nPROTECTED SITES');
  protectedSites.forEach((p) => console.log(`  ${p.file}:${p.line}  (${p.why})`));
}

if (CI) {
  if (violations.length) {
    console.error('\n❌ CI FAIL — financial safety standard violated.');
    console.error('   See docs/FINANCIAL_TRANSACTION_STANDARD.md');
    process.exit(1);
  }
  console.log('\n✅ CI PASS — financial safety standard upheld.');
}
process.exit(0);
