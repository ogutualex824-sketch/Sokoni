#!/usr/bin/env node
/* One-off: set status=active where absent, so legacy products are findable by the
   status-filtered search and share the lifecycle field soft-delete flips to archived.
   119/129 products had no status; the search requires status in [active,published,approved].
   Owner token via gcloud; additive single-field write. */
/* Backfill status='active' ONLY where status is absent. Does not touch the 10
   already-active or any archived/other status. Additive, one field. */
const https=require('https'),fs=require('fs');
const TOK=fs.readFileSync(process.argv[2],'utf8').trim();
const APPLY=process.argv.includes('--apply');
const HOST='firestore.googleapis.com', BASE='/v1/projects/sokoni-aeb26/databases/(default)/documents';
function req(method,path,body){return new Promise((res,rej)=>{const data=body?JSON.stringify(body):null;const r=https.request({host:HOST,path,method,headers:Object.assign({Authorization:'Bearer '+TOK},data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{})},x=>{let s='';x.on('data',d=>s+=d);x.on('end',()=>res({code:x.statusCode,json:(()=>{try{return JSON.parse(s)}catch(e){return s}})()}));});r.on('error',rej);if(data)r.write(data);r.end();});}
(async()=>{
  const j=(await req('GET',BASE+'/products?pageSize=300')).json;
  const all=(j.documents||[]).map(d=>({id:d.name.split('/').pop(),f:d.fields||{}}));
  const noStatus=all.filter(p=>!p.f.status);
  console.log('  '+all.length+' products, '+noStatus.length+' with NO status → set active   mode '+(APPLY?'APPLY':'DRY RUN'));
  let wrote=0,failed=0;
  for(const p of noStatus){
    if(!APPLY) continue;
    const r=await req('PATCH',BASE+'/products/'+p.id+'?updateMask.fieldPaths=status',{fields:{status:{stringValue:'active'}}});
    if(r.code===200)wrote++;else{failed++;console.log('    FAIL '+r.code);}
  }
  if(APPLY)console.log('  wrote '+wrote+', failed '+failed);
})();
