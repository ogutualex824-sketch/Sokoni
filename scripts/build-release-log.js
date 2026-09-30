#!/usr/bin/env node
/* ============================================================================
   SOKONI — Release log builder   (CHANGELOG.md -> release-log.json)
   scripts/build-release-log.js

   WHY THIS EXISTS
   The Updates centre in AdminOS and Super Admin shows "fixes and features in
   order". The only ordered record of them is CHANGELOG.md, and hosting does NOT
   serve it: firebase.json hosting.ignore carries the glob that ignores every .md file. A browser therefore
   cannot read the changelog. This script turns it into a served JSON artefact,
   release-log.json, at the site root.

   WHAT IT DOES NOT CLAIM
   · A changelog entry is a RECORD that work was written up in this tree. It is
     not proof that the work is live. `claim` carries only what the entry's OWN
     heading says ("DEPLOYED …" / "NOT deployed"); it is labelled as the
     changelog's claim in the UI, never as a measured deployment.
   · `type` is inferred ONLY from the title's leading word (fix / feat / docs /
     test / deploy). Anything else is "other" — the body is never mined for a
     guess.
   · There is no generatedAt timestamp. Output is a pure function of
     CHANGELOG.md, so the stale-check (scripts/test-release-log.js) can compare
     a regeneration with the committed file byte-for-byte in meaning.

   KEEPING IT FRESH
   Not wired into predeploy here (firebase.json is owned by the release owner).
   Add `node scripts/build-release-log.js` to hosting.predeploy so every deploy
   ships the log of its own tree. Until then the stale-check test fails whenever
   CHANGELOG.md changes without a regeneration.

   Run:   node scripts/build-release-log.js            (writes release-log.json)
          node scripts/build-release-log.js --check    (exit 1 if stale; writes nothing)
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'CHANGELOG.md');
const OUT = path.join(ROOT, 'release-log.json');

const SCHEMA = 1;
const SUMMARY_MAX = 320;
const FILES_MAX = 40;

/* ── helpers ─────────────────────────────────────────────────────────────── */
const normalise = (t) => String(t).replace(/^﻿/, '').replace(/\r\n?/g, '\n');

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/* Markdown -> plain text for display. The UI renders with textContent, so this
   is about readability, not safety. */
function plain(md) {
  return String(md)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')     /* [text](url) -> text   */
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1') /* [[wiki]] -> wiki    */
    .replace(/`+/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,;:!?)])/g, '$1$2')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:—–-]+$/, '') + '…';
}

/* ── heading ─────────────────────────────────────────────────────────────── */
/* Shapes seen in CHANGELOG.md:
     ## [2026-09-30] - Title          ## [2026-09-30] — Title
     ## 2026-09-30 — Title            ## [2.11.0] — 2026-06-20 — Title
     ## [v1.2.0] — 2026-06-28         ## [1.x] — Prior Releases              */
function parseHeading(raw) {
  let t = raw.trim();
  let version = null;
  const ver = /^\[?(v?\d+(?:\.(?:\d+|x))+)\]?\s*/.exec(t);
  if (ver) { version = ver[1]; t = t.slice(ver[0].length); }
  t = t.replace(/^(?:[—–:-]|â€”|â€“)\s*/, '');
  let date = null;
  const dm = /^\[?(\d{4}-\d{2}-\d{2})\]?\s*/.exec(t);
  if (dm && validDate(dm[1])) { date = dm[1]; t = t.slice(dm[0].length); }
  else {
    const any = /\b(\d{4}-\d{2}-\d{2})\b/.exec(raw);
    if (any && validDate(any[1])) date = any[1];
  }
  t = t.replace(/^(?:[—–:-]|â€”|â€“)\s*/, '').trim();
  let title = plain(t);
  if (!title) title = version ? 'Release ' + version : plain(raw);
  return { date, version, title };
}

/* type from the LEADING word only. */
function inferType(title) {
  const w = String(title).trim();
  if (/^(fix|fixes|fixed|hotfix|bugfix)\b/i.test(w)) return 'fix';
  if (/^(feat|feature)\b/i.test(w)) return 'feat';
  if (/^(docs?)\b/i.test(w)) return 'docs';
  if (/^(tests?)\b/i.test(w)) return 'test';
  if (/^deployed\b/i.test(w)) return 'deploy';   /* a deployment RECORD — not "Deploy guard: …" */
  return 'other';
}

/* What the heading itself says about deployment. Heading only — a body that
   mentions "deployed" is usually talking about something else. */
function deployClaim(heading) {
  if (/\bnot\s+deployed\b/i.test(heading)) return 'not-deployed';
  if (/\bdeployed\b/i.test(heading)) return 'deployed';
  return null;
}

/* Commit ids named in the heading: 7–10 hex (a short sha) or 40 (a full one),
   with at least one letter so a bare number is never a commit. Hosting
   version ids (16 hex) are deliberately excluded. */
function headingCommits(heading) {
  const out = [];
  const re = /\b([0-9a-f]{7,40})\b/g;
  let m;
  while ((m = re.exec(heading)) !== null) {
    const h = m[1];
    if (!((h.length >= 7 && h.length <= 10) || h.length === 40)) continue;
    if (!/[a-f]/.test(h) || !/\d/.test(h)) continue;
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

/* ── body ────────────────────────────────────────────────────────────────── */
function paragraphs(body) {
  return body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

function summaryOf(body) {
  for (const p of paragraphs(body)) {
    if (/^-{3,}$/.test(p)) continue;
    if (/^#{1,6}\s/.test(p)) continue;
    if (/^\*\*files\b/i.test(p)) continue;
    if (/^```/.test(p)) continue;
    const s = plain(p);
    if (s) return truncate(s, SUMMARY_MAX);
  }
  return '';
}

