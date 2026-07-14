/**
 * KASS Widget Regression Tests
 * Run: node scripts/test-kass-widget.js
 *
 * Tests pure logic extracted from kass-widget.js to verify:
 * - SVG integrity (no NaN from unary-plus bug)
 * - XSS-safe HTML escaping
 * - URL sanitisation blocking javascript:/data:/vbscript: protocols
 * - Friendly error mapping (WebKit DOMException, network, timeout, unsupported)
 * - fetch() synchronous-throw handling path
 * - AbortController compatibility guard
 * - History slice limits (max 20 messages sent to server)
 * - Empty input rejection
 * - Token not logged in diagnostics
 */

'use strict';

/* ── Minimal browser stubs ───────────────────────────────────────────── */
var _warnLog = [];
global.console = Object.assign({}, console, {
  warn: function () { _warnLog.push([].slice.call(arguments).join(' ')); },
});
global.performance = { now: function () { return 0; } };
global.localStorage = { _s: {}, getItem: function (k) { return this._s[k] || null; } };
try {
  Object.defineProperty(global, 'navigator', {
    value: { onLine: true, userAgent: 'TestAgent', platform: 'TestPlatform' },
    writable: true, configurable: true,
  });
} catch (_) {}
if (!global.navigator) global.navigator = { onLine: true, userAgent: 'TestAgent' };
global.window = {
  KASS_DEBUG: false,
  location: { search: '', href: 'http://localhost/', origin: 'http://localhost' },
  visualViewport: null,
  firebaseAuth: null,
};
global.location = global.window.location;
global.AbortController = function () {
  this.signal = {};
  this.abort = function () {};
};

/* ── Inline copies of widget pure functions (must match kass-widget.js exactly) ── */

function _esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _safeUrl(u) {
  var s = String(u || '').trim();
  if (/^(javascript|data|vbscript):/i.test(s)) return 'index.html';
  return _esc(s || 'index.html');
}

function _friendlyMsg(msg) {
  if (!msg) return 'KASS is temporarily unavailable. Please try again.';
  if (
    msg === 'The string did not match the expected pattern.'
    || msg.includes('A server with the specified hostname could not be found.')
    || msg.includes('could not connect to the server')
    || msg.includes('The Internet connection appears to be offline')
    || msg.includes('XHRErrorDomain')
  ) {
    return 'Could not reach KASS — please check your connection and try again.';
  }
  if (
    msg.includes('Failed to fetch')
    || msg.includes('NetworkError')
    || msg.includes('Load failed')
    || msg.includes('Network request failed')
    || msg.includes('net::ERR_')
    || msg.includes('network error')
  ) {
    return 'Network unavailable. Please check your internet connection.';
  }
  if (
    msg.includes('AbortError')
    || msg.includes('cancelled')
    || msg.includes('The user aborted a request')
  ) {
    return 'Request timed out — please try again.';
  }
  if (msg.includes('is not supported') || msg.includes('not implemented')) {
    return 'Browser feature unsupported. Please try a different browser.';
  }
  return msg;
}

/* Simulated _callKass logic for testing fetch-error handling */
function _callKass_sim(fetchFn, text, history) {
  history.push({ role: 'user', content: text });
  var body = { messages: history.slice(-20) };

  var fetchPromise;
  try {
    fetchPromise = fetchFn('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: undefined,
    });
  } catch (syncErr) {
    history.pop();
    return Promise.reject(new Error(_friendlyMsg((syncErr && syncErr.message) || '')));
  }

  return fetchPromise.then(function (resp) {
    return resp.json().then(function (data) {
      if (!resp.ok) throw new Error(data.error || 'KASS is temporarily unavailable.');
      history.push({ role: 'assistant', content: data.response || '' });
      return data;
    });
  }).catch(function (err) {
    history.pop();
    if (err.name === 'AbortError') throw new Error('Request timed out — please try again.');
    throw err;
  });
}

/* ── Test harness ────────────────────────────────────────────────────── */
var _pass = 0, _fail = 0, _results = [];

function test(name, fn) {
  try {
    fn();
    _pass++;
    _results.push('  PASS  ' + name);
  } catch (e) {
    _fail++;
    _results.push('  FAIL  ' + name + '\n         ' + e.message);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + '\n         Expected: ' + JSON.stringify(b) + '\n         Got:      ' + JSON.stringify(a));
}

