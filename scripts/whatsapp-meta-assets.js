#!/usr/bin/env node
/* ============================================================================
   scripts/whatsapp-meta-assets.js
   ============================================================================
   Read-only discovery of the Meta assets the WhatsApp rail needs:

       Business Portfolio  ->  WhatsApp Business Account  ->  phone number id

   and the permissions the supplied token actually carries.

   IT READS NOTHING AND CHANGES NOTHING AT META. Every call is a GET. It cannot
   subscribe an app, register a number, or send a message — those are separate
   acts that belong to separate, authorised slices.

   THE TOKEN NEVER APPEARS ANYWHERE
   ---------------------------------
   It is read from the environment, never from an argument and never from a
   file. An argument lands in shell history and in the process list where any
   other user on the machine can read it; a file gets committed. Nothing here
   prints it, logs it, writes it or puts it in an error message — the only thing
   ever shown is its length and a three-character prefix, which is enough to
   confirm you exported the one you meant and not enough to use.

   It also writes NOTHING to disk. There is no report file, because a report
   file containing asset ids is one `git add .` away from being committed.

   WHY THIS RUNS BEFORE ANY SECRET IS CREATED
   -------------------------------------------
   Provisioning `WHATSAPP_APP_SECRET` before knowing which Meta app owns the
   WABA would bind a credential to a guess. The app that owns the WABA is the
   app whose secret signs the webhook, so the asset tree has to be observed
   first.

   Usage:   $env:META_ACCESS_TOKEN = '...'   (PowerShell, then run in the SAME shell)
            node scripts/whatsapp-meta-assets.js

   Use a SHORT-LIVED TEST token. Do not use a token that has been pasted into a
   chat, an issue, or anywhere else it could have been captured.
   ============================================================================ */
'use strict';

const https = require('https');

const TOKEN = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || '';
const VERSION = process.env.META_API_VERSION || 'v21.0';

if (!TOKEN) {
  /* Kept to two lines a person can actually retype. The earlier version offered
     a SecureString incantation that wrapped across four lines and was the first
     thing anyone would get wrong — advice too awkward to follow is not advice. */
  console.error('\n  META_ACCESS_TOKEN is not set in this shell.\n');
  console.error('  Run BOTH lines in the SAME window, from the repo folder:\n');
  console.error('    $env:META_ACCESS_TOKEN = Read-Host "token"');
  console.error('    node scripts/whatsapp-meta-assets.js\n');
  console.error('  Read-Host keeps the token OUT of your PowerShell history file;');
  console.error('  typing the value inline writes it to disk. A variable set in a');
  console.error('  different window does not reach this one.\n');
  process.exit(2);
}

/* Confirms which token was exported without disclosing it. */
console.log('\n  token: length=' + TOKEN.length + '  prefix=' + TOKEN.slice(0, 3) + '***  (never printed in full)');
console.log('  api:   ' + VERSION + '   ALL CALLS ARE GET — nothing is created, subscribed or sent\n');

function get (pathname) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'graph.facebook.com', path: '/' + VERSION + pathname, method: 'GET',
      /* The token goes in a HEADER, never the query string: URLs are logged by
         proxies and by Meta, and a token in a URL is a token in a log. */
      headers: { Authorization: 'Bearer ' + TOKEN },
      timeout: 20000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, json, raw: body.slice(0, 300) });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    /* The error message is OURS, not the exception's: a thrown request error can
       echo the request, and the request carries the token. */
    req.on('error', () => resolve({ status: 0, error: 'request failed' }));
    req.end();
  });
}

const line = (k, v) => console.log('  ' + String(k).padEnd(26) + (v === undefined ? '' : v));

