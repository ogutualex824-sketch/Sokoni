'use strict';
/**
 * scripts/onboard-batch2.js — four requested placements, each in its correct
 * registry, all keyed by Auth uid so a re-run updates rather than duplicates.
 *
 *   [DJ]    add phone +254799948498 to the DJ account so the owner can sign in,
 *           and set it as the listing's contact number.
 *   [FAHIM] create fahimmarisa@gmail.com (+254713735027) as "Automate Fahim",
 *           a mechanic → mechanics/automate-fahim, searchable.
 *   [TMM]   add the REAL firm T.M.M & Partners Advocates to legalProviders
 *           (shown on legal-hub) and lawyers (global search). No LSK number is
 *           fabricated — it is left blank for the firm to supply, so this is a
 *           real-but-unverified entry, never an invented advocate.
 *   [KASS]  make KASS VAPES searchable → sellers/{uid}.
 *
 *   node scripts/onboard-batch2.js            # dry run
 *   node scripts/onboard-batch2.js --apply
 *
 * NO FABRICATION: names/phones/emails come from the accounts' own data or the
 * explicit request. verified/featured are false; ratings/counters zero; owner-
 * supplied fields (LSK number, address, logo, pricing) are left absent and
 * flagged pending. New Auth passwords are random and never printed.
 */

const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

const APPLY   = process.argv.includes('--apply');
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE';
const HOST='firestore.googleapis.com', IT='identitytoolkit.googleapis.com';
const BASE='/v1/projects/'+PROJECT+'/databases/(default)/documents';

const BUNDLED_PY = process.env.LOCALAPPDATA
  ? process.env.LOCALAPPDATA + '\\Google\\Cloud SDK\\google-cloud-sdk\\platform\\bundledpython\\python.exe' : null;
let _tok=null;
function tokn(){ if(_tok)return _tok; if(process.env.GCLOUD_ACCESS_TOKEN)return(_tok=process.env.GCLOUD_ACCESS_TOKEN.trim());
  const env=Object.assign({},process.env); if(BUNDLED_PY&&!env.CLOUDSDK_PYTHON)env.CLOUDSDK_PYTHON=BUNDLED_PY;
  _tok=execSync('gcloud auth print-access-token',{encoding:'utf8',stdio:['ignore','pipe','pipe'],env}).trim(); return _tok; }
function req(method,host,path,body,useKey){return new Promise((res,rej)=>{const data=body?JSON.stringify(body):null;
  const h=useKey?{}:{Authorization:'Bearer '+tokn(),'x-goog-user-project':PROJECT};
  if(data){h['Content-Type']='application/json';h['Content-Length']=Buffer.byteLength(data);}
  const r=https.request({host,path,method,headers:h},x=>{let o='';x.on('data',c=>o+=c);x.on('end',()=>res({status:x.statusCode,body:o}));});
  r.on('error',rej); if(data)r.write(data); r.end();});}

const S=v=>({stringValue:String(v)}),I=v=>({integerValue:String(v)}),B=v=>({booleanValue:!!v}),
  T=v=>({timestampValue:v}),A=a=>({arrayValue:{values:a.map(S)}}),M=o=>({mapValue:{fields:o}});
const plain=v=>v&&(v.stringValue??v.booleanValue??(v.integerValue!=null?Number(v.integerValue):null));
const NOW=new Date().toISOString();
const terms=list=>{const out=new Set();list.filter(Boolean).forEach(s=>{const t=String(s).toLowerCase().trim();
  if(t)out.add(t);t.split(/[\s,&/]+/).forEach(w=>{if(w.length>2)out.add(w);});});return[...out];};
async function patch(col,id,fields){const mask=Object.keys(fields).map(k=>'updateMask.fieldPaths='+encodeURIComponent(k)).join('&');
  return req('PATCH',HOST,BASE+'/'+col+'/'+encodeURIComponent(id)+'?'+mask,{fields});}
async function lookupEmail(e){return (JSON.parse((await req('POST',IT,'/v1/projects/'+PROJECT+'/accounts:lookup',{email:[e]})).body).users||[])[0];}
async function lookupUid(u){return (JSON.parse((await req('POST',IT,'/v1/projects/'+PROJECT+'/accounts:lookup',{localId:[u]})).body).users||[])[0];}

const DJ_UID='AiJp5yzTnRZZIZKZEepNUKn8NuI2';
const TMM_UID='ZrG4N8SETmS7NMEg0src1NYjBw23';
const KASS_UID='xrH21J5GFbW8PluCZ2ny5nIuf602';

