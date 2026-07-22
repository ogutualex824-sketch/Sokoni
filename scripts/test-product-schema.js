#!/usr/bin/env node
/* Gate: shared product schema populate/serialize/validate — the Phase 1A
   single source of truth for ordinary product fields. */
const S = require('../sokoni-product-schema.js');

/* DOM stub: a form of inputs keyed by id, mirroring populate/serialize contract. */
function makeDoc(){
  const nodes={};
  return {
    _nodes:nodes,
    getElementById(id){ return nodes[id] || (nodes[id]={value:'',checked:false}); },
  };
}
let pass=0,fail=0;
function ok(l,c){ c?pass++:fail++; console.log('  '+(c?'PASS  ':'FAIL  ')+l); }

/* 1. populate then serialize round-trips a full product */
const doc=makeDoc();
const product={ name:'Solo Bar', price:2000, category:'vape', stock:5, costPrice:1050,
  deliveryCost:150, location:'Nairobi', wholesalePrice:1800, minWholesaleQty:12, description:'Disposable' };
S.populate('edit', product, doc);
ok('populate sets editName',  doc.getElementById('editName').value==='Solo Bar');
ok('populate sets editCategory vape', doc.getElementById('editCategory').value==='vape');
const out=S.serialize('edit', doc);
ok('serialize round-trips category', out.category==='vape');
ok('serialize numbers are numbers', out.price===2000 && out.costPrice===1050);
ok('serialize wholesale kept',      out.wholesalePrice===1800 && out.minWholesaleQty===12);

/* 2. blank emptyKeeps field is OMITTED (never zeroes a stored value) */
const doc2=makeDoc();
S.populate('edit', {name:'X',price:100,category:'other'}, doc2);   // cost/delivery blank
const out2=S.serialize('edit', doc2);
ok('blank costPrice omitted, not 0',   !('costPrice' in out2));
ok('blank deliveryCost omitted, not 0',!('deliveryCost' in out2));
ok('blank location omitted',           !('location' in out2));

/* 3. wholesale price 0 clears both */
const doc3=makeDoc();
doc3.getElementById('editName').value='X'; doc3.getElementById('editPrice').value='100';
doc3.getElementById('editWholesalePrice').value='0'; doc3.getElementById('editMinWholesaleQty').value='12';
const out3=S.serialize('edit', doc3);
ok('wholesale 0 → price null',  out3.wholesalePrice===null);
ok('wholesale 0 → minQty null', out3.minWholesaleQty===null);

/* 4. validate blocks missing name/price */
const doc4=makeDoc();
doc4.getElementById('editPrice').value='100';   // no name
ok('validate fails on missing name', S.validate('edit', doc4).ok===false);
doc4.getElementById('editName').value='X';
ok('validate passes with name+price', S.validate('edit', doc4).ok===true);

/* 5. same schema works for the UPLOAD prefix — this is the anti-drift guarantee */
const doc5=makeDoc();
S.populate('product', {name:'Up',price:50,category:'food'}, doc5);
ok('schema drives product prefix too', doc5.getElementById('productName').value==='Up');

console.log('\n  '+pass+'/'+(pass+fail)+' — shared schema populate/serialize/validate');
process.exit(fail?1:0);
