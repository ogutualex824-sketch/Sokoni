'use strict';
/**
 * eTIMS canonical Tax Engine — determinism + correctness + behaviour-equivalence guard.
 *
 *   node scripts/test-etims-tax-engine.js
 *
 * Doubles as the "tax calculations are deterministic" release gate. Proves:
 *   1. VAT-inclusive standard/zero/exempt math is correct.
 *   2. Discounts, multi-line totals, and A–E bucketing are correct.
 *   3. Output is DETERMINISTIC (same input → byte-identical output).
 *   4. Credit notes are the exact negation of the sale (no drift).
 *   5. Conservation: for a standard line, taxblAmt + taxAmt == net.
 *   6. BEHAVIOUR-EQUIVALENCE: the engine matches the currently-DEPLOYED
 *      functions/etims.js calcLine/calcTotals bit-for-bit over a fuzz sweep — so
 *      delegating the live path to the engine changes no KRA figure.
 */
const E = require('../functions/etims-tax-engine');

/* ── Replica of the DEPLOYED functions/etims.js math (kept in lockstep for the
      equivalence check). If etims.js changes, update here and the engine together. ── */
const VAT_RATE = 0.16;
const _r2 = (n) => Math.round((n || 0) * 100) / 100;
function deployedCalcLine(item, vatStatus) {
  const qty = item.quantity || 1, prc = item.unitPrice || 0, dcRt = item.discountRate || 0;
  const sply = _r2(qty * prc), dcAmt = _r2(sply * dcRt / 100), net = _r2(sply - dcAmt);
  let vatCatCd, taxblAmt, taxAmt;
  if (vatStatus === 'registered') { vatCatCd = 'A'; taxblAmt = _r2(net / (1 + VAT_RATE)); taxAmt = _r2(net - taxblAmt); }
  else if (vatStatus === 'zero_rated') { vatCatCd = 'B'; taxblAmt = net; taxAmt = 0; }
  else { vatCatCd = 'C'; taxblAmt = 0; taxAmt = 0; }
  return { itemSeq: item.seq || 1, itemClsCd: item.itemClassCode || '57111500', itemNm: String(item.name || 'Item').slice(0, 100),
    pkgUnitCd: 'NT', pkg: qty, qtyUnitCd: 'U', qty, prc, splyAmt: sply, dcRt, dcAmt, vatCatCd, taxblAmt, taxAmt, totAmt: net };
}
function deployedCalcTotals(lines) {
  const t = { taxblAmtA:0,taxblAmtB:0,taxblAmtC:0,taxblAmtD:0,taxblAmtE:0, taxAmtA:0,taxAmtB:0,taxAmtC:0,taxAmtD:0,taxAmtE:0 };
  for (const l of lines) { if (l.vatCatCd==='A'){t.taxblAmtA+=l.taxblAmt;t.taxAmtA+=l.taxAmt;} if (l.vatCatCd==='B'){t.taxblAmtB+=l.taxblAmt;} if (l.vatCatCd==='C'){t.taxblAmtC+=l.taxblAmt;} }
  const totTaxblAmt=_r2(t.taxblAmtA+t.taxblAmtB+t.taxblAmtC), totTaxAmt=_r2(t.taxAmtA), totAmt=_r2(lines.reduce((s,l)=>s+l.totAmt,0));
  return { ...Object.fromEntries(Object.entries(t).map(([k,v])=>[k,_r2(v)])), totTaxblAmt, totTaxAmt, totAmt };
}

let pass = 0, fail = 0;
const near = (a, b) => Math.abs(a - b) < 0.005;
const check = (name, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); };

console.log('\n=== eTIMS canonical Tax Engine — determinism + equivalence guard ===');

/* 1. Standard-rated inclusive: 116 incl = 100 taxable + 16 VAT */
{
  const l = E.computeLine({ unitPrice: 116, quantity: 1 }, 'registered');
  check('1a standard: taxable 100', near(l.taxblAmt, 100));
  check('1b standard: VAT 16',       near(l.taxAmt, 16));
  check('1c standard: gross 116',    near(l.totAmt, 116));
  check('1d conservation: taxbl+tax==net', near(l.taxblAmt + l.taxAmt, l.totAmt));
}

/* 2. Discount: 2×100 −10% = 180 incl → 155.17 taxable + 24.83 VAT */
{
  const l = E.computeLine({ unitPrice: 100, quantity: 2, discountRate: 10 }, 'registered');
  check('2a discount net 180', near(l.totAmt, 180));
  check('2b discount taxable 155.17', near(l.taxblAmt, 155.17));
  check('2c discount VAT 24.83', near(l.taxAmt, 24.83));
}

/* 3. Zero-rated + exempt */
{
  const z = E.computeLine({ unitPrice: 200, quantity: 1 }, 'zero_rated');
  check('3a zero-rated: taxable==net, VAT 0', near(z.taxblAmt, 200) && z.taxAmt === 0 && z.vatCatCd === 'B');
  const x = E.computeLine({ unitPrice: 200, quantity: 1 }, 'exempt');
  check('3b exempt: taxable 0, VAT 0', x.taxblAmt === 0 && x.taxAmt === 0 && x.vatCatCd === 'C');
}

