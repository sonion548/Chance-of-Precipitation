// Bug reports and ideas, from the game's Feedback panel to wherever the person
// hosting the game actually looks. Zero dependencies, like everything else here.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

/** Nothing larger than this is read off the wire, let alone parsed. */
const MAX_BODY = 16 * 1024;
const LIMITS = { title: 120, body: 4000, contact: 120 };
/** Per-address budget: five reports, refilling one every two minutes. */
const RATE = { burst: 5, refillMs: 2 * 60 * 1000 };
/** Across everyone, so one bad afternoon cannot fill a disk or a Discord channel. */
const GLOBAL = { burst: 60, refillMs: 60 * 1000 };
/** Reports held in memory for the admin view, newest last. */
const RING = 300;
/** Outbound sinks get this long before they are called failed. */
const SINK_TIMEOUT = 8000;

const TYPES = { bug: 'Bug report', idea: 'Idea' };

/**
 * Where a report can end up.
 *
 * Every one of these is optional and configured by environment variable, which
 * is the only shape that works on a host like Render where there is no config
 * file to edit and no shell to edit it from. With none of them set the endpoint
 * still accepts reports and still keeps them — see `_store` — so the panel in
 * the game is never a button that silently does nothing.
 *
 *   FEEDBACK_WEBHOOK_URL   Discord, Slack, or anything that takes a JSON POST
 *   FEEDBACK_EMAIL_TO      inbox to forward to, via Resend
 *   FEEDBACK_EMAIL_FROM    sender for that mail (needs a domain you verified)
 *   RESEND_API_KEY         Resend credential; without it, email is off
 *   FEEDBACK_ADMIN_TOKEN   secret that unlocks GET /feedback
 *   FEEDBACK_FILE          where the JSONL log is written
 */
export class Feedback {
  constructor({ root = process.cwd(), env = process.env, log = () => {} } = {}) {
    this.log = log;
    this.file = env.FEEDBACK_FILE
      ? resolve(root, env.FEEDBACK_FILE)
      : resolve(root, 'data', 'feedback.jsonl');
    this.webhook = (env.FEEDBACK_WEBHOOK_URL || '').trim();
    this.emailTo = (env.FEEDBACK_EMAIL_TO || '').trim();
    // Resend's shared sender works with no domain set up at all, but it will
    // only deliver to the address on the Resend account itself. That is exactly
    // the "just show me the ideas" case, so it is the default.
    this.emailFrom = (env.FEEDBACK_EMAIL_FROM || 'onboarding@resend.dev').trim();
    this.resendKey = (env.RESEND_API_KEY || '').trim();
    this.adminToken = (env.FEEDBACK_ADMIN_TOKEN || '').trim();
    // Salts the address hash kept on each record. Regenerated per process on
    // purpose: it is only ever used to tell two reports apart, never to work
    // back to who sent them.
    this.ipSalt = randomUUID();

    this.recent = [];
    this.buckets = new Map();
    this.global = { tokens: GLOBAL.burst, at: Date.now() };
    this._warnedFile = false;
  }

  /** True if any configured sink forwards a report off this machine. */
  get forwards() { return !!(this.webhook || (this.emailTo && this.resendKey)); }

  /**
   * Handles the feedback routes. Returns false for anything else so the static
   * server can carry on as if this were not here.
   */
  async handle(req, res, url) {
    if (url.pathname !== '/feedback') return false;
    if (req.method === 'POST') { await this._submit(req, res); return true; }
    if (req.method === 'GET') { await this._admin(req, res, url); return true; }
    json(res, 405, { ok: false, error: 'Method not allowed' });
    return true;
  }

  // ------------------------------------------------------------------ intake
  async _submit(req, res) {
    // Answered from the header, before a byte of it is read. The streaming
    // guard below still exists for a chunked upload that declares nothing, but
    // it has to tear the connection down to stop, and a torn connection cannot
    // carry an explanation back.
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) {
      json(res, 413, { ok: false, error: 'That report is too long to send. Trim it and try again.' }, true);
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      const tooLarge = err.message === 'too-large';
      json(res, tooLarge ? 413 : 400, {
        ok: false,
        error: tooLarge ? 'That report is too long to send. Trim it and try again.' : 'Malformed report.',
      }, tooLarge);
      return;
    }

    const who = clientAddress(req);
    if (!this._spend(who)) {
      json(res, 429, { ok: false, error: 'That is a lot of reports at once. Give it a few minutes and send the rest.' });
      return;
    }

    const record = this._validate(payload, who);
    if (record.error) { json(res, 400, { ok: false, error: record.error }); return; }

