'use strict';
/* Home-page KASS chat (script.js sendMessage) must send the signed-in user's Firebase ID token. On live it sent
   NONE, so sokoniChat answered every message with "Authentication required" (shown as the bot's reply).
   Runs the REAL sendMessage from script.js with DOM / auth / fetch stubs.
     node scripts/test-home-kass-chat.js              (this tree)
     BASE=<rev> node scripts/test-home-kass-chat.js   (baseline; live 72dca56 must FAIL C-1/C-2) */
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const src = process.env.BASE
  ? execSync('git show ' + process.env.BASE + ':script.js', { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 << 20 })
  : fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
const a = src.indexOf('const _CHAT_FN'); const f = src.indexOf('function sendMessage', a);
let depth = 0, end = -1; for (let i = src.indexOf('{', f); i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) { end = i + 1; break; } } }
const block = src.slice(a, end);
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const flush = () => new Promise((r) => setTimeout(r, 10));

async function run(user, serverStatus, serverBody) {
  const fetches = [], bot = [];
  const el = (id) => ({ id, value: 'find me a phone', remove() {}, appendChild() {}, scrollTop: 0, scrollHeight: 0, classList: { add() {} }, set innerHTML(v) {} });
  const document = { getElementById: (id) => (id === 'quickReplies' ? null : el(id)), createElement: () => el('x') };
  const ctx = { document, window: { firebaseAuth: { currentUser: user } }, JSON, Promise, setTimeout, console: { log() {}, warn() {} },
    addUserMessage() {}, addBotMessage: (t) => bot.push(t), botReply: () => 'offline reply',
    fetch: (url, opts) => { fetches.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve({ status: serverStatus, json: () => Promise.resolve(serverBody) }); } };
  vm.createContext(ctx);
  vm.runInContext(block.replace(/^const /gm, 'var ') + '\n;sendMessage();', ctx);
  await flush(); await flush();
  return { fetches, bot };
}

(async () => {
  console.log('\nHome KASS chat   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
  const user = { getIdToken: () => Promise.resolve('ID.TOKEN.buyer1') };
  let r = await run(user, 200, { response: 'Here are phones…' });
  ck('C-1', r.fetches.length === 1 && r.fetches[0].body.auth_token === 'ID.TOKEN.buyer1', 'a signed-in user\'s message carries their Firebase ID token', r.fetches.map((x) => x.body.auth_token));
  ck('C-2', r.bot.includes('Here are phones…'), 'the reply shown is the model\'s answer', r.bot);
  r = await run(null, 401, { error: 'Authentication required to use KASS AI.' });
  ck('C-3', r.fetches.length === 0 && /sign in/i.test(r.bot.join(' ')), 'a signed-out visitor is asked to sign in, and the paid endpoint is NOT called', r);
  r = await run(user, 429, { error: "You've reached today's KASS limit. Please try again tomorrow — everything else on SOKONI works as usual.", code: 'kass_user_quota' });
  ck('C-4', /today's KASS limit/.test(r.bot.join(' ')), 'the daily limit shows the server\'s friendly message', r.bot);
  r = await run(user, 401, { error: 'Your sign-in has expired', code: 'auth_expired' });
  ck('C-5', /sign in again/i.test(r.bot.join(' ')), 'an expired sign-in asks the user to sign in again', r.bot);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
