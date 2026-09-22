/* Producer/consumer contract shapes — derived from the PRODUCER, never hand-written.
 *
 *   node scripts/test-contract-shapes.js
 *
 * WHY THIS EXISTS — a real defect, found by someone else, in code that was 522/0 green
 * ------------------------------------------------------------------------------------
 * `sokoni-connect-client.js` rendered `p.state`. `connectGetSessionState` has always returned
 * `status`. So the session state on connect.html rendered as an em dash from the day it
 * shipped, and the C2 suite never saw it — because every assertion drove the renderer with
 * projections the suite constructed itself:
 *
 *     C.actionsFor({ state: 'ringing', offerable: [] })     // the suite's shape
 *
 * The fixture agreed with the renderer because the same author wrote both. That proves
 * internal consistency and nothing about the producer.
 *
 * THE PRINCIPLE, now permanent for SOKONI:
 *
 *     A contract test must consume production-shaped fixtures, or derive its fixtures from
 *     the production contract. A fixture invented by the test cannot establish that the
 *     implementation matches the producer.
 *
 * WHY THIS IS A SEPARATE FILE, not more assertions in the engine or Connect suites
 * -------------------------------------------------------------------------------
 * It is a different KIND of check — static analysis of what a callable RETURNS versus what a
 * client READS — and it spans modules that belong to different slices. It is also being added
 * while another agent is actively editing `test-connect-authority.js`; a separate file cannot
 * collide with their work.
 *
 * HOW THE FIXTURES ARE DERIVED
 * ----------------------------
 * The producer's `return { ... }` object literal is parsed out of its source and its top-level
 * keys become the contract. The consumer's `x.FIELD` reads are extracted the same way. Then:
 *
 *     every field the consumer reads MUST be one the producer emits
 *
 * The converse is deliberately NOT asserted: a producer may legitimately return more than any
 * one consumer uses.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 88) + ']' : ''));
  ok ? pass++ : fail++;
};

/** Strip comments, tracking strings so a `//` inside a URL is never read as a comment. */
function strip(src) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], nx = src[i + 1];
    if (c === '/' && nx === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
    if (c === '/' && nx === '/') { while (i < n && src[i] !== '\n') i++; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/**
 * returnedKeys(code, anchorRegex) -> string[]
 *
 * Finds the first `return {` after `anchorRegex` and returns its TOP-LEVEL keys. Depth is
 * tracked so a nested object's keys (`context: { anchorId }`) are not mistaken for contract
 * fields — those belong to a nested contract and are checked separately where it matters.
 */
function returnedKeys(code, anchorRegex) {
  const m = anchorRegex.exec(code);
  if (!m) return null;
  const from = code.indexOf('return {', m.index);
  if (from === -1) return null;

  let i = from + 'return '.length;
  let depth = 0;
  const keys = [];
  let buf = '';
  let inNested = 0;
  let sawColon = false;

  for (; i < code.length; i++) {
    const c = code[i];
    if (c === '{') { depth++; if (depth > 1) inNested++; buf = ''; continue; }
    if (c === '}') {
      if (depth > 1) inNested--;
      depth--;
      if (depth === 0) break;
      buf = '';
      continue;
    }
    if (c === '[') { inNested++; continue; }
    if (c === ']') { inNested--; continue; }
    if (c === '(') { inNested++; continue; }
    if (c === ')') { inNested--; continue; }
    if (inNested > 0) continue;

    if (c === ':') {
      const k = buf.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(k)) keys.push(k);
      /* Everything until the next comma is the VALUE. Without this the parser read
         `sent: false,` as declaring a key called `false`, which would have made the contract
         accept a consumer reading `.false` — a detector too permissive to catch anything. */
      sawColon = true;
      buf = '';
      continue;
    }
    if (c === ',') {
      const k = buf.trim();
      /* Shorthand `{ sessionId, status }` — a bare identifier with NO colon before it. */
      if (!sawColon && /^[A-Za-z_$][\w$]*$/.test(k) && !keys.includes(k)) keys.push(k);
      sawColon = false;
      buf = '';
      continue;
    }
    buf += c;
  }
  /* Trailing shorthand before the closing brace — again only when it is not a value. */
  const last = buf.trim();
  if (!sawColon && /^[A-Za-z_$][\w$]*$/.test(last) && !keys.includes(last)) keys.push(last);

  return [...new Set(keys)];
}

/** Every `alias.FIELD` read in a consumer, for a given variable name. */
function readsOf(code, alias) {
  const re = new RegExp('\\b' + alias + '\\.([A-Za-z_$][\\w$]*)', 'g');
  const out = [];
  let m;
  while ((m = re.exec(code))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

const read = (p) => strip(fs.readFileSync(path.join(ROOT, p), 'utf8'));

console.log('\nSOKONI — producer/consumer contract shapes\n');

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE EXTRACTOR NEEDS A CONTROL FIRST.
   A parser that returns nothing makes every consumer look compliant — the same failure class
   as the bug this suite exists for, one level up.
══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('── The extractor works ──');
{
  const sample = 'function f() { return { alpha: 1, beta, gamma: { nested: 2 }, delta: [x] }; }';
  const keys = returnedKeys(sample, /function f/);
  ck('it finds named keys', keys && keys.includes('alpha') && keys.includes('gamma'));
  ck('…and shorthand keys', keys && keys.includes('beta'));
  ck('…and does NOT report nested keys as top-level', keys && !keys.includes('nested'));
  ck('…nor array contents', keys && !keys.includes('x'));
  ck('…and returns null when there is no such producer',
    returnedKeys(sample, /function nosuchthing/) === null);
  const r = readsOf('a.one + b.two + a.three', 'a');
  ck('the reader finds field reads', r.join(',') === 'one,three');
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   C2 — connectGetSessionState -> sokoni-connect-client
   THE ONE THAT FAILED. `p.state` against a producer that emits `status`.
══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── Connect session projection ──');
{
  const producerCode = read('functions/connect-calls.js');
  /* The projection is built in `_project` and returned by the op; either is the contract. */
  let keys = returnedKeys(producerCode, /function _project\s*\(/);
  if (!keys) keys = returnedKeys(producerCode, /connectGetSessionState\s*=/);
  ck('the producer contract was derived from source', !!keys && keys.length > 4,
    keys ? keys.join(',') : 'NOT FOUND');

  if (keys) {
    ck('…it emits `status`, the document field', keys.includes('status'));
    ck('…and NOT `state` — the field the renderer used to read', !keys.includes('state'));

    const clientCode = read('sokoni-connect-client.js');
    /* `p` is the projection inside renderHtml and _consent. */
    const reads = readsOf(clientCode, 'p');
    const unknown = reads.filter((f) => !keys.includes(f));
    ck('every field the client reads is one the producer emits',
      unknown.length === 0, unknown.length ? 'UNKNOWN: ' + unknown.join(',') : reads.join(','));
    ck('…and the client does read `status`', reads.includes('status'));

    /* THE REGRESSION GUARD. Re-introducing `p.state` fails here even if a hand-written
       fixture in another suite would still pass. */
    ck('the client no longer reads `state`', !reads.includes('state'));

    /* END-TO-END CONTROL. The checks above are all PASSES, and a suite of passes proves
       nothing about whether the detector can fail. So the original defect is reconstructed
       synthetically — a consumer that reads `p.state` — and run through the same comparison
       against the same real producer keys. If this does not flag, nothing above means
       anything. */
    const defectiveConsumer = "var x = p.status; var y = p.state;";
    const defectiveReads = readsOf(defectiveConsumer, 'p');
    const wouldFlag = defectiveReads.filter((f) => !keys.includes(f));
    ck('CONTROL: the original `p.state` defect IS caught by this comparison',
      wouldFlag.join(',') === 'state', wouldFlag.join(',') || 'NOT CAUGHT');
    ck('…while the correct field in the same snippet is not flagged',
      !wouldFlag.includes('status'));
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   Communication timeline -> comms console
══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── Communication timeline ──');
{
  const producerCode = read('functions/communication-timeline.js');
  const keys = returnedKeys(producerCode, /communicationTimeline\s*=\s*onCall/);
  ck('the producer contract was derived from source', !!keys && keys.length > 4,
    keys ? keys.join(',') : 'NOT FOUND');

  if (keys) {
    ck('…it declares its own incompleteness', keys.includes('complete'));
    ck('…names the coverage', keys.includes('anchorCoverage'));
    ck('…and reports unreadable sources', keys.includes('sourcesUnreadable'));

    const consoleCode = read('sokoni-comms-console.js');
    const reads = readsOf(consoleCode, 'res');
    const unknown = reads.filter((f) => !keys.includes(f));
    ck('every field the console reads is one the producer emits',
      unknown.length === 0, unknown.length ? 'UNKNOWN: ' + unknown.join(',') : reads.join(','));
    ck('…and it reads the partiality flag', reads.includes('complete'));
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   Communication plan / send / health -> comms send surface
══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── Admin send surface ──');
{
  const producerCode = read('functions/communication-send.js');
  const planKeys = returnedKeys(producerCode, /communicationPlan\s*=\s*onCall/);
  const sendKeys = returnedKeys(producerCode, /communicationSend\s*=\s*onCall/);
  const healthKeys = returnedKeys(producerCode, /communicationHealth\s*=\s*onCall/);
  ck('plan contract derived', !!planKeys, planKeys ? planKeys.join(',') : 'NOT FOUND');
  ck('send contract derived', !!sendKeys, sendKeys ? sendKeys.join(',') : 'NOT FOUND');
  ck('health contract derived', !!healthKeys, healthKeys ? healthKeys.join(',') : 'NOT FOUND');

  if (planKeys && sendKeys && healthKeys) {
    /* Both surfaces read the responses through `r`. The union is the contract they may use. */
    const union = [...new Set([].concat(planKeys, sendKeys, healthKeys))];
    const sendSurface = read('sokoni-comms-send.js');
    const reads = readsOf(sendSurface, 'r');
    const unknown = reads.filter((f) => !union.includes(f));
    ck('every field the send surface reads is emitted by one of the three',
      unknown.length === 0, unknown.length ? 'UNKNOWN: ' + unknown.join(',') : reads.join(','));

    /* The honesty fields must survive to the surface. */
    ck('plan returns the ruled-out channels', planKeys.includes('considered'));
    ck('send reports whether it was anchored', sendKeys.includes('anchored'));
    ck('…and whether it was deduped', sendKeys.includes('deduped'));
    ck('health says what it does NOT measure', healthKeys.includes('doesNotMeasure'));
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   Connect session request -> Call button
══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── Call button ──');
{
  const producerCode = read('functions/connect-calls.js');
  const keys = returnedKeys(producerCode, /connectRequestSession\s*=\s*onCall/);
  ck('the request contract was derived', !!keys && keys.length > 4,
    keys ? keys.join(',') : 'NOT FOUND');
  if (keys) {
    ck('…it reports reachability truthfully', keys.includes('reachable'));
    ck('…with a reason', keys.includes('reachableReason'));
    const callCode = read('sokoni-connect-call.js');
    const reads = readsOf(callCode, 'r');
    const unknown = reads.filter((f) => !keys.includes(f));
    ck('every field the Call button reads is emitted',
      unknown.length === 0, unknown.length ? 'UNKNOWN: ' + unknown.join(',') : reads.join(','));
  }
}

console.log('\n' + '─'.repeat(78));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nA field a client reads that the producer does not emit renders as undefined —');
  console.log('silently, and forever, because a hand-written fixture will keep agreeing with it.');
}
process.exit(fail ? 1 : 0);
