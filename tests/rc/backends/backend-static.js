/* ============================================================================
   STATIC BACKEND — no auth, no admin, no emulator.

   Serves the repo over HTTP so the UNAUTHENTICATED portions of the RC journeys
   run TODAY: PWA install/offline, search-fallback UI, buyer cart & checkout
   math. Anything needing a signed-in user or Firestore writes throws
   BlockedError, so those steps report BLOCKED (never a false PASS).

   This is the backend the first partial RC run uses while JDK 21 (emulator) or
   fresh ADC (production) is being sorted.
   ========================================================================== */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { BackendInterface, BlockedError } = require('./backend-interface');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.map': 'application/json',
};

class StaticBackend extends BackendInterface {
  constructor(opts = {}) {
    super(opts);
    this.name = 'static(ui-only)';
    this.port = opts.port || 8790;
  }

  async init() {
    this.server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('404'); }
        res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', resolve);
    });
  }

  supports() { return { auth: false, firestore: false, functions: false, ui: true }; }
  baseUrl()  { return `http://127.0.0.1:${this.port}`; }

  async ensureUser()   { throw new BlockedError('static backend has no auth — run against emulator or production'); }
  async verifyClaims() { throw new BlockedError('static backend has no auth to read claims from'); }
  async authContext()  { throw new BlockedError('static backend cannot sign a user in'); }
  async setDoc()       { throw new BlockedError('static backend cannot write Firestore'); }
  async getDoc()       { throw new BlockedError('static backend cannot read Firestore'); }
  async deleteDoc()    { throw new BlockedError('static backend cannot write Firestore'); }
  async queryCol()     { throw new BlockedError('static backend cannot read Firestore'); }
  async callFunction() { throw new BlockedError('static backend cannot call functions'); }

  async cleanup() { if (this.server) await new Promise(r => this.server.close(r)); }
}

module.exports = StaticBackend;