const FILE_TOKEN = /^(?:new\s+)?([\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,6}|[\w@.-]+(?:\/[\w@.-]+)+\/?)$/;

function filesOf(body) {
  const lines = body.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\*\*files\b/i.test(lines[i])) continue;
    /* The Files paragraph, plus a bullet list directly under it. */
    let j = i;
    const block = [];
    while (j < lines.length && lines[j].trim() !== '') { block.push(lines[j]); j++; }
    if (block.length === 1 && j < lines.length) {
      let k = j + 1;
      while (k < lines.length && /^\s*[-*+]\s/.test(lines[k])) { block.push(lines[k]); k++; }
    }
    const re = /`([^`\n]+)`/g;
    let m;
    const text = block.join('\n');
    while ((m = re.exec(text)) !== null) {
      const tok = m[1].trim().replace(/\s*\(.*\)$/, '');
      const fm = FILE_TOKEN.exec(tok);
      if (fm && !found.includes(fm[1])) found.push(fm[1]);
    }
    break;   /* the first Files block is the entry's own */
  }
  return found;
}

/* ── the parser ──────────────────────────────────────────────────────────── */
function parseChangelog(text) {
  const src = normalise(text);
  const lines = src.split('\n');
  const raw = [];
  let cur = null;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const h = !inFence && /^## (?!#)(.+)$/.exec(line);
    if (h) {
      if (cur) raw.push(cur);
      cur = { heading: h[1].trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) raw.push(cur);

  const seen = new Map();
  const entries = raw.map((r, index) => {
    const body = r.body.join('\n').replace(/\n-{3,}\s*$/, '').trim();
    const { date, version, title } = parseHeading(r.heading);
    const base = crypto.createHash('sha1').update(r.heading).digest('hex').slice(0, 10);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    const files = filesOf(body);
    const e = {
      id: n === 1 ? base : base + '-' + n,
      date,
      title,
      type: inferType(title),
      claim: deployClaim(r.heading),
      commits: headingCommits(r.heading),
      summary: summaryOf(body),
      files: files.slice(0, FILES_MAX),
      filesMore: Math.max(0, files.length - FILES_MAX),
      position: index,
    };
    if (version) e.version = version;
    return e;
  });

  /* In order: newest date first; within a date the changelog's own order (it is
     written newest-first); undated entries last, in file order. */
  entries.sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (!!a.date !== !!b.date) return a.date ? -1 : 1;
    return a.position - b.position;
  });
  return entries;
}

function sourceHash(text) {
  return crypto.createHash('sha256').update(normalise(text), 'utf8').digest('hex');
}

function buildReleaseLog(text) {
  const entries = parseChangelog(text);
  return {
    schema: SCHEMA,
    source: 'CHANGELOG.md',
    sourceSha256: sourceHash(text),
    entryCount: entries.length,
    note: 'Generated from CHANGELOG.md by scripts/build-release-log.js. An entry records that work was written up in this tree; '
        + '"claim" is only what the entry heading itself says about deployment. Live deployment is proven only by /version.json.',
    entries,
  };
}

/* One entry per line: reviewable diffs, stable bytes. */
function serialise(log) {
  const head = Object.assign({}, log);
  delete head.entries;
  const h = JSON.stringify(head);
  return h.slice(0, -1) + ',"entries":[\n'
    + log.entries.map((e) => JSON.stringify(e)).join(',\n')
    + '\n]}\n';
}

module.exports = { parseChangelog, parseHeading, inferType, deployClaim, headingCommits,
                   summaryOf, filesOf, buildReleaseLog, serialise, sourceHash, SRC, OUT };

if (require.main === module) {
  const text = fs.readFileSync(SRC, 'utf8');
  const out = serialise(buildReleaseLog(text));
  if (process.argv.includes('--check')) {
    let have = null;
    try { have = fs.readFileSync(OUT, 'utf8'); } catch (_) {}
    const fresh = have != null && normalise(have) === normalise(out);
    console.log(fresh ? 'release-log.json is current with CHANGELOG.md'
                      : 'release-log.json is STALE — run: node scripts/build-release-log.js');
    process.exit(fresh ? 0 : 1);
  }
  fs.writeFileSync(OUT, out);
  const log = JSON.parse(out);
  console.log('release-log.json: ' + log.entryCount + ' entries, ' + Buffer.byteLength(out) + ' bytes, source sha256 ' + log.sourceSha256.slice(0, 12));
}