/* 4. Multi-line invoice totals + bucketing */
{
  const inv = E.computeInvoice({ items: [
    { unitPrice: 116, quantity: 1, vatStatus: 'registered' },
    { unitPrice: 50,  quantity: 2, vatStatus: 'zero_rated' },
    { unitPrice: 30,  quantity: 1, vatStatus: 'exempt' },
  ]});
  check('4a totAmt 116+100+30=246', near(inv.totals.totAmt, 246));
  check('4b VAT total == 16 (only cat A)', near(inv.totals.totTaxAmt, 16));
  check('4c taxable A 100 / B 100 / C 0', near(inv.totals.taxblAmtA,100) && near(inv.totals.taxblAmtB,100) && near(inv.totals.taxblAmtC,0));
  check('4d summary grossTotal 246', near(inv.taxSummary.grossTotal, 246));
}

/* 5. Determinism — same input → byte-identical output */
{
  const args = { items: [{ unitPrice: 116, quantity: 3, discountRate: 5, vatStatus: 'registered' }] };
  const a = JSON.stringify(E.computeInvoice(args));
  const b = JSON.stringify(E.computeInvoice(args));
  check('5 deterministic (identical JSON)', a === b);
}

/* 6. Credit note is the exact negation of the sale */
{
  const items = [{ unitPrice: 116, quantity: 2, vatStatus: 'registered' }];
  const sale = E.computeInvoice({ items });
  const cn   = E.computeCreditNote({ items });
  check('6a credit note totAmt negated', near(cn.totals.totAmt, -sale.totals.totAmt));
  check('6b credit note VAT negated',    near(cn.totals.totTaxAmt, -sale.totals.totTaxAmt));
  check('6c credit line taxbl negated',  near(cn.lines[0].taxblAmt, -sale.lines[0].taxblAmt));
}

/* 7. BEHAVIOUR-EQUIVALENCE vs the deployed etims.js math over a fuzz sweep */
{
  const statuses = ['registered', 'zero_rated', 'exempt'];
  let mism = 0, n = 0;
  for (let p = 1; p <= 2500; p += 37) {
    for (let q = 1; q <= 9; q += 2) {
      for (let d = 0; d <= 30; d += 7) {
        for (const s of statuses) {
          const item = { unitPrice: p + 0.5, quantity: q, discountRate: d, name: 'X', seq: 1 };
          const eng = E.computeLine(item, s);
          const dep = deployedCalcLine(item, s);
          if (JSON.stringify(eng) !== JSON.stringify(dep)) { mism++; if (mism <= 3) console.log('   ↳ mismatch', JSON.stringify({ item, s, eng, dep })); }
          n++;
        }
      }
    }
  }
  check(`7a line math matches deployed etims.js across ${n} cases`, mism === 0);

  // totals equivalence on a mixed invoice
  const lines = [
    E.computeLine({ unitPrice: 116, quantity: 1, seq: 1 }, 'registered'),
    E.computeLine({ unitPrice: 232, quantity: 2, discountRate: 12, seq: 2 }, 'registered'),
    E.computeLine({ unitPrice: 75,  quantity: 3, seq: 3 }, 'zero_rated'),
    E.computeLine({ unitPrice: 40,  quantity: 1, seq: 4 }, 'exempt'),
  ];
  check('7b totals match deployed etims.js', JSON.stringify(E.computeTotals(lines)) === JSON.stringify(deployedCalcTotals(lines)));
}

/* 8. EXCLUSIVE mode (hub policy) + equivalence to the deployed hub math */
{
  // 100 excl @16% → taxable 100, VAT 16, gross 116
  const l = E.computeLine({ unitPrice: 100, quantity: 1 }, 'registered', { inclusive: false });
  check('8a exclusive: taxable 100, VAT 16, gross 116', near(l.taxblAmt,100) && near(l.taxAmt,16) && near(l.totAmt,116));
  const z = E.computeLine({ unitPrice: 100, quantity: 1 }, 'zero_rated', { inclusive: false });
  check('8b exclusive zero-rated: VAT 0, gross 100', z.taxAmt === 0 && near(z.totAmt,100));

  // Equivalence vs deployed hub-etims.js: lineVat = round(price*qty * vatRate/100)
  const hubLineVat = (price, qty, vatStatus) => {
    const vatRate = vatStatus === 'zero_rated' ? 0 : 16;
    return Math.round((price * qty) * (vatRate / 100) * 100) / 100;
  };
  let mism = 0, n = 0;
  for (let p = 1; p <= 3000; p += 41) {
    for (let q = 1; q <= 8; q += 3) {
      for (const s of ['registered', 'zero_rated']) {
        const eng = E.computeLine({ unitPrice: p + 0.25, quantity: q }, s, { inclusive: false }).taxAmt;
        const hub = hubLineVat(p + 0.25, q, s);
        if (!near(eng, hub)) { mism++; if (mism <= 3) console.log('   ↳ hub mismatch', { p: p+0.25, q, s, eng, hub }); }
        n++;
      }
    }
  }
  check(`8c line VAT matches deployed hub math across ${n} cases`, mism === 0);
}

console.log(`\n${fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' PASSED'}`);
process.exitCode = fail ? 1 : 0;