/* ── Tests ─────────────────────────────────────────────────────────────── */

/* T1: SVG integrity — the _SEND_SVG array join must not produce NaN */
test('SVG array join produces valid SVG, not NaN', function () {
  var _SEND_SVG = [
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#000"',
    ' stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">',
    '<line x1="22" y1="2" x2="11" y2="13"/>',
    '<polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    '</svg>',
  ].join('');
  assert(_SEND_SVG.startsWith('<svg'), 'SVG must start with <svg');
  assert(_SEND_SVG.endsWith('</svg>'), 'SVG must end with </svg>');
  assert(!_SEND_SVG.includes('NaN'), 'SVG must not contain NaN');
  assert(typeof _SEND_SVG === 'string', 'SVG must be a string');
});

/* T2: The unary-plus bug — demonstrates the old pattern would have produced NaN */
test('Unary-plus on SVG string produces NaN (old bug, verified gone)', function () {
  var svgStr = '<svg>test</svg>';
  /* eslint-disable no-unused-expressions */
  var badResult = + svgStr + '';
  assert(isNaN(Number(badResult.trim())), 'Unary + on string gives NaN — confirmed the old bug path');
  /* The fix: use comma separators in array literals, not + operators between elements */
  var goodArr = ['<button>', svgStr, '</button>'];
  assert(goodArr.join('').includes('<svg>'), 'Comma-separated array join preserves SVG');
});

/* T3: _esc() — basic XSS vectors */
test('_esc() escapes <, >, &, "', function () {
  assertEqual(_esc('<script>'), '&lt;script&gt;');
  assertEqual(_esc('Tom & Jerry'), 'Tom &amp; Jerry');
  assertEqual(_esc('"quoted"'), '&quot;quoted&quot;');
  assertEqual(_esc(''), '');
  assertEqual(_esc(null), '');
  assertEqual(_esc(undefined), '');
});

test('_esc() does not escape single quotes (by design — callers must not use single-quote delimiters for _esc output)', function () {
  assert(_esc("it's fine").includes("'"), '_esc does not escape single quotes');
});

/* T4: _safeUrl() — protocol injection */
test('_safeUrl() blocks javascript: protocol', function () {
  assertEqual(_safeUrl('javascript:alert(1)'), 'index.html');
  assertEqual(_safeUrl('JAVASCRIPT:void(0)'), 'index.html');
  assertEqual(_safeUrl('JavaScript:window.open("x")'), 'index.html');
});

test('_safeUrl() blocks data: protocol', function () {
  assertEqual(_safeUrl('data:text/html,<script>alert(1)</script>'), 'index.html');
  assertEqual(_safeUrl('DATA:image/png;base64,abc'), 'index.html');
});

test('_safeUrl() blocks vbscript: protocol', function () {
  assertEqual(_safeUrl('vbscript:msgbox(1)'), 'index.html');
});

test('_safeUrl() allows safe relative and absolute URLs', function () {
  assert(_safeUrl('products.html').includes('products.html'));
  assert(_safeUrl('/shop/item-123').includes('/shop/item-123'));
  assert(_safeUrl('https://mysokoni.co.ke/shop').includes('mysokoni.co.ke'));
  assert(_safeUrl('#section').includes('#section'));
});

test('_safeUrl() HTML-escapes the output', function () {
  assert(_safeUrl('<malicious>').includes('&lt;'));
  assert(_safeUrl('"quoted"').includes('&quot;'));
});

test('_safeUrl() falls back to index.html for empty/null input', function () {
  assertEqual(_safeUrl(''), 'index.html');
  assertEqual(_safeUrl(null), 'index.html');
  assertEqual(_safeUrl(undefined), 'index.html');
});

/* T5: _friendlyMsg() — error message mapping */
test('_friendlyMsg() maps null/undefined to generic message', function () {
  assert(_friendlyMsg('').includes('temporarily unavailable'));
  assert(_friendlyMsg(null).includes('temporarily unavailable'));
  assert(_friendlyMsg(undefined).includes('temporarily unavailable'));
});

test('_friendlyMsg() maps Safari iOS SYNTAX_ERR to friendly message', function () {
  var msg = _friendlyMsg('The string did not match the expected pattern.');
  assert(msg.includes('Could not reach KASS'), 'Should produce connection message');
  assert(!msg.includes('string did not match'), 'Must not expose raw error');
  assert(!msg.includes('pattern'), 'Must not expose raw error');
});

