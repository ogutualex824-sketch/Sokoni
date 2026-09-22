/* ============================================================================
   Firestore rules — a state-aware block scanner
   ============================================================================
   Three parsers in a row failed here, and all three failed the same way: they
   inferred syntax from raw text instead of tokenising it.

     1. "first { after the declaration"  ->  grabbed the PATH wildcard in
                                             match /shops/{storeId}
     2. same assumption                  ->  grabbed the DEFAULT PARAMETER in
                                             function f(a = {})
     3. body-only comment handling       ->  found the word `match` inside
                                             /* ... *​/ prose and reported comment
                                             text as a rule path

   The lesson is not three bug fixes. It is that recognition must happen in ONE
   pass that always knows whether it is in code, a comment or a string — during
   the SEARCH, not only while reading a body. That is what this does.
   ========================================================================= */
'use strict';

const CODE = 0, LINE = 1, BLOCK = 2, STR = 3;

/**
 * scan(src) -> [{ path, header, body, start, end }]
 *
 * Every `match` that is real syntax, at any nesting depth. A `match` inside a
 * comment or a string is not syntax and is never returned.
 */
function scan(src) {
  const out = [];
  const n = src.length;
  let i = 0, mode = CODE, quote = '';

  /* Advance one position, maintaining mode. Returns the next index. */
  function step(p) {
    const c = src[p], c2 = src[p + 1];
    if (mode === CODE) {
      if (c === '/' && c2 === '/') { mode = LINE; return p + 2; }
      if (c === '/' && c2 === '*') { mode = BLOCK; return p + 2; }
      if (c === '"' || c === "'" || c === '`') { mode = STR; quote = c; return p + 1; }
      return p + 1;
    }
    if (mode === LINE) { if (c === '\n') mode = CODE; return p + 1; }
    if (mode === BLOCK) { if (c === '*' && c2 === '/') { mode = CODE; return p + 2; } return p + 1; }
    /* STR */
    if (c === '\\') return p + 2;
    if (c === quote) mode = CODE;
    return p + 1;
  }

  const isWord = (ch) => !!ch && /[A-Za-z0-9_$]/.test(ch);

  while (i < n) {
    if (mode === CODE && src.startsWith('match', i) &&
        !isWord(src[i - 1]) && !isWord(src[i + 5])) {
      const parsed = parseMatch(src, i);
      if (parsed) {
        out.push(parsed);
        /* Continue INSIDE the body so nested matches are found, and re-enter
           with a clean mode — the body parser leaves mode balanced. */
        i = parsed.bodyOpen + 1;
        mode = CODE; quote = '';
        continue;
      }
    }
    i = step(i);
  }
  return out;

  /* Parse one match starting at `at`. Returns null if it is not well-formed. */
  function parseMatch(s, at) {
    let p = at + 5, m = CODE, q = '', curly = 0, paren = 0, open = -1;
    /* The PATH: runs until a '{' that is not a wildcard or inside parens. */
    while (p < n) {
      const c = s[p], c2 = s[p + 1];
      if (m === CODE) {
        if (c === '/' && c2 === '/') { m = LINE; p += 2; continue; }
        if (c === '/' && c2 === '*') { m = BLOCK; p += 2; continue; }
        if (c === '"' || c === "'") { m = STR; q = c; p++; continue; }
        if (c === '(') { paren++; p++; continue; }
        if (c === ')') { paren--; p++; continue; }
        if (c === '{') {
          /* A wildcard brace directly follows '/' or sits inside parens. */
          if (paren > 0 || s[p - 1] === '/') { curly++; p++; continue; }
          open = p; break;
        }
        if (c === '}') { if (curly > 0) curly--; p++; continue; }
        if (c === ';') return null;           /* not a match statement */
        p++; continue;
      }
      if (m === LINE) { if (c === '\n') m = CODE; p++; continue; }
      if (m === BLOCK) { if (c === '*' && c2 === '/') { m = CODE; p += 2; } else p++; continue; }
      if (c === '\\') { p += 2; continue; }
      if (c === q) m = CODE;
      p++;
    }
    if (open < 0) return null;

    /* The BODY: balanced braces, comments and strings ignored. */
    let d = 0, k = open; m = CODE; q = '';
    while (k < n) {
      const c = s[k], c2 = s[k + 1];
      if (m === CODE) {
        if (c === '/' && c2 === '/') { m = LINE; k += 2; continue; }
        if (c === '/' && c2 === '*') { m = BLOCK; k += 2; continue; }
        if (c === '"' || c === "'") { m = STR; q = c; k++; continue; }
        if (c === '{') d++;
        else if (c === '}') { d--; if (d === 0) break; }
        k++; continue;
      }
      if (m === LINE) { if (c === '\n') m = CODE; k++; continue; }
      if (m === BLOCK) { if (c === '*' && c2 === '/') { m = CODE; k += 2; } else k++; continue; }
      if (c === '\\') { k += 2; continue; }
      if (c === q) m = CODE;
      k++;
    }
    if (d !== 0) return null;

    return {
      path: s.slice(at + 5, open).trim(),
      header: s.slice(at, open).trim(),
      body: s.slice(open, k + 1),
      start: at, bodyOpen: open, end: k + 1,
    };
  }
}

/** Normalised body: comments removed, whitespace collapsed. */
function normalise(body) {
  return String(body).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ').trim();
}

module.exports = { scan, normalise };
