'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   js-tokens — a small, dependency-free JavaScript TOKENIZER for static detectors.

   Why this exists: detectors that "strip comments and strings" with a quote-tracking state
   machine go out of phase on the first REGEX LITERAL that contains a quote — e.g.
   `.replace(/"/g,'&quot;').replace(/'/g,'&#39;')` — and from there on treat code as string and
   strings as code. Real comments survive, `//` inside a URL is taken as a line comment, and
   whole calls vanish from the scan. That silently converted a live defect (electrical.html
   'elc-write') into a false "stale baseline" report. AST not regex.

   No parser package is resolvable from the repo root (acorn/espree/esprima are absent), so
   this is a real lexer instead:
     · strings, with escapes and line continuations; a raw newline is an error
     · template literals, including NESTED `${ … }` expressions that contain quotes, braces,
       regexes and further templates (tracked on the same bracket stack as code)
     · regex literals, including `/` inside [character classes] and escaped `\/`, using the
       standard "is a regex allowed here?" rule from the previous significant token
       (`)` that closes an if/while/for/with head allows a regex; a `.name` never is a keyword)
     · line comments, block comments and the HTML-compat `<!--` / line-leading `-->` comments
     · bracket MATCHING for ( [ { and ${ … } — a mismatch or anything left open is an error

   It FAILS CLOSED: anything it cannot lex throws a JsTokenizeError with a line number. A
   caller must treat a throw as "this source was not analysed", never as "clean".
   ══════════════════════════════════════════════════════════════════════════════ */

class JsTokenizeError extends Error {
  constructor(msg, line) { super(msg + ' (line ' + line + ')'); this.line = line; }
}

const ID_START = /[\p{ID_Start}$_#\\]/u;          /* # = private name, \ = unicode escape */
const ID_CONT = /[\p{ID_Continue}$\u200c\u200d\\]/u;
const WS = /[\s\uFEFF]/;
const NL = /[\n\r\u2028\u2029]/;
const NUM = /(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/y;
/* After these keywords an expression (so possibly a regex) begins. */
const EXPR_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await', 'extends']);
const COND_HEADS = new Set(['if', 'while', 'for', 'with']);
const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!',
  '~', '?', ':', '=', '.', '@'];
const OPEN_FOR = { ')': '(', ']': '[', '}': '{' };

/**
 * @param {string} src JavaScript source (classic script or module).
 * @returns {{type:'name'|'num'|'string'|'template'|'regex'|'punct', value:string, line:number,
 *            noSub?:boolean, closesCond?:boolean}[]}
 *   `string` value = the literal's raw contents (no quotes). `template` tokens are the literal
 *   pieces between substitutions; `noSub` is true for a template with no `${}` at all.
 * @throws {JsTokenizeError}
 */
function tokenize(src) {
  const toks = [];
  const stack = [];                 /* entries: { ch: '(' | '[' | '{' | '${', cond?: bool } */
  const n = src.length;
  let i = 0, line = 1;
  if (src.startsWith('#!')) { while (i < n && !NL.test(src[i])) i++; }

  const fail = (msg) => { throw new JsTokenizeError(msg, line); };
  const advance = (to) => { for (; i < to; i++) if (src[i] === '\n') line++; };
  const push = (type, value, extra) => { const t = { type, value, line }; if (extra) Object.assign(t, extra); toks.push(t); return t; };

  function regexAllowed() {
    const t = toks[toks.length - 1];
    if (!t) return true;
    if (t.type === 'name') {
      const before = toks[toks.length - 2];
      if (before && before.type === 'punct' && (before.value === '.' || before.value === '?.')) return false;
      return EXPR_KEYWORDS.has(t.value);
    }
    if (t.type === 'template') return !t.tail; /* after `…${ an expression starts */
    if (t.type !== 'punct') return false;   /* num, string, regex, closed template → division */
    if (t.value === ')') return !!t.closesCond;
    if (t.value === ']' || t.value === '++' || t.value === '--') return false;
    return true;                             /* includes '}' (end of a block) */
  }

  /* Reads template characters from i (just after ` or after the } closing a substitution). */
  function readTemplate(isHead) {
    let start = i, startLine = line;
    for (;;) {
      if (i >= n) { line = startLine; fail('unterminated template literal'); }
      const c = src[i];
      if (c === '\\') { advance(i + 2); continue; }
      if (c === '`') {
        push('template', src.slice(start, i), { noSub: isHead, tail: true });
        i++; return;
      }
      if (c === '$' && src[i + 1] === '{') {
        push('template', src.slice(start, i), { noSub: false, tail: false });
        stack.push({ ch: '${' });
        i += 2; return;
      }
      advance(i + 1);
    }
  }

  while (i < n) {
    const c = src[i], d = src[i + 1];

    if (WS.test(c)) { advance(i + 1); continue; }

    /* comments */
    if (c === '/' && d === '/') { while (i < n && !NL.test(src[i])) i++; continue; }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) fail('unterminated block comment');
      advance(end + 2); continue;
    }
    if (c === '<' && src.startsWith('<!--', i)) { while (i < n && !NL.test(src[i])) i++; continue; }
    if (c === '-' && src.startsWith('-->', i)) {
      let k = i - 1; while (k >= 0 && WS.test(src[k]) && !NL.test(src[k])) k--;
      if (k < 0 || NL.test(src[k])) { while (i < n && !NL.test(src[i])) i++; continue; }
    }

    /* strings */
    if (c === '"' || c === "'") {
      const startLine = line;
      let k = i + 1;
      for (;;) {
        if (k >= n) { line = startLine; fail('unterminated string literal'); }
        const e = src[k];
        if (e === '\\') { k += (src[k + 1] === '\r' && src[k + 2] === '\n') ? 3 : 2; continue; }
        if (e === c) break;
        if (e === '\n' || e === '\r') { line = startLine; fail('newline inside string literal'); }
        k++;
      }
      push('string', src.slice(i + 1, k));
      advance(k + 1); continue;
    }

    /* templates */
    if (c === '`') { i++; readTemplate(true); continue; }

    /* regex literal */
    if (c === '/' && regexAllowed()) {
      let k = i + 1, inClass = false;
      for (;;) {
        if (k >= n || NL.test(src[k])) fail('unterminated regular expression literal');
        const e = src[k];
        if (e === '\\') { if (NL.test(src[k + 1] || '\n')) fail('unterminated regular expression literal'); k += 2; continue; }
        if (inClass) { if (e === ']') inClass = false; k++; continue; }
        if (e === '[') { inClass = true; k++; continue; }
        if (e === '/') break;
        k++;
      }
      k++;
      while (k < n && ID_CONT.test(src[k])) k++;   /* flags */
      push('regex', src.slice(i, k));
      i = k; continue;
    }

    /* numbers */
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d || ''))) {
      NUM.lastIndex = i;
      const m = NUM.exec(src);
      if (!m) fail('bad numeric literal');
      push('num', m[0]); i += m[0].length; continue;
    }

    /* identifiers / keywords (code-point aware) */
    const cp = String.fromCodePoint(src.codePointAt(i));
    if (ID_START.test(cp)) {
      let k = i + cp.length;
      while (k < n) {
        const ch = String.fromCodePoint(src.codePointAt(k));
        if (!ID_CONT.test(ch)) break;
        k += ch.length;
      }
      push('name', src.slice(i, k)); i = k; continue;
    }

    /* brackets */
    if (c === '(' || c === '[' || c === '{') {
      const prev = toks[toks.length - 1];
      stack.push({ ch: c, cond: c === '(' && !!prev && prev.type === 'name' && COND_HEADS.has(prev.value) });
      push('punct', c); i++; continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      const top = stack.pop();
      if (c === '}' && top && top.ch === '${') { i++; readTemplate(false); continue; }
      if (!top) fail('unmatched "' + c + '"');
      if (top.ch !== OPEN_FOR[c]) fail('"' + c + '" closes "' + top.ch + '"');
      push('punct', c, c === ')' && top.cond ? { closesCond: true } : null); i++; continue;
    }

    /* other punctuators — longest match; `?.` followed by a digit is `?` (conditional) */
    let p = PUNCT.find((q) => src.startsWith(q, i));
    if (p === '?.' && /[0-9]/.test(src[i + 2] || '')) p = '?';
    if (!p) fail('unexpected character ' + JSON.stringify(c));
    push('punct', p); i += p.length;
  }

  if (stack.length) fail('unclosed "' + stack[stack.length - 1].ch + '"');
  return toks;
}