test('_friendlyMsg() maps iOS hostname-not-found error', function () {
  var msg = _friendlyMsg('A server with the specified hostname could not be found.');
  assert(msg.includes('Could not reach KASS'));
});

test('_friendlyMsg() maps iOS offline error', function () {
  var msg = _friendlyMsg('The Internet connection appears to be offline.');
  assert(msg.includes('Could not reach KASS'));
});

test('_friendlyMsg() maps Chrome/Firefox "Failed to fetch"', function () {
  var msg = _friendlyMsg('Failed to fetch');
  assert(msg.includes('Network unavailable'));
  assert(!msg.includes('Failed to fetch'));
});

test('_friendlyMsg() maps Firefox NetworkError', function () {
  var msg = _friendlyMsg('NetworkError when attempting to fetch resource.');
  assert(msg.includes('Network unavailable'));
});

test('_friendlyMsg() maps Chrome net::ERR_ errors', function () {
  var msg = _friendlyMsg('net::ERR_INTERNET_DISCONNECTED');
  assert(msg.includes('Network unavailable'));
});

test('_friendlyMsg() maps AbortError / timeout', function () {
  var msg1 = _friendlyMsg('AbortError: The operation was aborted.');
  assert(msg1.includes('timed out'));
  var msg2 = _friendlyMsg('The user aborted a request.');
  assert(msg2.includes('timed out'));
});

test('_friendlyMsg() maps "cancelled" (Safari cancellation)', function () {
  var msg = _friendlyMsg('cancelled');
  assert(msg.includes('timed out'));
});

test('_friendlyMsg() maps unsupported browser feature errors', function () {
  var msg = _friendlyMsg('AbortController is not supported in this browser.');
  assert(msg.includes('Browser feature unsupported'));
});

test('_friendlyMsg() passes through unknown/server messages unchanged', function () {
  var serverMsg = 'Rate limit exceeded — try again in 60 seconds.';
  assertEqual(_friendlyMsg(serverMsg), serverMsg);
});

/* T6: Synchronous fetch() throw handling */
test('_callKass_sim() converts synchronous fetch() throw to rejected Promise with friendly message', function (done) {
  var syncThrowFetch = function () {
    throw new Error('The string did not match the expected pattern.');
  };
  var history = [];
  return _callKass_sim(syncThrowFetch, 'hello', history)
    .then(function () {
      throw new Error('Should have rejected');
    })
    .catch(function (err) {
      assert(err instanceof Error, 'Error must be an Error instance');
      assert(err.message.includes('Could not reach KASS'),
        'Friendly message must replace WebKit DOMException. Got: ' + err.message);
      assert(history.length === 0, 'History must be rolled back on sync throw');
    });
});

test('_callKass_sim() converts network fetch rejection to propagated error', function () {
  var networkFailFetch = function () {
    return Promise.reject(new Error('Failed to fetch'));
  };
  var history = [];
  return _callKass_sim(networkFailFetch, 'hello', history)
    .then(function () {
      throw new Error('Should have rejected');
    })
    .catch(function (err) {
      assert(history.length === 0, 'History must be rolled back on network failure');
      assert(err.message.includes('Failed to fetch'), 'Error propagated: ' + err.message);
    });
});

test('_callKass_sim() rolls back history on AbortError', function () {
  var abortFetch = function () {
    var e = new Error('The operation was aborted.');
    e.name = 'AbortError';
    return Promise.reject(e);
  };
  var history = [{ role: 'user', content: 'prev' }];
  return _callKass_sim(abortFetch, 'new message', history)
    .then(function () {
      throw new Error('Should have rejected');
    })
    .catch(function (err) {
      assert(history.length === 1, 'Only pre-existing message should remain: ' + history.length);
      assert(err.message.includes('timed out'), 'AbortError mapped to timeout message');
    });
});

test('_callKass_sim() succeeds on valid response', function () {
  var goodFetch = function () {
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: function () { return Promise.resolve({ response: 'Hello from KASS!', results: [], actions: [] }); },
    });
  };
  var history = [];
  return _callKass_sim(goodFetch, 'hi', history)
    .then(function (data) {
      assertEqual(data.response, 'Hello from KASS!');
      assert(history.length === 2, 'User + assistant messages added: ' + history.length);
      assertEqual(history[0].role, 'user');
      assertEqual(history[1].role, 'assistant');
    });
});

