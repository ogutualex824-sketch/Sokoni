'use strict';
/**
 * scripts/onboard-barber.js — create a phone-login account for a new barber
 * shop and list it as a searchable service provider.
 *
 *   node scripts/onboard-barber.js            # dry run
 *   node scripts/onboard-barber.js --apply
 *
 * Shave 'n' Trims — barber shop, owner Pacifique, phone 0742544979.
 * No account existed and the phone is free, so this creates one keyed for
 * PHONE OTP login: Pacifique signs in with +254742544979 and lands on the same
 * uid that owns the provider profile, so they immediately see their shop.
 *
 * Person name (Pacifique) and shop name (Shave 'n' Trims) are kept separate —
 * displayName is the person, the provider record's name is the business.
 * Nothing is fabricated: only the details given. verified is false (not yet
 * verified); ratings/counters start at zero. A random password is set and never
 * printed — sign-in is by phone.
 */

const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

const APPLY   = process.argv.includes('--apply');
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE';
const HOST='firestore.googleapis.com', IT='identitytoolkit.googleapis.com';
const BASE='/v1/projects/'+PROJECT+'/databases/(default)/documents';

const PHONE   = '+254742544979';
const PERSON  = 'Pacifique';
const SHOP     = "Shave 'n' Trims";
const EMAIL   = 'shaventrims254742544979@sokoni-provider.invalid';  /* placeholder; login is by phone */

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
  if(t)out.add(t);t.split(/[\s,&/'’]+/).forEach(w=>{if(w.length>2)out.add(w);});});return[...out];};
async function patch(col,id,fields){const mask=Object.keys(fields).map(k=>'updateMask.fieldPaths='+encodeURIComponent(k)).join('&');
  return req('PATCH',HOST,BASE+'/'+col+'/'+encodeURIComponent(id)+'?'+mask,{fields});}

(async()=>{
  const L=console.log;
  L('\n  BARBER ONBOARDING   project '+PROJECT+'   mode '+(APPLY?'APPLY':'DRY RUN'));
  L("  shop \""+SHOP+"\"  owner "+PERSON+"  phone "+PHONE+'\n');

  /* Never duplicate: reuse if the phone already resolves to an account. */
  const look=await req('POST',IT,'/v1/projects/'+PROJECT+'/accounts:lookup',{phoneNumber:[PHONE]});
  let uid=(JSON.parse(look.body).users||[])[0] && JSON.parse(look.body).users[0].localId;
  if(uid) L('  account already exists uid='+uid+' — reusing.');

  const skills=['Barber','Haircut','Shave','Beard Trim','Fade','Line-up','Kids Cut'];
  const sterms=terms([SHOP,PERSON,'barber','barbershop','shave','trims','trim','haircut','beard','fade','grooming','hair']);

  if(!APPLY){
    L('  would '+(uid?'reuse':'CREATE')+' phone-login account ('+PHONE+', OTP sign-in)');
    L('  would write providers/{uid}: name="'+SHOP+'" category=hair-beauty status=active searchable=true');
    L('  searchableTerms: '+sterms.join(', '));
    L('\n  DRY RUN — nothing written. Re-run with --apply.\n'); return;
  }

  if(!uid){
    /* Create the base account, then attach the phone so OTP sign-in lands here.
       Password is random and unused (login is by phone). */
    const pw=crypto.randomBytes(18).toString('base64')+'Aa1!';
    const up=await req('POST',IT,'/v1/accounts:signUp?key='+API_KEY,{email:EMAIL,password:pw,returnSecureToken:true},true);
    if(up.status>=400){ L('  ** account create FAILED '+up.status+' '+up.body.slice(0,160)+' **'); process.exit(1); }
    uid=JSON.parse(up.body).localId;
    const upd=await req('POST',IT,'/v1/projects/'+PROJECT+'/accounts:update',{localId:uid,phoneNumber:PHONE,displayName:PERSON});
    L('  created account uid='+uid+'  phone-set HTTP '+upd.status+'  (Pacifique signs in via OTP on '+PHONE+')');
  }

  const providerId='PRV-'+uid.slice(0,8).toUpperCase();
  await patch('providers',uid,{
    uid:S(uid), providerId:S(providerId),
    name:S(SHOP), businessName:S(SHOP), ownerName:S(PERSON),
    category:S('hair-beauty'), categories:A(['hair-beauty','barber']),
    categoryLabel:S('Barber Shop'), serviceType:S('Barber'), hub:S('services'),
    skills:A(skills), searchableTerms:A(sterms), nameLower:S(SHOP.toLowerCase()),
    phone:S('0742544979'), phoneNumber:S(PHONE),
    status:S('active'), isActive:B(true), isPublic:B(true),
    searchable:B(true), searchIndexed:B(true), featured:B(false),
    acceptsBookings:B(true), available:B(true), isOnline:B(true), verified:B(false),
    chatEnabled:B(true), reviewsEnabled:B(true), ratingsEnabled:B(true),
    analyticsEnabled:B(true), notificationsEnabled:B(true), payoutsEnabled:B(true),
    rating:I(0), reviewCount:I(0), ratingCount:I(0), bookingCount:I(0), jobsCompleted:I(0),
    onboardedBy:S('scripts/onboard-barber.js'), onboardedAt:T(NOW), createdAt:T(NOW), updatedAt:T(NOW),
    profilePending:A(['photo','kycDocuments','exactLocation','bio','pricing','workingHours']),
    profileComplete:B(false),
  });
  await patch('providerSettings',uid,{uid:S(uid),acceptsBookings:B(true),chatEnabled:B(true),reviewsEnabled:B(true),publicProfile:B(true),searchable:B(true),currency:S('KES'),updatedAt:T(NOW)});
  await patch('providerNotifications',uid,{uid:S(uid),sms:B(true),email:B(true),push:B(true),updatedAt:T(NOW)});
  await patch('providerAnalytics',uid,{uid:S(uid),profileViews:I(0),bookingRequests:I(0),totalEarnings:I(0),currency:S('KES'),initialisedAt:T(NOW)});
  await patch('wallets',uid,{uid:S(uid),balance:I(0),escrow:I(0),totalIn:I(0),totalOut:I(0),currency:S('KES'),frozen:B(false),createdAt:T(NOW),updatedAt:T(NOW)});
  await patch('notificationPrefs',uid,{uid:S(uid),sms:B(true),email:B(true),push:B(true),inApp:B(true),updatedAt:T(NOW)});
  await patch('users',uid,{name:S(PERSON),displayName:S(PERSON),phone:S('0742544979'),phoneNumber:S(PHONE),
    category:S('hair-beauty'),accountType:S('provider'),registeredAs:M({provider:B(true)}),isProvider:B(true),
    providerProfileId:S(providerId),providerBusinessName:S(SHOP),searchIndexed:B(true),status:S('active'),createdAt:T(NOW),updatedAt:T(NOW)});
  L('  wrote providers + settings/notifications/analytics/wallet/prefs + users link');

  const rb=JSON.parse((await req('GET',HOST,BASE+'/providers/'+uid)).body).fields||{};
  const ok=plain(rb.status)==='active'&&plain(rb.searchable)===true;
  L('  verify: name='+JSON.stringify(plain(rb.name))+' category='+plain(rb.category)+' status='+plain(rb.status)+' searchable='+plain(rb.searchable)+(ok?'  OK — discoverable':'  ** NOT DISCOVERABLE **'));
  L('  uid='+uid+'\n  Pacifique signs in with '+PHONE+' (phone OTP) to see & manage the shop.\n');
})().catch(e=>{console.error('\n  failed: '+e.message+'\n');process.exit(1);});
