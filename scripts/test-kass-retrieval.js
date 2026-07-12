/* Test KASS retrieval scoring against the real corpus — no Firestore, no deploy.
   Proves the RIGHT knowledge surfaces for real Kenyan phrasings, and that
   nonsense queries return grounded=false (so KASS says "I don't know"). */
const path = require('path');
const { CORPUS } = require(path.resolve('functions/kass-corpus.js'));

/* Mirror the engine's scoring exactly (kass-knowledge.js). */
const STOPWORDS = new Set(['the','a','an','is','are','was','were','be','to','of','and','or','in','on','for','with','i','you','he','she','it','we','they','my','your','me','do','does','did','can','how','what','where','when','why','which','who','this','that','there','here','please','want','need','get','have','has','from','at','by','as','if','so','not','no','yes','ok','okay','am','na','ya','wa','za','la','ni','kwa','katika','kuna','nina','nataka','naomba','nipe','hii','hiyo','hizi','ile','yangu','yako','yake','mimi','wewe','yeye','sisi','nyinyi','wao','je','sasa','tu','pia','lakini','ama','au','gani','wapi','nini','vipi','kama','unaweza','naweza','tafadhali','asante','sawa','poa','boss','buda','manze','fam']);
const toks = t => String(t||'').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(x=>x.length>2 && !STOPWORDS.has(x));

function score(q, e) {
  if (!q.length) return 0;
  const s = new Set(q); let n = 0;
  for (const tag of (e.tags||[]))                    if (s.has(String(tag).toLowerCase())) n += 3;
  for (const t of toks((e.questions||[]).join(' '))) if (s.has(t)) n += 2;
  for (const t of toks(e.title))                     if (s.has(t)) n += 2;
  const body = new Set(toks(e.content));
  for (const t of s)                                 if (body.has(t)) n += 1;
  if (n > 0 && (e.category==='policy' || e.category==='pricing')) n += 1;
  return n;
}
const MIN = 2;
function retrieve(query) {
  const q = toks(query);
  const pool = CORPUS.filter(e => e.pinned !== true);   // pinned = behaviour, never scored
  return pool.map(e => ({ e, s: score(q, e) }))
    .filter(x => x.s >= MIN).sort((a,b)=>b.s-a.s).slice(0,6);
}

const CASES = [
  { q: 'Nataka kuuza simu.',                 expect: ['platform-seller-onboarding','platform-marketplace'] },
  { q: 'Hii ni legit ama scam?',             expect: ['guard-scam-check'] },
  { q: 'Boss hii ni how much?',              expect: null },   // price question — see note below
  { q: 'Nipe deal poa.',                     expect: null },
  { q: 'Natafuta fundi karibu.',             expect: ['platform-services'] },
  { q: 'What commission does SOKONI charge?',expect: ['guard-money-facts'] },
  { q: 'SOKONI inachukua ngapi?',            expect: ['guard-money-facts'] },
  { q: 'How do I get a KRA PIN?',            expect: ['kenya-government'] },
  { q: 'Can I pay with mpesa?',              expect: ['kenya-mpesa','platform-wallet-payments'] },
  { q: 'How do I get a refund?',             expect: ['platform-orders-refunds-disputes'] },
  { q: 'My listings are not selling',        expect: ['biz-growth'] },
  { q: 'Niweke bei gani?',                   expect: ['biz-pricing'] },
  { q: 'When is back to school?',            expect: ['kenya-culture-calendar'] },
  { q: 'Natafuta nyumba ya kukodi',          expect: ['platform-hubs'] },
  { q: 'What is SmartPOS?',                  expect: ['platform-smartpos'] },
  /* Must NOT ground — proves KASS will say "I don't know" instead of inventing. */
  { q: 'zzzz qqqq xxxx',                     expect: [] },
  { q: 'What is the capital of France?',     expect: [] },
];

let pass = 0, fail = 0;
console.log('\nKASS retrieval — real Kenyan phrasings\n');
for (const c of CASES) {
  const hits = retrieve(c.q);
  const ids = hits.map(h => h.e.slug);
  const top = ids[0] || '(none)';

  if (c.expect === null) { console.log(`  info  "${c.q}"\n          -> ${ids.slice(0,3).join(', ') || '(no match)'}`); continue; }

  if (c.expect.length === 0) {
    const ok = ids.length === 0;
    ok ? pass++ : fail++;
    console.log(`  [${ok?'PASS':'FAIL'}] "${c.q}" -> ${ok ? 'NOT grounded (KASS will say it does not know)' : 'unexpectedly matched ' + ids.join(', ')}`);
  } else {
    const ok = c.expect.includes(top);
    ok ? pass++ : fail++;
    console.log(`  [${ok?'PASS':'FAIL'}] "${c.q}"\n          top: ${top}${ok?'':'   expected one of: '+c.expect.join(', ')}`);
  }
}
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
