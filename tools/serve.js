#!/usr/bin/env node
// Zero-dependency static server, with the co-op relay riding on the same port.
// The game is plain ES modules — no build step, and one command to play.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { Relay } from './relay.js';
import { Feedback } from './feedback.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * `--port 8090` reads the same in cmd, PowerShell and bash, which the PORT
 * environment variable emphatically does not. The variable still works for
 * anyone who was already using it.
 */
const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1] ?? '');
}
const PORT = Number(arg('port') ?? process.env.PORT) || 8080;
const OPEN = argv.includes('--open');
const PORT_TRIES = 10;

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

/**
 * Bug reports and ideas from the game's Feedback panel.
 *
 * Built before the server so its configuration can be printed at startup —
 * "where do the reports go" is the one thing about it worth knowing, and it is
 * read entirely from the environment, which is not somewhere you can look.
 */
const feedback = new Feedback({
  root: ROOT,
  log: (line) => console.log(`  [feedback] ${line}`),
});

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let path = decodeURIComponent(url.pathname);

    if (await feedback.handle(req, res, url)) return;

    // The page cannot discover the machine's LAN address on its own, and that
    // address is exactly what a host needs to read out to their friends.
    if (path === '/coop-info') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      // The bound port, not the requested one: they differ after a fallback.
      res.end(JSON.stringify({ port: server.address()?.port ?? PORT, addresses: lanAddresses() }));
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

function announce(port) {
  const lines = [
    '',
    '  Chance of Precipitation — Descent Protocol',
    `  → http://localhost:${port}`,
  ];
  for (const ip of lanAddresses()) lines.push(`  → http://${ip}:${port}   (share this one for co-op)`);
  lines.push('', '  Co-op relay listening on the same port at /net.');
  lines.push('  Playing with people outside your network? See MULTIPLAYER.md.');
  lines.push('', `  Feedback: reports are kept in ${feedback.file}`);
  if (feedback.webhook) lines.push('            and forwarded to your webhook.');
  if (feedback.emailTo && feedback.resendKey) lines.push(`            and emailed to ${feedback.emailTo}.`);
  if (!feedback.forwards) lines.push('            Set FEEDBACK_WEBHOOK_URL to have them sent to you — see FEEDBACK.md.');
  lines.push(feedback.adminToken
    ? `            Read them at http://localhost:${port}/feedback?token=…`
    : '            Set FEEDBACK_ADMIN_TOKEN to read them at /feedback in a browser.');
  lines.push('');
  console.log(lines.join('\n'));
}

/**
 * Best effort only. A machine locked down enough to refuse this is exactly the
 * machine that needed a printed URL anyway, so a failure here is not an error.
 */
function openBrowser(url) {
  const win = process.platform === 'win32';
  const cmd = win ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = win ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* the URL above still works */ });
    child.unref();
  } catch { /* the URL above still works */ }
}

/**
 * A busy port should move us along, not stop the game from starting.
 *
 * The success path reads the port back off the socket rather than trusting the
 * one we asked for, so a retry cannot announce an address we never bound.
 */
function listen(port, triesLeft) {
  const onError = (err) => {
    server.off('listening', onListening);
    if (err.code === 'EADDRINUSE' && triesLeft > 0) {
      console.log(`  Port ${port} is busy — trying ${port + 1}…`);
      listen(port + 1, triesLeft - 1);
      return;
    }
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Every port from ${PORT} to ${port} is busy. Pick another:\n`
        + '    node tools/serve.js --port 9000\n');
    } else {
      console.error(`\n  The server could not start: ${err.message}\n`);
    }
    process.exit(1);
  };

  const onListening = () => {
    server.off('error', onError);
    const bound = server.address().port;
    announce(bound);
    if (OPEN) openBrowser(`http://localhost:${bound}`);
  };

  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, '0.0.0.0');
}

listen(PORT, PORT_TRIES);
