'use strict';
/* Boost pre-payment guard: subscriptions.html buyBoost must require a target
   listingId and fail BEFORE any payment, and thread listingId to the server. */
const fs=require('fs'),path=require('path');
const s=fs.readFileSync(path.join(__dirname,'..','subscriptions.html'),'utf8');
const fn=(s.match(/async function buyBoost\([\s\S]*?\n\}/)||[''])[0];
let p=0,f=0;const ok=n=>{p++;console.log('  [PASS] '+n)};const no=n=>{f++;console.log('  [FAIL] '+n)};
(/async function buyBoost\(key, name, listingId\)/.test(s))?ok('buyBoost takes a listingId param'):no('no listingId param');
(/const _listingId = String\(listingId \|\| ''\)\.trim\(\)/.test(fn) && /if\(!_listingId\)\{[\s\S]{0,220}return;/.test(fn))?ok('fails BEFORE payment when no listingId (explicit, no charge)'):no('no pre-payment guard');
(/createPaymentIntent'\)[\s\S]{0,120}listingId:\s*_listingId/.test(fn))?ok('threads listingId to createPaymentIntent'):no('listingId not sent to server');
/* guard must sit BEFORE the createPaymentIntent call (i.e. before any payment) */
(fn.indexOf('if(!_listingId)') < fn.indexOf('createPaymentIntent'))?ok('guard precedes the payment intent'):no('guard after payment');
console.log('\n'+(f===0?`boost-listing-guard: PASS ${p}/${p}`:`${f} FAIL`));process.exit(f?1:0);
