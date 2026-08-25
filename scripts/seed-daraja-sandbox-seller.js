#!/usr/bin/env node
/**
 * scripts/seed-daraja-sandbox-seller.js
 *
 * Seeds ONE shopSettings document so a single Daraja SANDBOX end-to-end STK test
 * can run: SOKONI -> sendTestSTKPush -> pending posPayments -> Daraja sandbox ->
 * darajaSTKCallback -> posPayments completed -> verifyPaymentStatus.
 *
 * WHY THIS IS NEEDED
 * darajaSTKPush / sendTestSTKPush read per-seller Daraja credentials from
 * shopSettings/{sellerUid}. That collection was audited EMPTY on 2026-07-22 and
 * the client surfaces that used to populate it were deliberately retired
 * (payments.html), so there is no document to read and the call throws
 * "not-found: Daraja credentials not configured". That is missing data, not a
 * bug. This script supplies it — for the sandbox, for one seller, temporarily.
 *
 * WHAT IT DOES NOT DO
 *   - It does not change payment routing. Collection stays DIRECT_TO_SELLER.
 *   - It does not touch production credentials, the real Bravilex Till, or any
 *     other seller.
 *   - It writes no secret to this repository, to a seed file, or to stdout.
 *
 * SECRETS
 * The three Daraja sandbox credentials are read from the environment at run time
 * and are never printed, never defaulted, never persisted outside Firestore.
 * The script refuses to run if any is unset. Dry-run output is redacted.
 *
 * CREDENTIALS FOR FIRESTORE ITSELF
 * Firestore REST with a gcloud CLI access token, matching the established
 * pattern in scripts/seed-health-provider.js (the Admin SDK's ADC is unusable on
 * this machine). Additive: it creates or merges exactly one document, never
 * deletes.
 *
 *   # dry run — prints the document with all three credentials redacted
 *   DARAJA_SANDBOX_CONSUMER_KEY=... \
 *   DARAJA_SANDBOX_CONSUMER_SECRET=... \
 *   DARAJA_SANDBOX_PASSKEY=... \
 *   SANDBOX_SELLER_UID=<uid> \
 *   node scripts/seed-daraja-sandbox-seller.js
 *
 *   # write it
 *   ... same env ... node scripts/seed-daraja-sandbox-seller.js --apply
 *
 *   # remove it again when the sandbox run concludes (REQUIRED)
 *   SANDBOX_SELLER_UID=<uid> node scripts/seed-daraja-sandbox-seller.js --revoke --apply
 *
 * TEARDOWN IS PART OF THE PROCEDURE, NOT AN AFTERTHOUGHT. When the test is done:
 *   1. run --revoke --apply here, and
 *   2. clear DARAJA_SANDBOX_SELLER_UIDS in functions/.env and redeploy.
 * Either one alone closes the lane; do both.
 */
'use strict';

const https = require('https');
const { execSync } = require('child_process');

const APPLY   = process.argv.includes('--apply');
const REVOKE  = process.argv.includes('--revoke');
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
const HOST    = 'firestore.googleapis.com';
const BASE    = `/v1/projects/${PROJECT}/databases/(default)/documents`;

/* ── Non-secret sandbox constants ─────────────────────────────────────────
   174379 is Safaricom's shared sandbox Paybill, published in the Daraja docs.
   It is NOT a credential, and it is NOT the real Bravilex Till — using the live
   Till here would point sandbox traffic at a production destination. */
const SANDBOX_SHORTCODE = '174379';
const SANDBOX_ENV       = 'sandbox';           // explicit: the code default is "production"
const SANDBOX_TX_TYPE   = 'CustomerPayBillOnline';  // 174379 is a Paybill, not a Till
const SANDBOX_ACCT_REF  = 'SOKONI-SBX';        // <= 12 chars, per the .slice(0,12) at the call site
const SANDBOX_BIZ_NAME  = 'SOKONI Sandbox Test';

const UID = (process.env.SANDBOX_SELLER_UID || '').trim();

const die = (msg) => { console.error('  ERROR  ' + msg); process.exit(1); };

if (!UID) die('SANDBOX_SELLER_UID is not set.');
if (!/^[A-Za-z0-9_-]{6,128}$/.test(UID)) die('SANDBOX_SELLER_UID is not a plausible Firebase UID.');

/* ── Access token ─────────────────────────────────────────────────────────── */
function accessToken() {
  if (process.env.GCLOUD_ACCESS_TOKEN) return process.env.GCLOUD_ACCESS_TOKEN.trim();
  try {
    return execSync('gcloud auth print-access-token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    die('could not obtain a gcloud access token. Run `gcloud auth login`, or set GCLOUD_ACCESS_TOKEN.');
  }
}

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      host: HOST, path, method,
      headers: Object.assign(
        { Authorization: 'Bearer ' + token },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}
      ),
    }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ── Redaction. Nothing derived from a secret reaches stdout — not the value,
      not a prefix, not a length (a length narrows a brute force). ─────────── */
const REDACTED = '<redacted>';

