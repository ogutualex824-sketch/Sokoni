#!/usr/bin/env node
/* test-adminos-route-parse.js — AdminOS deep-link parser (sokoni-aos.js _parseRoute), EXECUTED.
 * The function is extracted from the real file and run against a fake document whose nav and
 * tab buttons are listed explicitly.
 *   R1 single-word section resolves      R2 hyphenated section resolves (payout-approvals)
 *   R3 hyphenated tab resolves           R4 unknown section → null (falls back to dashboard)
 *   R5 injection-shaped ids refused before any selector (quotes, brackets, spaces, double hyphen,
 *      leading/trailing hyphen)          N1 negative control: the old [a-z]+ pattern refuses R2
 */
'use strict';
const fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
const ck = (l, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const src = fs.readFileSync(path.join(__dirname, '..', 'sokoni-aos.js'), 'utf8');
const a = src.indexOf('function _parseRoute(hash) {');
if (a < 0) { console.log('FAIL  _parseRoute not found'); process.exit(1); }
let i = src.indexOf('{', a), d = 0;
for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) break; } }
const fnSrc = src.slice(a, i + 1);

function make(fnText, navSections, tabs) {
  const seen = [];
  const document = { querySelector(sel) {
    seen.push(sel);
    let m = /^#aosNav \.nav-item\[data-section="([^"]*)"\]:not\(\[data-tab\]\)$/.exec(sel);
    if (m) return navSections.includes(m[1]) ? {} : null;
    m = /^#panel-([^ ]+) \.tab-bar \.tab-btn\[data-tab="([^"]*)"\]$/.exec(sel);
    if (m) return (tabs[m[1]] || []).includes(m[2]) ? {} : null;
    throw new Error('unexpected selector ' + sel);
  } };
  const parse = new Function('document', fnText + '\nreturn _parseRoute;')(document);
  return { parse, seen };
}
const nav = ['dashboard', 'failures', 'payout-approvals', 'marketplace'];
const tabs = { marketplace: ['products', 'orders'], 'payout-approvals': ['pending-review'] };
{
  const { parse, seen } = make(fnSrc, nav, tabs);
  ck('R1 #failures resolves', JSON.stringify(parse('#failures')) === JSON.stringify({ section: 'failures', tab: null }), parse('#failures'));
  ck('R2 #payout-approvals resolves (hyphenated section)', JSON.stringify(parse('#payout-approvals')) === JSON.stringify({ section: 'payout-approvals', tab: null }), parse('#payout-approvals'));
  ck('R3 hyphenated tab resolves', JSON.stringify(parse('#payout-approvals/pending-review')) === JSON.stringify({ section: 'payout-approvals', tab: 'pending-review' }), parse('#payout-approvals/pending-review'));
  ck('R4 unknown section → null', parse('#nope') === null && parse('#marketplace/bogus').tab === null, [parse('#nope'), parse('#marketplace/bogus')]);
  const before = seen.length;
  const bad = ['#a"]', '#a b', '#a--b', '#-a', '#a-', '#a[x]', '#a/b"', "#a'b", '#A1'];
  ck('R5 injection-shaped ids refused BEFORE any selector is built', bad.every((h) => parse(h) === null) && seen.length === before, { calls: seen.length - before });
}
{
  const old = fnSrc.replace(/\/\^\(\[a-z\]\+\(\?:-\[a-z\]\+\)\*\)\(\?:\\\/\(\[a-z\]\+\(\?:-\[a-z\]\+\)\*\)\)\?\$\//, '/^([a-z]+)(?:\\/([a-z]+))?$/');
  const { parse } = make(old, nav, tabs);
  ck('N1 negative control: the old [a-z]+ pattern refuses #payout-approvals', old !== fnSrc && parse('#payout-approvals') === null, { changed: old !== fnSrc });
}
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