/**
 * Extracts the bodies of inline <script> elements that a browser would EXECUTE as JavaScript
 * (no type, or a JavaScript/module type), in document order. HTML comments and RAW-TEXT
 * elements (style, textarea, title, xmp, noscript) are skipped: a "<script>" written inside a
 * CSS comment or a commented-out block is text, not a script. A script ends at the first
 * "</script" — exactly as in a browser, even when that sits inside a JS string.
 * Returns [{ index, line, module, code }].
 */
function extractInlineScripts(html) {
  const out = [];
  const JS_TYPE = /^(?:module|(?:text|application)\/(?:x-)?(?:java|ecma)script)$/i;
  const NEXT = /<!--|<(script|style|textarea|title|xmp|noscript)\b([^>]*)>/ig;
  let i = 0, idx = 0;
  for (;;) {
    NEXT.lastIndex = i;
    const m = NEXT.exec(html);
    if (!m) break;
    if (m[0] === '<!--') {
      const end = html.indexOf('-->', m.index + 4);
      if (end < 0) break;
      i = end + 3; continue;
    }
    const tag = m[1].toLowerCase();
    const close = new RegExp('</' + tag + '[\\s/]*>', 'ig');
    close.lastIndex = NEXT.lastIndex;
    const cm = close.exec(html);
    const bodyStart = NEXT.lastIndex;
    const bodyEnd = cm ? cm.index : html.length;
    i = cm ? close.lastIndex : html.length;
    if (tag !== 'script') continue;
    const body = html.slice(bodyStart, bodyEnd);
    const tm = m[2].match(/\btype\s*=\s*["']?([^"'\s>]*)/i);
    const type = tm ? tm[1].trim() : '';
    if (type && !JS_TYPE.test(type)) continue;
    if (!body.trim()) continue;
    idx++;
    out.push({ index: idx, line: html.slice(0, bodyStart).split('\n').length, module: /^module$/i.test(type), code: body });
  }
  return out;
}

/* Used by scripts/test-secondary-firebase-apps.js — kept here so the detector itself can be
   exercised directly (negative controls, other refs) without running the whole suite. */
/** JS source → secondary app names. Throws (JsTokenizeError) if the source cannot be lexed. */
function findSecondaryAppsInJs(code) {
  const toks = tokenize(code);
  const names = [];
  for (let k = 0; k < toks.length - 1; k++) {
    const t = toks[k];
    if (t.type !== 'name' || t.value !== 'initializeApp') continue;
    if (!(toks[k + 1].type === 'punct' && toks[k + 1].value === '(')) continue;
    const prev = toks[k - 1];
    if (prev && prev.type === 'name' && prev.value === 'function') continue;   /* a declaration, not a call */
    /* Collect top-level arguments by balancing ( [ { — template substitutions are not
       emitted as brackets, and the tokenizer has already proven every bracket matches. */
    const args = [[]];
    let depth = 0, j = k + 2;
    for (; j < toks.length; j++) {
      const a = toks[j];
      if (a.type === 'punct') {
        if (a.value === '(' || a.value === '[' || a.value === '{') depth++;
        else if (a.value === ')' && depth === 0) break;
        else if (a.value === ')' || a.value === ']' || a.value === '}') depth--;
        else if (a.value === ',' && depth === 0) { args.push([]); continue; }
      }
      args[args.length - 1].push(a);
    }
    /* Two arguments and a literal second one === a NAMED (secondary) app.
       initializeApp(cfg) alone is the DEFAULT app and is correct — App Check attaches there. */
    if (args.length >= 2 && args[1].length === 1) {
      const a = args[1][0];
      if ((a.type === 'string' || (a.type === 'template' && a.noSub)) && a.value) names.push(a.value);
    }
  }
  return names;
}

module.exports = { tokenize, extractInlineScripts, findSecondaryAppsInJs, JsTokenizeError };