    const delivered = await this._deliver(record.value);
    if (!delivered.length) {
      json(res, 500, { ok: false, error: 'The report could not be recorded. Nothing was saved — try again shortly.' });
      return;
    }
    this.log(`${TYPES[record.value.type]}: ${record.value.title} → ${delivered.join(', ')}`);
    json(res, 200, { ok: true, id: record.value.id, delivered, forwarded: this.forwards });
  }

  /**
   * Everything that arrives here was typed by a stranger on the internet, so it
   * is length-capped, stripped of control characters, and never trusted to be
   * the shape it claims. What comes out is a record, or a message explaining
   * why there is not one.
   */
  _validate(payload, who) {
    if (!payload || typeof payload !== 'object') return { error: 'Malformed report.' };
    const type = payload.type === 'idea' ? 'idea' : payload.type === 'bug' ? 'bug' : null;
    if (!type) return { error: 'Pick whether this is a bug or an idea.' };

    const title = clean(payload.title, LIMITS.title);
    const body = clean(payload.body, LIMITS.body, true);
    if (title.length < 3) return { error: 'Give it a one-line summary first.' };
    if (body.length < 10) return { error: 'Say a little more — ten characters is not a bug report.' };

    return {
      value: {
        id: randomUUID().slice(0, 8),
        at: new Date().toISOString(),
        type,
        title,
        body,
        contact: clean(payload.contact, LIMITS.contact),
        diagnostics: cleanDiagnostics(payload.diagnostics),
        // Enough to notice that thirty reports came from one place, and not
        // enough to say where that place is.
        from: createHash('sha256').update(this.ipSalt + who).digest('hex').slice(0, 10),
      },
    };
  }

  /** Puts the record everywhere it can go. Returns the sinks that took it. */
  async _deliver(record) {
    const done = [];
    if (await this._store(record)) done.push('log');
    if (this.webhook && await this._post(record)) done.push('webhook');
    if (this.emailTo && this.resendKey && await this._email(record)) done.push('email');
    return done;
  }

  /**
   * The sink that is always there.
   *
   * The in-memory ring is what makes the admin view work on a host with no
   * persistent disk, and the file is what makes it survive a restart on a host
   * that has one. Neither is a backup of the other, and a report that reaches
   * only these two is still a report that was received — which is why a failed
   * webhook does not fail the request.
   */
  async _store(record) {
    this.recent.push(record);
    if (this.recent.length > RING) this.recent.splice(0, this.recent.length - RING);
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (err) {
      // A read-only filesystem is a legitimate way to run this. Say so once,
      // then stop mentioning it — the ring above still holds the report.
      if (!this._warnedFile) {
        this._warnedFile = true;
        this.log(`feedback log unavailable (${err.code || err.message}); keeping reports in memory only`);
      }
    }
    return true;
  }

  async _post(record) {
    const url = this.webhook;
    let payload;
    if (/(^|\.)discord(app)?\.com$/.test(hostOf(url))) payload = discordPayload(record);
    else if (/(^|\.)slack\.com$/.test(hostOf(url))) payload = { text: plainText(record) };
    else payload = record;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SINK_TIMEOUT),
      });
      if (res.ok) return true;
      this.log(`webhook refused the report: ${res.status}`);
    } catch (err) {
      this.log(`webhook unreachable: ${err.message}`);
    }
    return false;
  }

  async _email(record) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.resendKey}` },
        body: JSON.stringify({
          from: this.emailFrom,
          to: this.emailTo.split(',').map((s) => s.trim()).filter(Boolean),
          subject: `[${TYPES[record.type]}] ${record.title}`.slice(0, 180),
          text: plainText(record),
        }),
        signal: AbortSignal.timeout(SINK_TIMEOUT),
      });
      if (res.ok) return true;
      this.log(`email refused the report: ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (err) {
      this.log(`email unreachable: ${err.message}`);
    }
    return false;
  }

  // ------------------------------------------------------------------ reading
  /**
   * The host's own view of what has come in.
   *
   * Gated on a token that has to be set deliberately: with no token configured
   * this route does not exist, because the alternative is a public page listing
   * everything anyone ever reported.
   */
  async _admin(req, res, url) {
    const given = url.searchParams.get('token') || bearer(req);
    if (!this.adminToken || !secretsMatch(this.adminToken, given)) {
      json(res, 404, { ok: false, error: 'Not found' });
      return;
    }
    const rows = await this._read();
    if (url.searchParams.get('format') === 'json') {
      json(res, 200, { ok: true, count: rows.length, reports: rows });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(adminPage(rows, this));
  }

  /**
   * Everything on record, newest first.
   *
   * The file is the source of truth when there is one, because it outlives the
   * process. Anything in memory that is not in it — the case where the disk
   * refused the write — is merged in rather than lost.
   */
  async _read() {
    const seen = new Set();
    const rows = [];
    try {
      const text = await readFile(this.file, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row?.id && !seen.has(row.id)) { seen.add(row.id); rows.push(row); }
        } catch { /* a torn last line is not a reason to serve nothing */ }
      }
    } catch { /* no file yet, or nowhere to put one */ }
    for (const row of this.recent) if (!seen.has(row.id)) { seen.add(row.id); rows.push(row); }
    return rows.reverse();
  }

  // ------------------------------------------------------------------ limits
  /**
   * Token buckets, per address and overall.
   *
   * Both are spent before the body is validated, so a flood of malformed
   * requests costs the same as a flood of well-formed ones.
   */
  _spend(who) {
    const now = Date.now();
    this.global.tokens = Math.min(GLOBAL.burst, this.global.tokens + (now - this.global.at) / GLOBAL.refillMs);
    this.global.at = now;
    if (this.global.tokens < 1) return false;

    let bucket = this.buckets.get(who);
    if (!bucket) {
      // Stale buckets are dropped when the map gets big rather than on a timer:
      // a full bucket is indistinguishable from no bucket at all.
      if (this.buckets.size > 5000) {
        for (const [key, b] of this.buckets) if (b.tokens >= RATE.burst) this.buckets.delete(key);
      }
      bucket = { tokens: RATE.burst, at: now };
      this.buckets.set(who, bucket);
    }
    bucket.tokens = Math.min(RATE.burst, bucket.tokens + (now - bucket.at) / RATE.refillMs);
    bucket.at = now;
    if (bucket.tokens < 1) return false;

    bucket.tokens -= 1;
    this.global.tokens -= 1;
    return true;
  }
}

