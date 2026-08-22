/* Verify the f4422b4 fix at the QUERY level, read-only, without invoking the
   callable: run BOTH shapes against production and observe which throws. */
const path=require('path');
const admin=require(path.join('C:/temp/sok-release-admin','functions','node_modules','firebase-admin'));
try{admin.initializeApp({projectId:'sokoni-aeb26'});}catch(_){}
const db=admin.firestore();
(async()=>{
  /* OLD shape — the one the log showed throwing 9 FAILED_PRECONDITION */
  let oldRes;
  try{ const s=await db.collection('ops_reports').orderBy('__name__','desc').limit(7).get();
       oldRes='SUCCEEDED ('+s.size+' docs)'; }
  catch(e){ oldRes='THREW  '+(e.code||'')+' '+String(e.message).slice(0,60); }
  console.log('  OLD  orderBy(__name__,desc).limit(7)   ' + oldRes);

  /* NEW shape — computed date keys via getAll */
  let newRes;
  try{
    const keys=[]; for(let i=0;i<7;i++) keys.push(new Date(Date.now()-i*86400000).toISOString().slice(0,10));
    const docs=await db.getAll(...keys.map(k=>db.collection('ops_reports').doc(k)));
    const present=docs.filter(d=>d.exists);
    const rates=present.map(d=>d.data().paymentSuccessRate).filter(r=>typeof r==='number');
    newRes='SUCCEEDED ('+present.length+'/7 present, '+rates.length+' with paymentSuccessRate)';
  }catch(e){ newRes='THREW  '+(e.code||'')+' '+String(e.message).slice(0,60); }
  console.log('  NEW  getAll(7 date keys)              ' + newRes);

  /* the sibling defect in getTopBusinessPriorities */
  let f1,f2;
  try{ const s=await db.collection('funnelStats').orderBy('__name__','desc').limit(30).get(); f1='SUCCEEDED ('+s.size+')'; }
  catch(e){ f1='THREW  '+(e.code||''); }
  try{ const keys=[]; for(let i=0;i<30;i++) keys.push(new Date(Date.now()-i*86400000).toISOString().slice(0,10));
       const d=await db.getAll(...keys.map(k=>db.collection('funnelStats').doc(k)));
       f2='SUCCEEDED ('+d.filter(x=>x.exists).length+'/30 present)'; }
  catch(e){ f2='THREW  '+(e.code||''); }
  console.log('  OLD  funnelStats orderBy(__name__)     ' + f1);
  console.log('  NEW  funnelStats getAll(30 date keys)  ' + f2);
})().catch(e=>console.log('FAILED',e.message));