async function main() {
  const token = accessToken();

  if (REVOKE) {
    console.log(`\nDaraja sandbox seller — REVOKE  (project ${PROJECT}, uid ${UID})\n`);
    if (!APPLY) {
      console.log('  DRY RUN  would DELETE shopSettings/' + UID);
      console.log('           re-run with --apply to delete it.\n');
      return;
    }
    const r = await request('DELETE', `${BASE}/shopSettings/${UID}`, null, token);
    if (r.status >= 200 && r.status < 300) {
      console.log('  DELETED  shopSettings/' + UID);
      console.log('  NEXT     clear DARAJA_SANDBOX_SELLER_UIDS in functions/.env and redeploy.\n');
    } else {
      die(`delete failed (HTTP ${r.status}). ${r.body.slice(0, 200)}`);
    }
    return;
  }

  /* Secrets — required, never printed. */
  const consumerKey    = (process.env.DARAJA_SANDBOX_CONSUMER_KEY || '').trim();
  const consumerSecret = (process.env.DARAJA_SANDBOX_CONSUMER_SECRET || '').trim();
  const passKey        = (process.env.DARAJA_SANDBOX_PASSKEY || '').trim();

  const missing = [
    !consumerKey    && 'DARAJA_SANDBOX_CONSUMER_KEY',
    !consumerSecret && 'DARAJA_SANDBOX_CONSUMER_SECRET',
    !passKey        && 'DARAJA_SANDBOX_PASSKEY',
  ].filter(Boolean);
  if (missing.length) die('missing required environment variables: ' + missing.join(', '));

  /* The seller must already exist. Minting an account to make a test pass would
     be fabricating the subject of the test.
     A dry run still renders the preview and merely warns, so the document can be
     reviewed before an account is nominated; --apply is where it is fatal. */
  const userSnap = await request('GET', `${BASE}/users/${UID}`, null, token);
  let userMissing = false;
  if (userSnap.status === 404) {
    if (APPLY) die(`users/${UID} does not exist. Pass the UID of a real, existing account — this script will not create one.`);
    userMissing = true;
  } else if (userSnap.status !== 200) {
    die(`could not verify users/${UID} (HTTP ${userSnap.status}).`);
  }

  /* Firestore REST typed-value document.
     `phone` and `ownerPhone` are DELIBERATELY ABSENT: sendTestSTKPush refuses any
     number that does not match a stored seller phone, so leaving both unset is
     what lets Daraja's sandbox test MSISDN through. Do not add them. */
  const fields = {
    darajaShortCode:       { stringValue: SANDBOX_SHORTCODE },
    darajaEnv:             { stringValue: SANDBOX_ENV },
    darajaTransactionType: { stringValue: SANDBOX_TX_TYPE },
    darajaAccountRef:      { stringValue: SANDBOX_ACCT_REF },
    businessName:          { stringValue: SANDBOX_BIZ_NAME },
    darajaConsumerKey:     { stringValue: consumerKey },
    darajaConsumerSecret:  { stringValue: consumerSecret },
    darajaPassKey:         { stringValue: passKey },
    /* Marker so this row is findable and removable by query, and so nothing
       downstream can mistake it for a configured production merchant. */
    sandboxSeed:           { booleanValue: true },
    updatedAt:             { timestampValue: new Date().toISOString() },
  };

  const preview = Object.assign({}, fields, {
    darajaConsumerKey:    { stringValue: REDACTED },
    darajaConsumerSecret: { stringValue: REDACTED },
    darajaPassKey:        { stringValue: REDACTED },
  });

  console.log(`\nDaraja sandbox seller — SEED  (project ${PROJECT}, uid ${UID})\n`);
  console.log('  document  shopSettings/' + UID);
  console.log(JSON.stringify(preview, null, 2).split('\n').map((l) => '  ' + l).join('\n'));
  console.log('\n  note      phone / ownerPhone intentionally absent (sendTestSTKPush phone guard)');
  console.log('  note      collection route unchanged: DIRECT_TO_SELLER');

  if (!APPLY) {
    if (userMissing) console.log('  WARN      users/' + UID + ' does not exist — --apply would refuse.');
    console.log('\n  DRY RUN   nothing written. Re-run with --apply.\n');
    return;
  }

  /* PATCH with an explicit updateMask == merge: it touches only these fields and
     leaves anything else on the document alone. */
  const mask = Object.keys(fields).map((f) => `updateMask.fieldPaths=${f}`).join('&');
  const r = await request('PATCH', `${BASE}/shopSettings/${UID}?${mask}`, { fields }, token);

  if (r.status >= 200 && r.status < 300) {
    console.log('\n  WROTE     shopSettings/' + UID);
    console.log('  NEXT      set DARAJA_SANDBOX_SELLER_UIDS=' + UID + ' in functions/.env, then deploy functions.');
    console.log('  TEARDOWN  --revoke --apply, and clear that variable, once the test concludes.\n');
  } else {
    /* Never echo the response body verbatim on a write failure: the request that
       produced it carried the credentials. */
    die(`write failed (HTTP ${r.status}).`);
  }
}

main().catch((e) => die(e && e.message ? e.message : String(e)));