/* ============================================================ helpers */

/**
 * A JSON reply. `close` hangs up afterwards, which is what a request whose body
 * was never read has to do — the unread remainder would otherwise be parsed as
 * the start of the next request on that connection.
 */
function json(res, status, body, close = false) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (close) headers.Connection = 'close';
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

/** Reads the request body, refusing anything oversized as it arrives. */
function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { fail(new Error('too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

/**
 * The address to rate-limit against.
 *
 * Behind Render (or any proxy) the socket address is the proxy's, so the first
 * entry of `x-forwarded-for` is the caller. It is spoofable by anyone talking
 * to the server directly, which is why it is used for rate limiting and for
 * nothing else.
 */
function clientAddress(req) {
  const fwd = req.headers['x-forwarded-for'];
  const first = typeof fwd === 'string' ? fwd.split(',')[0].trim() : '';
  return first || req.socket.remoteAddress || 'unknown';
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/** Constant-time compare that does not leak the secret's length either. */
function secretsMatch(expected, given) {
  if (!given) return false;
  const a = createHash('sha256').update(String(expected)).digest();
  const b = createHash('sha256').update(String(given)).digest();
  return timingSafeEqual(a, b);
}

/**
 * Trimmed, length-capped, and stripped of control characters.
 *
 * Newlines survive in the body and nowhere else: a report is a paragraph, but a
 * title that smuggles line breaks into an email subject or a Discord embed is
 * how one person's bug report rearranges someone else's inbox.
 */
function clean(value, max, multiline = false) {
  if (typeof value !== 'string') return '';
  const stripped = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return (multiline ? stripped : stripped.replace(/[\r\n\t]+/g, ' ')).trim().slice(0, max);
}

/**
 * The context block the game offers to attach.
 *
 * Whitelisted key by key rather than passed through: the client is not trusted
 * to decide what ends up in the host's inbox, and a report is not a channel for
 * shipping arbitrary JSON to it.
 */
function cleanDiagnostics(diag) {
  if (!diag || typeof diag !== 'object') return null;
  const out = {};
  const keys = ['version', 'stage', 'stageName', 'runTime', 'difficulty', 'mode',
    'character', 'items', 'coop', 'screen', 'platform', 'language', 'page'];
  for (const k of keys) {
    const v = diag[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') { const s = clean(v, 300); if (s) out[k] = s; }
  }
  return Object.keys(out).length ? out : null;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** The report as it reads in an inbox or a Slack channel. */
function plainText(record) {
  const lines = [
    `${TYPES[record.type]}: ${record.title}`,
    '',
    record.body,
    '',
    `Sent ${record.at}`,
  ];
  if (record.contact) lines.push(`From ${record.contact}`);
  if (record.diagnostics) {
    lines.push('', 'Context:');
    for (const [k, v] of Object.entries(record.diagnostics)) lines.push(`  ${k}: ${v}`);
  }
  lines.push(`Report ${record.id}`);
  return lines.join('\n');
}

/**
 * Discord's shape.
 *
 * `allowed_mentions` is emptied deliberately: without it, anyone who can reach
 * the game can type `@everyone` into a bug report and have Discord ping a whole
 * server with it.
 */
function discordPayload(record) {
  const fields = [];
  if (record.contact) fields.push({ name: 'From', value: record.contact.slice(0, 1024) });
  if (record.diagnostics) {
    const text = Object.entries(record.diagnostics).map(([k, v]) => `${k}: ${v}`).join('\n');
    fields.push({ name: 'Context', value: text.slice(0, 1024) });
  }
  return {
    username: 'Descent Protocol',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `${record.type === 'bug' ? '🐞' : '💡'} ${record.title}`.slice(0, 256),
      description: record.body.slice(0, 3900),
      color: record.type === 'bug' ? 0xff4d5e : 0x46e0c0,
      timestamp: record.at,
      fields,
      footer: { text: `${TYPES[record.type]} · ${record.id}` },
    }],
  };
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The host's page. Everything on it was typed by someone else, so it is escaped. */
function adminPage(rows, feedback) {
  const sinks = [
    feedback.webhook ? 'webhook' : null,
    feedback.emailTo && feedback.resendKey ? `email → ${feedback.emailTo}` : null,
    `log → ${feedback.file}`,
  ].filter(Boolean).join(' · ');

  const cards = rows.map((r) => `
    <article class="r ${r.type === 'bug' ? 'bug' : 'idea'}">
      <header>
        <span class="tag">${r.type === 'bug' ? 'Bug' : 'Idea'}</span>
        <h2>${esc(r.title)}</h2>
        <time>${esc(r.at)}</time>
      </header>
      <p>${esc(r.body).replace(/\n/g, '<br>')}</p>
      ${r.contact ? `<p class="meta">From <b>${esc(r.contact)}</b></p>` : ''}
      ${r.diagnostics ? `<details><summary>Context</summary><pre>${esc(
    Object.entries(r.diagnostics).map(([k, v]) => `${k}: ${v}`).join('\n'))}</pre></details>` : ''}
      <p class="meta">${esc(r.id)} · sender ${esc(r.from || '—')}</p>
    </article>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Feedback — Descent Protocol</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 28px 20px 60px; background: #06070c; color: #dfe6f5;
         font: 15px/1.55 "Rajdhani", "Segoe UI", system-ui, sans-serif; }
  .wrap { max-width: 820px; margin: 0 auto; }
  h1 { font-size: 22px; letter-spacing: 5px; text-transform: uppercase; margin: 0 0 6px; }
  .lead { color: #7d89a3; font-size: 13px; margin: 0 0 26px; }
  .r { background: #0d1018; border: 1px solid #232b3d; border-left: 4px solid #46e0c0;
       border-radius: 8px; padding: 14px 18px; margin-bottom: 14px; }
  .r.bug { border-left-color: #ff4d5e; }
  .r header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .r h2 { font-size: 17px; letter-spacing: 1px; margin: 0; flex: 1; }
  .tag { font-size: 10px; letter-spacing: 2px; text-transform: uppercase; padding: 2px 8px;
         border: 1px solid #232b3d; border-radius: 10px; color: #7d89a3; }
  time { font-family: ui-monospace, monospace; font-size: 11px; color: #5a6478; }
  .r p { margin: 10px 0 0; }
  .meta { color: #5a6478; font-size: 12px; }
  details { margin-top: 8px; }
  summary { cursor: pointer; color: #7d89a3; font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; }
  pre { font-family: ui-monospace, monospace; font-size: 12px; color: #9fb0cc;
        background: #080a11; border: 1px solid #1a2030; border-radius: 6px; padding: 10px; overflow-x: auto; }
  .empty { color: #5a6478; padding: 40px 0; text-align: center; }
</style></head><body><div class="wrap">
<h1>Feedback</h1>
<p class="lead">${rows.length} report${rows.length === 1 ? '' : 's'}, newest first · ${esc(sinks)}<br />
Add <code>&amp;format=json</code> for the raw records.</p>
${cards || '<p class="empty">Nothing has come in yet.</p>'}
</div></body></html>`;
}