(async()=>{
  const L=console.log;
  L('\n  BATCH ONBOARD 2   project '+PROJECT+'   mode '+(APPLY?'APPLY':'DRY RUN')+'\n');

  /* ── [DJ] phone access ─────────────────────────────────────────────────── */
  L('  [DJ] add phone +254799948498 for login + contact');
  if(APPLY){
    const r=await req('POST',IT,'/v1/projects/'+PROJECT+'/accounts:update',{localId:DJ_UID,phoneNumber:'+254799948498'});
    L('      auth phone set: HTTP '+r.status+(r.status>=400?('  '+r.body.slice(0,140)):''));
    await patch('providers',DJ_UID,{phone:S('0799948498'),phoneNumber:S('+254799948498'),updatedAt:T(NOW)});
    // A password-reset link is the email fallback the owner can use instead of phone.
    const link=await req('POST',IT,'/v1/accounts:sendOobCode?key='+API_KEY,{requestType:'PASSWORD_RESET',email:'djbvmbxno@gmail.com'},true);
    L('      password-reset email trigger: HTTP '+link.status+(link.status<400?' (sent to djbvmbxno@gmail.com)':''));
  } else L('      would set Auth phoneNumber + provider contact + trigger reset email');

  /* ── [FAHIM] new mechanic ──────────────────────────────────────────────── */
  L('\n  [FAHIM] Automate Fahim — mechanics registry');
  const FEMAIL='fahimmarisa@gmail.com', FNAME='Automate Fahim', FSLUG='automate-fahim', FPHONE='+254713735027';
  let fUid=null; const fEx=await lookupEmail(FEMAIL); if(fEx){fUid=fEx.localId;L('      account exists uid='+fUid);}
  if(APPLY){
    if(!fUid){
      const pw=crypto.randomBytes(18).toString('base64')+'Aa1!';
      const up=await req('POST',IT,'/v1/accounts:signUp?key='+API_KEY,{email:FEMAIL,password:pw,returnSecureToken:true},true);
      if(up.status>=400){L('      ** create FAILED '+up.status+' '+up.body.slice(0,140)+' **');}
      else{fUid=JSON.parse(up.body).localId;
        await req('POST',IT,'/v1/projects/'+PROJECT+'/accounts:update',{localId:fUid,displayName:FNAME,phoneNumber:FPHONE});
        L('      created Auth uid='+fUid+' (+phone, random pw — owner resets)');}
    } else {
      await req('POST',IT,'/v1/projects/'+PROJECT+'/accounts:update',{localId:fUid,phoneNumber:FPHONE}).catch(()=>{});
    }
    if(fUid){
      await patch('mechanics',FSLUG,{
        id:S(FSLUG),slug:S(FSLUG),name:S(FNAME),ownerUid:S(fUid),ownerName:S(FNAME),
        category:S('mechanics'),type:S('Auto Electrician & Diagnostics'),spec:S('Auto electrician · Diagnostics'),
        services:A(['Auto electrical repairs','Diagnostics','Wiring','Battery','Alternator']),
        phone:S(FPHONE),email:S(FEMAIL),location:S(''),area:S(''),emoji:S('🔧'),
        status:S('active'),verified:B(false),featured:B(false),
        rating:I(0),jobs:I(0),years:I(0),
        searchable:B(true),searchIndexed:B(true),
        searchableTerms:A(terms([FNAME,'Automate Fahim','mechanic','auto electrician','fundi','garage','diagnostics','Fahim'])),
        verificationStatus:S('pending'),
        createdAt:T(NOW),updatedAt:T(NOW),
        onboardedBy:S('scripts/onboard-batch2.js'),
      });
      await patch('users',fUid,{name:S(FNAME),displayName:S(FNAME),email:S(FEMAIL),category:S('mechanics'),
        mechanicId:S(FSLUG),merchantSlug:S(FSLUG),accountStatus:S('active'),searchIndexed:B(true),
        createdAt:T(NOW),updatedAt:T(NOW)});
      L('      wrote mechanics/'+FSLUG+' + users link');
    }
  } else L('      would '+(fUid?'reuse':'CREATE')+' account, write mechanics/'+FSLUG+' (createdAt set → shows on car-hub)');

  /* ── [TMM] real law firm ───────────────────────────────────────────────── */
  L('\n  [TMM] T.M.M & Partners Advocates — legalProviders + lawyers (real firm, NO fabricated LSK)');
  if(APPLY){
    await patch('legalProviders',TMM_UID,{
      providerId:S(TMM_UID),uid:S(TMM_UID),
      name:S('T.M.M & Partners Advocates'),firmName:S('T.M.M & Partners Advocates'),
      specializations:A(['other']),           /* honest default; firm can refine */
      licenseNumber:S(''),                     /* NEVER fabricated — firm supplies real LSK */
      bio:S(''),location:S('Nairobi'),county:S('Nairobi'),country:S('Kenya'),
      phone:S(''),email:S('info@tmmadvocates.ke'),
      consultationFee:{doubleValue:0},currency:S('KES'),
      languages:A(['English','Swahili']),isOnline:B(true),yearsOfExperience:I(0),
      status:S('active'),               /* admin-directed activation so it shows on legal-hub */
      verified:B(false),                /* not verified until LSK is on file */
      rating:{doubleValue:0},ratingCount:I(0),totalConsultations:I(0),
      profilePending:A(['licenseNumber','specializations','bio','phone','address','consultationFee']),
      onboardedBy:S('scripts/onboard-batch2.js'),
      createdAt:T(NOW),updatedAt:T(NOW),
    });
    await patch('lawyers',TMM_UID,{
      id:S(TMM_UID),uid:S(TMM_UID),sellerUid:S(TMM_UID),
      name:S('T.M.M & Partners Advocates'),firm:S('T.M.M & Partners Advocates'),
      specialty:S('Legal Services'),practice:S('General Practice'),
      category:S('legal'),location:S('Nairobi'),city:S('Nairobi'),
      status:S('active'),verified:B(false),
      searchable:B(true),searchIndexed:B(true),
      searchableTerms:A(terms(['T.M.M & Partners Advocates','TMM','advocates','lawyer','law firm','legal','wakili','attorney'])),
      email:S('info@tmmadvocates.ke'),
      createdAt:T(NOW),updatedAt:T(NOW),onboardedBy:S('scripts/onboard-batch2.js'),
    });
    await patch('users',TMM_UID,{accountStatus:S('active'),searchIndexed:B(true),hasLegalProfile:B(true),updatedAt:T(NOW)});
    L('      wrote legalProviders/'+TMM_UID.slice(0,10)+'… (status=active) + lawyers/… + users link');
    L('      NOTE: licenseNumber left blank — firm must supply real LSK number.');
  } else L('      would write legalProviders (active) + lawyers, LSK blank (not fabricated)');

  /* ── [KASS] make searchable ────────────────────────────────────────────── */
  L('\n  [KASS] KASS VAPES — sellers registry');
  const kUser=await lookupUid(KASS_UID);
  const kPhone=(kUser&&kUser.phoneNumber)||'+254705726803';
  if(APPLY){
    await patch('sellers',KASS_UID,{
      uid:S(KASS_UID),name:S('KASS VAPES'),shopName:S('KASS VAPES'),storeName:S('KASS VAPES'),businessName:S('KASS VAPES'),
      category:S('vape'),categoryLabel:S('Vape & Accessories'),sellerType:S('vape'),accountType:S('seller'),
      status:S('active'),isVisible:B(true),searchable:B(true),searchIndexed:B(true),
      searchableTerms:A(terms(['KASS VAPES','kass','vape','vapes','e-cigarette','vaping','pods','accessories'])),
      nameLower:S('kass vapes'),
      verified:B(false),featured:B(false),shopPublished:B(false),
      rating:I(0),reviewCount:I(0),productCount:I(0),
      phone:S(kPhone),phoneNumber:S(kPhone),
      onboardingPending:A(['logo','address','description','products','prices']),
      createdAt:T(NOW),updatedAt:T(NOW),onboardedBy:S('scripts/onboard-batch2.js'),
    });
    await patch('users',KASS_UID,{hasSellerProfile:B(true),searchIndexed:B(true),category:S('vape'),updatedAt:T(NOW)});
    L('      wrote sellers/'+KASS_UID.slice(0,10)+'… + users link  phone='+kPhone);
  } else L('      would write sellers/'+KASS_UID.slice(0,10)+'… searchable (phone '+kPhone+')');

  if(!APPLY){ L('\n  DRY RUN — nothing written. Re-run with --apply.\n'); return; }

  /* ── verify ────────────────────────────────────────────────────────────── */
  L('\n  VERIFY:');
  const dj=await lookupUid(DJ_UID); L('    DJ phone: '+((dj&&dj.phoneNumber)||'(none)'));
  for(const [col,id,name] of [['mechanics',FSLUG,'Fahim'],['legalProviders',TMM_UID,'TMM legal'],['lawyers',TMM_UID,'TMM search'],['sellers',KASS_UID,'Kass']]){
    const r=await req('GET',HOST,BASE+'/'+col+'/'+encodeURIComponent(id));
    const f=r.status<400?JSON.parse(r.body).fields:{};
    L('    '+name+' → '+col+': '+(r.status<400?('status='+plain(f.status)+' searchable='+(plain(f.searchable)??'-')):('HTTP '+r.status)));
  }
  L('');
})().catch(e=>{console.error('\n  failed: '+e.message+'\n');process.exit(1);});
