'use strict';
/**
 * Fire a live testEmailDelivery call using a service-account custom token.
 * Usage: node functions/scripts/test-email.js [to@email.com]
 */
const https  = require('https');
const admin  = require('firebase-admin');

const PROJECT  = 'sokoni-aeb26';
const WEB_KEY  = 'AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE'; // public web API key
const TEST_UID = 'uwpD5gx3pvPusUz3FNohykg6vch2';
const TO       = process.argv[2] || 'ogutualex824@gmail.com';

admin.initializeApp({ projectId: PROJECT });

function post(hostname, path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end',  () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  /* 1. Create custom token */
  const customToken = await admin.auth().createCustomToken(TEST_UID, { admin: true });
  console.log('Custom token created.');

  /* 2. Exchange for ID token via Firebase Auth REST */
  const authRes = await post(
    'identitytoolkit.googleapis.com',
    `/v1/accounts:signInWithCustomToken?key=${WEB_KEY}`,
    { token: customToken, returnSecureToken: true }
  );
  if (!authRes.idToken) { console.error('Auth failed:', authRes); process.exit(1); }
  const idToken = authRes.idToken;
  console.log('ID token obtained.');

  /* 3. Call testEmailDelivery */
  const fnUrl  = `testemaildelivery`;
  const result = await post(
    `us-central1-${PROJECT}.cloudfunctions.net`,
    `/testEmailDelivery`,
    { data: { to: TO } }
  );

  // callable functions need Authorization header — redo with auth
  const body2 = JSON.stringify({ data: { to: TO } });
  const callResult = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: `us-central1-${PROJECT}.cloudfunctions.net`,
      path: `/testEmailDelivery`,
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${idToken}`,
        'Content-Length': Buffer.byteLength(body2),
      },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end',  () => {
        console.log(`HTTP ${res.statusCode}`);
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.write(body2);
    req.end();
  });

  console.log('\nResult:', JSON.stringify(callResult, null, 2));
  if (callResult?.result?.success) {
    console.log(`\n✓ Email sent via ${callResult.result.provider} to ${TO}`);
  } else {
    console.log('\n✗ Something went wrong — see result above');
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
