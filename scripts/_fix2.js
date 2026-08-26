/* Strengthen two assertions the sabotages proved weak. Written as a file because shell
   heredocs have mangled these regexes four times today. */
const fs = require('fs');
const p = 'scripts/test-merchant-dashboard.js';
let s = fs.readFileSync(p, 'utf8');
const fail = [];
const sub = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { fail.push('matched ' + n + 'x :: ' + a.slice(0, 60)); return; }
  s = s.replace(a, b);
};

/* 1. MIXED RATES — assert the FACT, not just the rendered line. Setting pct while mixed
      stayed true changed no output, so the sabotage passed. */
sub(`  ctx = MONEY({
    readBilling: async () => ({ grossSalesKES: 1000, totalCommissionKES: 50 }),
    queryCommission: async () => ([{ commissionPct: 5 }, { commissionPct: 3 }]),
  });
  host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  ck('mixed ledger rates render as "varies"', /varies across recent sales/.test(host.innerHTML));
  inst.destroy();`,
`  ctx = MONEY({
    readBilling: async () => ({ grossSalesKES: 1000, totalCommissionKES: 50 }),
    queryCommission: async () => ([{ commissionPct: 5 }, { commissionPct: 3 }]),
  });
  host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  ck('mixed ledger rates render as "varies"', /varies across recent sales/.test(host.innerHTML));
  inst.destroy();

  /* The FACT, not only the rendering. Setting pct while mixed stayed true produced
     identical output, so asserting the rendered line alone proved nothing. */
  {
    const facts = await D._loadFacts(MONEY({
      queryCommission: async () => ([{ commissionPct: 5 }, { commissionPct: 3 }]),
    }));
    ck('with disagreeing entries, NO single rate is chosen',
       facts.rate && facts.rate.mixed === true && facts.rate.pct === null,
       'pct=' + (facts.rate && facts.rate.pct) + ' — picking one averages away a real difference');
    const one = await D._loadFacts(MONEY({
      queryCommission: async () => ([{ commissionPct: 5 }, { commissionPct: 5 }]),
    }));
    ck('CONTROL: agreeing entries DO yield a single rate',
       one.rate && one.rate.mixed === false && one.rate.pct === 5);
  }`);

/* 2. HALF-KNOWN EARNINGS — scope to the flow row instead of a windowed lookahead. */
sub(`  ctx = MONEY({ readBilling: async () => ({ grossSalesKES: 5000 }) });   /* commission absent */
  host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  ck('sales known but commission unknown → earnings stay UNKNOWN',
     /KES 5,000/.test(host.innerHTML) && !/KES 5,000[\\s\\S]{0,400}Your earnings[\\s\\S]{0,80}KES/.test(host.innerHTML),
     'deriving from one known and one unknown is a confident number built on a guess');
  inst.destroy();`,
`  ctx = MONEY({ readBilling: async () => ({ grossSalesKES: 5000 }) });   /* commission absent */
  host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  {
    /* Read the earnings ROW directly. A windowed lookahead across the whole card could
       not distinguish "no earnings figure" from "the figure is further away than the
       window reached", and the sabotage slipped through on exactly that. */
    const h = host.innerHTML;
    const row = h.slice(h.indexOf('sd-flow-net'), h.indexOf('sd-comm-a'));
    ck('CONTROL: the earnings row was located', row.length > 60, row.length + ' chars');
    ck('sales are known', /KES 5,000/.test(h));
    ck('but earnings stay UNKNOWN when commission is missing',
       row.indexOf('—') > -1 && row.indexOf('KES') < 0,
       'deriving from one known and one unknown is a confident number built on a guess');
  }
  inst.destroy();`);

if (fail.length) { console.error(fail.join('\n')); process.exit(9); }
fs.writeFileSync(p, s);
console.log('two assertions strengthened');
