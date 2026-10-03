#!/usr/bin/env node
'use strict';
/* ============================================================================
   Banking Hub — no fake wallet (owner P0 2026-10-03, brief A)
     A1  sokoni-banking-pro.js (the localStorage "wallet") is DELETED and no page loads it
     A2  the Banking Hub keeps NO balance in localStorage / sessionStorage and never increments or
         decrements money in the browser
     A3  balances come only from the authoritative surfaces (wallet.html / financial-os.html links);
         the hub renders no balance figure of its own
     A4  service-worker.js lists it only in PRECACHE_STATIC, which the worker never reads (install unaffected)
   node scripts/test-banking-no-fake-wallet.js
   ============================================================================ */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ck = (id, l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + id + ' ' + l); } else { fail++; console.log('  FAIL  ' + id + ' ' + l + (d !== undefined ? '  -> ' + String(d).slice(0, 200) : '')); } };
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const htmlFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
const loaders = htmlFiles.filter((f) => /<script[^>]+sokoni-banking-pro\.js/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
ck('A1', 'sokoni-banking-pro.js deleted and loaded by no page', !fs.existsSync(path.join(ROOT, 'sokoni-banking-pro.js')) && loaders.length === 0, loaders.join(','));
const hub = strip(fs.readFileSync(path.join(ROOT, 'banking-hub.js'), 'utf8'));
const page = strip(fs.readFileSync(path.join(ROOT, 'banking.html'), 'utf8'));
ck('A2', 'banking-hub.js / banking.html keep no money in browser storage', !/(localStorage|sessionStorage)\.(setItem|getItem)\([^)]*(bal|wallet|amount|txn|transaction|bnpl|invoice)/i.test(hub + page));
ck('A2b', 'no browser increment/decrement of a balance', !/\b(balance|walletBalance)\s*(\+|-)=/.test(hub + page) && !/quickDeposit|Quick Demo Deposit/.test(hub + page));
ck('A3', 'wallet / history link to the authoritative pages; the hub renders no balance of its own',
  /href="wallet\.html"/.test(page) && /href="financial-os\.html"/.test(page) && !/id="(bkp-)?(wallet-)?balance"/i.test(page));
const sw = fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8');
const swLine = sw.split('\n').findIndex((l) => l.includes('sokoni-banking-pro'));
const declared = sw.slice(0, sw.split('\n').slice(0, swLine).join('\n').length).lastIndexOf('const PRECACHE_STATIC = [');
ck('A4', 'service worker: only in PRECACHE_STATIC (declared, never read) — install not affected; worker not edited',
  swLine === -1 || (declared > -1 && /PRECACHE_STATIC are declared and NEVER read/.test(sw)));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
