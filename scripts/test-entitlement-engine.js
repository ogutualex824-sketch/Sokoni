/* Stub firebase-admin/firestore BEFORE requiring the engine. */
const Path = require('path');
const store = { paymentIntents:{}, payments:{}, entitlements:{}, entitlementAuditLog:{} };
let auditSeq = 0;
const TS = { fromMillis:(m)=>({toMillis:()=>m}), fromDate:(d)=>({toMillis:()=>d.getTime()}) };
const snap = (col,id)=>({ exists: !!store[col][id], data:()=>store[col][id], id });
function coll(name){ return {
  doc:(id)=>({ _c:name, _id:id, get:async()=>snap(name,id) }),
  add:async(v)=>{ store[name]['a'+(++auditSeq)]=v; return {id:'a'+auditSeq}; },
  where(){return this}, orderBy(){return this}, limit(){return this},
  get:async()=>({docs:[]}),
};}
const fakeDb = {
  collection: coll,
  runTransaction: async (cb) => cb({
    get: async (r)=>snap(r._c, r._id),
    create: (r,v)=>{ if(store[r._c][r._id]) throw new Error('ALREADY_EXISTS'); store[r._c][r._id]=v; },
    set: (r,v)=>{ store[r._c][r._id]=v; },
    update: (r,v)=>{ Object.assign(store[r._c][r._id], v); },
  }),
};
const stub = { getFirestore:()=>fakeDb, FieldValue:{serverTimestamp:()=>'TS'}, Timestamp:TS };
require.cache[require.resolve('firebase-admin/firestore',{paths:[Path.resolve('functions')]})] = { id:'x', filename:'x', loaded:true, exports:stub };

const E = require(Path.resolve('functions/entitlement-engine.js'));

let pass=0, fail=0;
const t=(n,c)=>{ try{ if(c()){pass++;console.log('  PASS  '+n);} else {fail++;console.log('  FAIL  '+n);} }catch(e){fail++;console.log('  FAIL  '+n+'  ('+e.message+')');} };
const throws=(n,fn,code)=>{ try{ fn(); fail++; console.log('  FAIL  '+n+' (did not throw)'); }
  catch(e){ if(!code||e.code===code){pass++;console.log('  PASS  '+n+'  ['+e.code+']');} else {fail++;console.log('  FAIL  '+n+' got '+e.code);} } };

let activated=0;
E.registerPurpose('test_thing', { resourceType:'thing', expiresDays:30, handler:{
  activate: async (txn,ctx)=>{ activated++; return { ref:'things/'+ctx.resourceId }; },
}});

console.log('\n=== registry ===');
t('purpose registered', ()=>E.getPurpose('test_thing')!==null);
t('unknown purpose null', ()=>E.getPurpose('nope')===null);
throws('duplicate registration rejected', ()=>E.registerPurpose('test_thing',{handler:{activate:()=>{}}}));

console.log('\n=== security matrix (assertPaymentHonourable) ===');
const I = (o={})=>Object.assign({purpose:'test_thing',resourceId:'t1',ownerUid:'u1',amountCents:50000,currency:'KES'},o);
const P = (o={})=>Object.assign({status:'COMPLETE',uid:'u1',amountCents:50000,currency:'KES'},o);
t('valid payment passes', ()=>!!E.assertPaymentHonourable(I(),P()));
throws('missing intent',        ()=>E.assertPaymentHonourable(null,P()),      'intent_missing');
throws('missing payment',       ()=>E.assertPaymentHonourable(I(),null),      'payment_missing');
throws('PENDING rejected',      ()=>E.assertPaymentHonourable(I(),P({status:'PENDING'})),  'payment_not_terminal');
throws('REFUNDED rejected',     ()=>E.assertPaymentHonourable(I(),P({status:'REFUNDED'})), 'payment_reversed');
throws('ownership mismatch',    ()=>E.assertPaymentHonourable(I(),P({uid:'attacker'})),    'ownership_mismatch');
throws('underpayment rejected', ()=>E.assertPaymentHonourable(I(),P({amountCents:100})),   'amount_short');
throws('currency mismatch',     ()=>E.assertPaymentHonourable(I(),P({currency:'USD'})),    'currency_mismatch');
throws('expired intent',        ()=>E.assertPaymentHonourable(I({status:'EXPIRED'}),P()),  'intent_expired');
throws('unregistered purpose',  ()=>E.assertPaymentHonourable(I({purpose:'ghost'}),P()),   'purpose_unregistered');
throws('missing resourceId',    ()=>E.assertPaymentHonourable(I({resourceId:null}),P()),   'resource_missing');
t('overpayment allowed', ()=>!!E.assertPaymentHonourable(I(),P({amountCents:99999})));

console.log('\n=== exactly-once invariant ===');
(async()=>{
  store.paymentIntents['REF1']=I();
  store.payments['REF1']=P();
  const r1 = await E.activate('REF1',{source:'webhook'});
  const r2 = await E.activate('REF1',{source:'reconciler'});
  const r3 = await E.activate('REF1',{source:'reconciler'});
  t('first activate creates',      ()=>r1.activated===true);
  t('second returns alreadyActive',()=>r2.alreadyActive===true);
  t('third returns alreadyActive', ()=>r3.alreadyActive===true);
  t('domain activate ran ONCE',    ()=>activated===1);
  t('exactly one ledger doc',      ()=>Object.keys(store.entitlements).length===1);
  t('provenance on ledger only',   ()=>store.entitlements['REF1'].source==='webhook');

  const st = await E.status('REF1');
  t('status ACTIVE',               ()=>st.status==='ACTIVE' && st.found===true);
  const rv = await E.revoke('REF1','refund',{source:'admin'});
  t('revoke works',                ()=>rv.revoked===true);
  const rv2= await E.revoke('REF1','refund',{source:'admin'});
  t('revoke idempotent',           ()=>rv2.alreadyRevoked===true);

  console.log('\n'+(fail? fail+' FAILED':'ALL '+pass+' PASSED'));
  process.exit(fail?1:0);
})();
