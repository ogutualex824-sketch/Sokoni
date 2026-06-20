const http = require('http');
const fs   = require('fs');
const path = require('path');

const MIME = {
  '.html':'text/html; charset=utf-8',
  '.css':'text/css',
  '.js':'application/javascript',
  '.json':'application/json',
  '.png':'image/png',
  '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg',
  '.gif':'image/gif',
  '.svg':'image/svg+xml',
  '.ico':'image/x-icon',
  '.webp':'image/webp',
  '.woff2':'font/woff2',
  '.woff':'font/woff',
  '.ttf':'font/ttf',
  '.mp4':'video/mp4',
  '.pdf':'application/pdf',
};

const ROOT = __dirname;

http.createServer((req, res) => {
  let pathname = req.url.split('?')[0].split('#')[0];
  if (pathname === '/') pathname = '/index.html';

  let file = path.join(ROOT, pathname);
  let ext  = path.extname(file).toLowerCase();

  /* clean-URL fallback: /offer → /offer.html */
  if (!ext && !fs.existsSync(file)) {
    file = file + '.html';
    ext  = '.html';
  }

  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch(e) {
    res.writeHead(404, {'Content-Type':'text/html; charset=utf-8'});
    res.end('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#080808;color:white;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;} .box{text-align:center;} h2{color:#71ff00;font-size:2rem;} p{color:rgba(255,255,255,0.45);margin-top:8px;} a{color:#71ff00;text-decoration:none;}</style></head><body><div class="box"><h2>404</h2><p>Page not found: ' + pathname + '</p><p style="margin-top:20px"><a href="/">← Back to SOKONI</a></p></div></body></html>');
  }
}).listen(3000, '127.0.0.1', () => {
  console.log('SOKONI server running at http://127.0.0.1:3000');
});