(async function main () {
  /* ── 1 · WHO IS THIS TOKEN, AND WHAT MAY IT DO ─────────────────────────── */
  console.log('1 · TOKEN');
  const dbg = await get('/debug_token?input_token=' + encodeURIComponent(TOKEN));
  if (dbg.status !== 200 || !dbg.json || !dbg.json.data) {
    line('debug_token', 'UNREADABLE — status ' + dbg.status +
      ((dbg.json && dbg.json.error && dbg.json.error.message) ? ' · ' + dbg.json.error.message : ''));
    line('', 'a token cannot debug itself unless it has the right app context;');
    line('', 'this is informational, the calls below are what matter');
  } else {
    const d = dbg.json.data;
    line('type', d.type || '(unknown)');
    line('app id', d.app_id || '(none)');
    line('valid', String(d.is_valid));
    line('expires', d.expires_at ? new Date(d.expires_at * 1000).toISOString()
      : (d.data_access_expires_at ? 'data access ' + new Date(d.data_access_expires_at * 1000).toISOString() : 'never / unknown'));
    const scopes = d.scopes || [];
    line('scopes', scopes.join(', ') || '(none reported)');
    ['whatsapp_business_management', 'whatsapp_business_messaging'].forEach((need) => {
      line('  needs ' + need, scopes.indexOf(need) > -1 ? 'PRESENT' : 'ABSENT');
    });
    if (d.type === 'USER') {
      line('', 'NOTE: a USER token is for testing only — it expires in ~24h.');
      line('', 'The integration needs a SYSTEM USER token.');
    }
  }

  /* ── 2 · BUSINESS PORTFOLIOS ───────────────────────────────────────────── */
  console.log('\n2 · BUSINESS PORTFOLIOS');
  const biz = await get('/me/businesses?fields=id,name&limit=25');
  if (biz.status !== 200 || !biz.json || !biz.json.data) {
    line('businesses', 'UNREADABLE — status ' + biz.status +
      ((biz.json && biz.json.error && biz.json.error.message) ? ' · ' + biz.json.error.message : ''));
    console.log('\n  Cannot continue without a portfolio. UNREADABLE is not the same as');
    console.log('  "you have none" — check the token scopes above.\n');
    process.exit(1);
  }
  const businesses = biz.json.data;
  if (!businesses.length) { line('businesses', 'NONE — this token sees no business portfolio'); }
  businesses.forEach((b) => line('  ' + b.id, b.name));

  /* ── 3 · WABAs AND PHONE NUMBERS ───────────────────────────────────────── */
  console.log('\n3 · WHATSAPP BUSINESS ACCOUNTS');
  let anyWaba = false;
  for (const b of businesses) {
    const wabas = await get('/' + b.id + '/owned_whatsapp_business_accounts?fields=id,name&limit=25');
    if (wabas.status !== 200 || !wabas.json || !wabas.json.data) {
      line('  ' + b.name, 'UNREADABLE — status ' + wabas.status);
      continue;
    }
    if (!wabas.json.data.length) { line('  ' + b.name, 'no WABA owned by this portfolio'); continue; }
    for (const w of wabas.json.data) {
      anyWaba = true;
      line('  WABA ' + w.id, w.name + '   (portfolio: ' + b.name + ')');
      const nums = await get('/' + w.id + '/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status&limit=25');
      if (nums.status !== 200 || !nums.json || !nums.json.data) {
        line('    phone numbers', 'UNREADABLE — status ' + nums.status);
        continue;
      }
      if (!nums.json.data.length) { line('    phone numbers', 'NONE registered on this WABA'); continue; }
      nums.json.data.forEach((n) => {
        line('    phone-number-id', n.id);
        line('      number', n.display_phone_number + '  ' + (n.verified_name || ''));
        line('      verification', n.code_verification_status || '(unknown)');
        line('      quality', n.quality_rating || '(none yet)');
      });
    }
  }

  /* ── WHAT THIS DOES AND DOES NOT ESTABLISH ─────────────────────────────── */
  console.log('\n  ' + '-'.repeat(64));
  if (!anyWaba) {
    console.log('  NO WABA FOUND. Either none exists yet, or this token cannot see it.');
    console.log('  Those are different facts and this cannot tell them apart — check the');
    console.log('  scopes above before concluding a WABA must be created.');
  } else {
    console.log('  Assets observed. The APP ID above is the app whose secret signs the');
    console.log('  webhook — that is what decides whether WHATSAPP_APP_SECRET is a new');
    console.log('  secret or the existing FACEBOOK_APP_SECRET.');
  }
  console.log('\n  NOT DONE: nothing was subscribed, registered or sent. No secret was');
  console.log('  created, no function exported, no deployment. The handshake remains');
  console.log('  the first real proof and has not happened.\n');
})();