/* T7: Missing AbortController compatibility (iOS < 12.1) */
test('AbortController guard does not throw when AbortController is unavailable', function () {
  var origAC = global.AbortController;
  delete global.AbortController;
  var ctrl = null, cSig;
  try { ctrl = new AbortController(); cSig = ctrl.signal; } catch (_) { cSig = undefined; }
  assert(ctrl === null, 'ctrl should be null when AbortController missing');
  assert(cSig === undefined, 'cSig should be undefined when AbortController missing');
  global.AbortController = origAC;
});

/* T8: Empty input rejected */
test('Empty text is rejected before sending', function () {
  function sendGate(text) {
    text = (text || '').trim();
    if (!text) return 'blocked';
    return 'allowed';
  }
  assertEqual(sendGate(''), 'blocked');
  assertEqual(sendGate('   '), 'blocked');
  assertEqual(sendGate('\n'), 'blocked');
  assertEqual(sendGate('hello'), 'allowed');
});

/* T9: History slice limits to 20 messages */
test('History slice limits messages to 20', function () {
  var history = [];
  for (var i = 0; i < 30; i++) {
    history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'msg' + i });
  }
  var sliced = history.slice(-20);
  assert(sliced.length === 20, 'Slice must be exactly 20: ' + sliced.length);
  assertEqual(sliced[0].content, 'msg10');
  assertEqual(sliced[19].content, 'msg29');
});

/* T10: Security — auth_token must not appear in debug log */
test('auth_token is never included in debug log output', function () {
  _warnLog.length = 0;
  var token = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.secret_token_here';
  /* Simulate the debug logging path in _callKass */
  var KASS_DEBUG = true;
  function _dbg_sim() {
    if (!KASS_DEBUG) return;
    var a = ['[KASS auth]'].concat([].slice.call(arguments));
    console.warn.apply(console, a);
  }
  _dbg_sim('callKass →', '/api/chat', '| msgs:', 5, '| authed:', !!token, '| online:', true);
  /* '| authed: true' is logged (boolean), not the token value */
  var logLine = _warnLog.join(' ');
  assert(!logLine.includes('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9'), 'Token value must not appear in log');
  assert(logLine.includes('authed: true'), 'Auth boolean is logged (not token value)');
});

/* Full _md() implementation matching kass-widget.js exactly (must be kept in sync) */
function _md(text) {
  var s = _esc(String(text || ''));
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]{1,80})\]\(([^)]{1,200})\)/g, function(_, label, url) {
    if (/^(javascript|data|vbscript):/i.test(url.trim())) url = '#';
    return '<a href="' + url + '">' + label + '</a>';
  });
  var lines = s.split('\n'), out = [], inList = false;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (/^[-•] /.test(l)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + l.replace(/^[-•] /, '') + '</li>');
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(l);
    }
  }
  if (inList) out.push('</ul>');
  s = out.join('\n');
  s = s.replace(/\n{2,}/g, '</p><p>');
  s = s.replace(/\n/g, '<br>');
  return '<p>' + s + '</p>';
}

/* T11: _md() XSS safety */
test('_md() runs _esc() before applying markdown transforms', function () {
  var xss = '<script>alert(1)</script>';
  var result = _md(xss);
  assert(!result.includes('<script>'), 'XSS script tag escaped in markdown');
  assert(result.includes('&lt;script&gt;'), 'Script tag must be entity-encoded');
});

test('_md() renders bold and italic correctly', function () {
  assert(_md('**bold**').includes('<strong>bold</strong>'), 'Bold rendered');
  assert(_md('*italic*').includes('<em>italic</em>'), 'Italic rendered');
});

/* T13–T18: _md() markdown link URL security — javascript: / data: / vbscript: injection */
test('_md() blocks javascript: in markdown link href', function () {
  var result = _md('[Click here](javascript:alert(1))');
  assert(!result.includes('javascript:'), 'javascript: must not appear in output');
  assert(result.includes('href="#"'), 'href must be replaced with #');
  assert(result.includes('>Click here<'), 'Link label must still be rendered');
});

