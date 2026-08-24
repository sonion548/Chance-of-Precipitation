#!/usr/bin/env node
// Zero-dependency static server, with the co-op relay riding on the same port.
// The game is plain ES modules — no build step, and one command to play.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { Relay } from './relay.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;

/** Every non-internal IPv4 address, so the host can read one out to friends. */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let path = decodeURIComponent(url.pathname);

    // The page cannot discover the machine's LAN address on its own, and that
    // address is exactly what a host needs to read out to their friends.
    if (path === '/coop-info') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ port: PORT, addresses: lanAddresses() }));
      return;
    }
    if (path === '/') path = '/index.html';
    const filePath = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

    const info = await stat(filePath);
    if (info.isDirectory()) { res.writeHead(403).end('Forbidden'); return; }

    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

const relay = new Relay({ log: (line) => console.log(`  [co-op] ${line}`) });
relay.attach(server, '/net');

server.listen(PORT, '0.0.0.0', () => {
  const lines = [
    '',
    '  SONEYBUN — Descent Protocol',
    `  → http://localhost:${PORT}`,
  ];
  for (const ip of lanAddresses()) lines.push(`  → http://${ip}:${PORT}   (share this one for co-op)`);
  lines.push('', '  Co-op relay listening on the same port at /net.', '');
  console.log(lines.join('\n'));
});
