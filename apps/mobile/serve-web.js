/**
 * Static web server for the Expo web build.
 * Adds COOP/COEP headers to every response so SharedArrayBuffer
 * (required by expo-sqlite WASM / wa-sqlite) works in any browser.
 *
 * Usage:
 *   1. Build:  npx expo export --platform web     (from apps/mobile/)
 *   2. Serve:  node serve-web.js
 *   3. Open:   http://localhost:8083?device=A  and  ?device=B
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'dist');
const PORT = 8083;

const MIME = {
  '.html' : 'text/html; charset=utf-8',
  '.js'   : 'application/javascript; charset=utf-8',
  '.mjs'  : 'application/javascript; charset=utf-8',
  '.css'  : 'text/css; charset=utf-8',
  '.wasm' : 'application/wasm',
  '.json' : 'application/json; charset=utf-8',
  '.png'  : 'image/png',
  '.jpg'  : 'image/jpeg',
  '.ico'  : 'image/x-icon',
  '.svg'  : 'image/svg+xml',
  '.ttf'  : 'font/ttf',
  '.woff' : 'font/woff',
  '.woff2': 'font/woff2',
  '.map'  : 'application/json',
};

if (!fs.existsSync(DIST)) {
  console.error('ERROR: dist/ folder not found.');
  console.error('Run first:  cd apps/mobile && npx expo export --platform web');
  process.exit(1);
}

http.createServer((req, res) => {
  // These two headers are the only thing that makes SharedArrayBuffer available
  res.setHeader('Cross-Origin-Opener-Policy',   'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  let urlPath = req.url.split('?')[0].split('#')[0];
  if (urlPath === '/') urlPath = '/index.html';

  let filePath = path.resolve(DIST, '.' + urlPath);

  // Prevent directory traversal
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  // SPA fallback: unknown routes → index.html
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (err) {
    res.writeHead(500); res.end('Server error: ' + err.message);
  }

}).listen(PORT, () => {
  console.log('');
  console.log('✓  AlcoviaSync web build running at:');
  console.log(`   Device A → http://localhost:${PORT}?device=A`);
  console.log(`   Device B → http://localhost:${PORT}?device=B`);
  console.log(`   Device C → http://localhost:${PORT}?device=C`);
  console.log('');
  console.log('   COOP/COEP headers enabled → SharedArrayBuffer available');
  console.log('');
});