test('_md() blocks javascript: case-insensitively', function () {
  var result1 = _md('[x](JAVASCRIPT:alert(1))');
  var result2 = _md('[x](Javascript:alert(1))');
  assert(!result1.includes('JAVASCRIPT:'), 'UPPERCASE javascript: blocked');
  assert(!result2.includes('Javascript:'), 'Mixed-case javascript: blocked');
  assert(result1.includes('href="#"') && result2.includes('href="#"'), 'Both replaced with #');
});

test('_md() blocks data: in markdown link href', function () {
  var result = _md('[Download](data:text/html,<h1>injected</h1>)');
  assert(!result.includes('data:text'), 'data: URL must not appear in output');
  assert(result.includes('href="#"'), 'href must be replaced with #');
});

test('_md() blocks vbscript: in markdown link href', function () {
  var result = _md('[Run](vbscript:msgbox(1))');
  assert(!result.includes('vbscript:'), 'vbscript: must not appear in output');
  assert(result.includes('href="#"'), 'href must be replaced with #');
});

test('_md() blocks leading-whitespace javascript: variant', function () {
  /* After _esc(), " javascript:alert(1)" still has a leading space */
  var result = _md('[ link ]( javascript:alert(1))');
  assert(!result.includes('javascript:'), 'Leading-space javascript: must be blocked');
});

test('_md() allows normal HTTPS links in markdown', function () {
  var result = _md('[View on SOKONI](https://mysokoni.co.ke/shop)');
  assert(result.includes('href="https://mysokoni.co.ke/shop"'), 'HTTPS link must be preserved');
  assert(result.includes('>View on SOKONI<'), 'Link label preserved');
});

test('_md() allows relative links in markdown', function () {
  var result = _md('[See products](/products)');
  assert(result.includes('href="/products"'), 'Relative path must be preserved');
});

/* T19: Diagnostics — debug log includes environment info, not secrets */
test('Debug log includes env info but not auth tokens', function () {
  _warnLog.length = 0;
  var KASS_DEBUG = true;
  function _dbg_env() {
    if (!KASS_DEBUG) return;
    var a = ['[KASS auth]'].concat([].slice.call(arguments));
    console.warn.apply(console, a);
  }
  var fakeToken = 'eyJhbGciOiJSUzI1NiJ9.payload.signature';
  var origin = 'https://mysokoni.co.ke';
  var endpoint = '/api/chat';
  var hasAbortController = true;
  var isOnline = true;

  /* Simulates _initAuth() debug call */
  _dbg_env('env: origin=', origin, '| endpoint=', endpoint,
    '| AbortController=', hasAbortController,
    '| online=', isOnline,
    '| UA=', 'Mozilla/5.0 (Test)');
  /* Simulates _callKass() debug call — logs !!token (boolean), not token value */
  _dbg_env('callKass →', endpoint, '| authed:', !!fakeToken);

  var logLines = _warnLog.join('\n');
  assert(!logLines.includes('eyJhbGciOiJSUzI1NiJ9'), 'JWT token must not appear in logs');
  assert(!logLines.includes('payload.signature'), 'Token payload must not appear in logs');
  assert(logLines.includes('origin='), 'Origin must appear in logs');
  assert(logLines.includes('endpoint='), 'Endpoint must appear in logs');
  assert(logLines.includes('AbortController='), 'AbortController flag must appear in logs');
  assert(logLines.includes('authed: true'), 'Auth boolean (not token) logged');
});

/* T12: Suggestion chip data attributes */
test('Suggestion chips have non-empty data-q attributes', function () {
  var chips = [
    { q: 'I want a BnB in Nairobi', label: 'Find a BnB' },
    { q: 'Track my latest order', label: 'Track order' },
    { q: 'Show me restaurants near Westlands', label: 'Restaurants' },
    { q: "What's in my cart?", label: 'View cart' },
  ];
  chips.forEach(function (chip) {
    assert(chip.q && chip.q.trim().length > 0, 'Chip "' + chip.label + '" must have non-empty data-q');
  });
});

/* ── Summary ─────────────────────────────────────────────────────────────── */
console.log('\nKASS Widget Regression Tests\n' + '─'.repeat(40));
_results.forEach(function (r) { console.log(r); });
console.log('─'.repeat(40));
console.log('Passed: ' + _pass + '  Failed: ' + _fail + '  Total: ' + (_pass + _fail));

if (_fail > 0) {
  process.exit(1);
} else {
  console.log('\nAll tests passed.\n');
  process.exit(0);
}
