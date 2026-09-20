/* Lists, for each LIVE-AHEAD file, the identifiers live added that exist
   NOWHERE on the candidate — the genuine reading list.

   Written as a FILE rather than run through `node -e`: a shell-quoted one-liner
   eats one level of backslash, so "\\b" arrives as a literal backspace and the
   word-boundary anchor silently becomes a control character. Every identifier
   then reads as absent, including ones present in a hundred files. Regex
   anchors and shell quoting do not mix.

   READ-ONLY.

   RUN  node scripts/release/absent-ids.js <liveRef> <candRef> <file> [file...]
*/
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const LIVE = process.argv[2], CAND = process.argv[3], FILES = process.argv.slice(4);
const REPO = path.resolve(__dirname, '..', '..');
const git = (a) => { try { return execFileSync('git', a, { cwd: REPO, encoding: 'utf8', maxBuffer: 128e6 }); } catch (e) { return ''; } };

const candFiles = git(['ls-tree', '-r', CAND, '--name-only']).split('\n')
  .filter((p) => /\.(html|js|css|mjs)$/i.test(p) && !/^docs\//i.test(p) && !/^scripts\//i.test(p));
const corpus = new Map();
for (const f of candFiles) corpus.set(f, git(['show', `${CAND}:${f}`]));

function hist(ref, f) {
  const o = [];
  git(['log', ref, '--format=%H', '--', f]).split('\n').filter(Boolean).forEach((c) => {
    const m = /^\d+ blob ([0-9a-f]+)\t/.exec(git(['ls-tree', c, '--', f]).trim());
    if (m) o.push(m[1]);
  });
  return o;
}

const PATTERNS = [
  /\bid=["']([a-zA-Z][\w-]{3,})["']/g,
  /\bfunction\s+([a-zA-Z_$][\w$]{3,})/g,
  /\bsrc=["']([\w.-]+\.js)["']/g,
  /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]{4,})\s*=/g,
  /\bclass=["']([a-z]{2,}-[\w-]{3,})["']/g,
];

for (const F of FILES) {
  const cb = new Set(hist(CAND, F));
  const fork = hist(LIVE, F).find((b) => cb.has(b));
  if (!fork) { console.log(F + '  NO SHARED BLOB'); continue; }
  const own = corpus.get(F) || '';
  const added = git(['diff', fork, git(['rev-parse', `${LIVE}:${F}`]).trim()]).split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));

  const ids = new Set();
  for (const l of added) for (const re of PATTERNS) { re.lastIndex = 0; let m; while ((m = re.exec(l)) !== null) ids.add(m[1]); }
  const novel = [...ids].filter((i) => own.indexOf(i) === -1);

  const absent = novel.filter((i) => {
    const re = new RegExp('\\b' + i.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') + '\\b');
    for (const [f, b] of corpus) { if (f === F) continue; if (re.test(b)) return false; }
    return true;
  });
  console.log(F.padEnd(26) + 'novel=' + String(novel.length).padEnd(4) +
              'absent=' + String(absent.length).padEnd(4) + (absent.join(', ') || '(none)'));
}
