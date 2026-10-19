// Minimal static file server (no dependencies). Serves the frontend on the local network.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8080;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};
// Chart.js is served from node_modules so the app works offline (no CDN).
const ALIASES = { '/vendor/chart.umd.js': path.join(ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.js') };
const PUBLIC_DIRS = ['css', 'js'];

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  let file = ALIASES[urlPath];
  if (!file) {
    const top = urlPath.split('/')[1];
    if (urlPath !== '/index.html' && urlPath !== '/favicon.svg' && !PUBLIC_DIRS.includes(top)) {
      res.writeHead(404).end('Not found');
      return;
    }
    file = path.join(ROOT, urlPath);
    if (!file.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Try: set PORT=8090 && npm start` : e);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\nSmart Sports Equipment Performance Monitor');
  console.log(`  This computer : http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  Phone / LAN   : http://${i.address}:${PORT}`);
  }
  console.log('\nPress Ctrl+C to stop.\n');
});
