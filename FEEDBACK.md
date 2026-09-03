# Reading the bug reports and ideas people send you

The game has a **Feedback** panel — main menu, and a *Report a Bug* button on the pause
screen. It posts to `POST /feedback` on the same server that served the page, so there is no
form service to sign up for and nothing to configure before it works.

Out of the box, every report is written to `data/feedback.jsonl` next to the game and kept in
memory. That is enough to never lose one while the server is up, and not enough to be useful —
you would have to go and look. The point of this document is the two lines of configuration
that make reports come to you instead.

Everything here is set with **environment variables**, because on a host like Render there is
no config file to edit and no shell to edit it from.

---

## How to add an environment variable on Render

Every setting below is one of these, so this is the mechanic for all of them:

1. **Render Dashboard → your service → `Environment`** in the left pane.
2. Under *Environment Variables*, click **+ Add Environment Variable**.
3. Fill in **Key** (e.g. `FEEDBACK_WEBHOOK_URL`) and **Value**. Add as many as you need.
4. Save — and **mind the dropdown**. It offers three things:
   - **Save, rebuild, and deploy** — full rebuild. Always correct, just slowest.
   - **Save and deploy** — redeploys the existing build with the new values. This is the one
     you want here; nothing about these variables needs a rebuild.
   - **Save only** — stores them and changes nothing that is running. Pick this by accident
     and your setting appears in the dashboard while the live service carries on without it,
     which is a genuinely confusing half-hour.

The values are secret — an API key, a webhook URL that anyone holding it can post to your
channel — so keep them here rather than in the repository. Nothing in this project reads a
`.env` file.

**Locally**, set the same variables on the command line for one run:

```bash
RESEND_API_KEY=re_xxx FEEDBACK_EMAIL_TO=you@example.com node tools/feedback-test.js --send
```

or `export` them first if you want them to stick for the whole terminal session. On Windows
`cmd`, that is `set RESEND_API_KEY=re_xxx` on its own line before the command.

---

## The fastest thing that works: a Discord webhook

Two minutes, free, and reports arrive as messages in a channel.

1. In Discord: **Server Settings → Integrations → Webhooks → New Webhook**. Point it at a
   channel, then **Copy Webhook URL**.
2. Add one variable, as above:

   | Key | Value |
   | --- | --- |
   | `FEEDBACK_WEBHOOK_URL` | the URL you just copied |

3. Save **and deploy**. From then on every report shows up in that channel as an embed —
   red for bugs, teal for ideas — with the context block attached.

The same variable takes a **Slack** incoming-webhook URL (posted as plain text), or the URL of
anything else that accepts a JSON `POST`, which receives the whole record as JSON.

> Discord mentions are disabled on the way out (`allowed_mentions` is emptied), so nobody can
> type `@everyone` into a bug report and ping your server with it.

---

## Email

Email needs a provider. This uses [Resend](https://resend.com), whose free tier is ample and
whose API is one HTTPS call, so it adds no dependency to the project.

### The five-minute version, no domain needed

1. Sign up at [resend.com](https://resend.com) **using the address you want the reports to
   arrive at**. This matters — see the note below.
2. **API Keys → Create API Key**. Sending permission is all it needs. Copy the key; Resend
   shows it once.
3. Set two variables on your service (Render: your service → **Environment**):

   | Key | Value |
   | --- | --- |
   | `RESEND_API_KEY` | the key you just copied, `re_…` |
   | `FEEDBACK_EMAIL_TO` | the address you signed up with |

4. Check it before trusting it — **from your own machine**, with the same two variables:

   ```bash
   RESEND_API_KEY=re_xxx FEEDBACK_EMAIL_TO=you@example.com node tools/feedback-test.js --send
   ```

   That prints what is configured, sends a real test report through it, and tells you which
   sinks accepted it — including the provider's own words when one refuses, so a mistyped key
   says so instead of going quiet. Resend does not care where the call came from, so a pass
   locally means the key and the address are right.

   Then confirm **Render** has them too: deploy, open the service's **Logs** tab, and read the
   `Feedback:` block the server prints on startup. It lists exactly what it will do. (Render's
   **Shell** tab would let you run the check on the server itself, but shell access is a paid
   feature — on the free tier, local check plus the startup log is the way.)

**Both variables or neither.** A key with no address, or an address with no key, means email is
off. That used to fail silently; the server now says so at startup and the check above says so
too.

### Why step 1 said to use the address you want reports at

With `FEEDBACK_EMAIL_FROM` unset, mail is sent from Resend's shared `onboarding@resend.dev`.
That needs no domain setup at all, but Resend **will only deliver it to the address on your own
Resend account**. For "just show me the reports" that is exactly right, and it is why signing
up with the destination address makes the whole thing two variables instead of a DNS chore.

### Sending anywhere else

To reach an address that is not your Resend account — a shared inbox, a co-maintainer — you
need a domain:

1. In Resend: **Domains → Add Domain**, then add the DNS records it gives you at your registrar
   (an MX and some TXT records). Verification usually takes minutes.
2. Set `FEEDBACK_EMAIL_FROM` to an address on that domain, e.g. `feedback@yourdomain.com`.
3. `FEEDBACK_EMAIL_TO` can then be anything, including several addresses separated by commas.

Run the check again afterwards. An unverified domain fails with a message saying so, which the
check prints verbatim.

Email and the webhook are independent — set both and reports go to both.

---

## Reading them on the server itself

Set one more variable and the server will show you everything it has:

| Key | Value |
| --- | --- |
| `FEEDBACK_ADMIN_TOKEN` | a long random string you invent |

Then open `https://your-app.onrender.com/feedback?token=YOUR_TOKEN` — a page of every report,
newest first, with the context blocks collapsed. Add `&format=json` for the raw records, or
send the token as `Authorization: Bearer YOUR_TOKEN` instead of putting it in the URL.

**Without that variable the route does not exist**, and answers 404 to everyone. That is
deliberate: the alternative is a public page listing everything anyone ever reported.

---

## A warning about Render's disk

On Render's free tier the filesystem is **ephemeral**. `data/feedback.jsonl` survives a restart
of the process but not a redeploy, and it is not backed up. The admin page above will show you
what is still there, and no more than that.

So: if the reports matter to you, set a webhook or email. Those are the copies that leave the
machine. The log is a convenience, not storage.

(Attaching a Render persistent disk and pointing `FEEDBACK_FILE` at a path on it also works,
and is the only way to keep the log across deploys.)

---

## Every variable

| Variable | Default | What it does |
| --- | --- | --- |
| `FEEDBACK_WEBHOOK_URL` | *unset* | Discord, Slack, or any JSON `POST` endpoint |
| `FEEDBACK_EMAIL_TO` | *unset* | inbox(es) to forward to; needs `RESEND_API_KEY` |
| `FEEDBACK_EMAIL_FROM` | `onboarding@resend.dev` | sender address for that mail |
| `RESEND_API_KEY` | *unset* | Resend credential; without it, email is off |
| `FEEDBACK_ADMIN_TOKEN` | *unset* | unlocks `GET /feedback`; unset means the route 404s |
| `FEEDBACK_FILE` | `data/feedback.jsonl` | where the log is written |

The server prints which of these are live when it starts, so `node tools/serve.js` locally
tells you what a deploy would do before you deploy it. `node tools/feedback-test.js` prints the
same summary without starting a server, and `--send` puts a real report through it.

---

## What is actually in a report

```json
{
  "id": "6c2b6a75",
  "at": "2026-09-02T23:20:26.818Z",
  "type": "bug",
  "title": "Boss bar sticks around",
  "body": "Killed the stage 3 guardian and the bar stayed on screen into the next stage.",
  "contact": "charles",
  "diagnostics": { "version": "1.0.0", "stage": 3, "runTime": "12:04", "difficulty": 4.2 },
  "from": "17c4f81f5f"
}
```

`diagnostics` is the context block the player can see in full in the panel and switch off
before sending — version, stage, run time, difficulty, mode, character, item count, whether
they were in co-op, their screen size and browser. It is whitelisted key by key on the way in,
so the field cannot be used to post arbitrary JSON into your inbox.

`from` is a salted hash of the sender's address, and the salt is regenerated every time the
server starts. It exists so you can tell that thirty reports came from one person; it cannot
be turned back into an address, and no address is ever stored.

---

## Limits

- 16 KB per request, refused from the `Content-Length` header before it is read.
- Five reports per sender, refilling one every two minutes.
- Sixty per minute across everyone, so one bad afternoon cannot fill your channel.
- Title 120 characters, body 4000, contact 120. Control characters are stripped, and newlines
  survive in the body only — a title cannot smuggle line breaks into an email subject.

A report that is refused says why, in the panel, in plain words. If the endpoint is not there
at all — someone serving the files with a plain static server — the panel says that too and
offers to copy the report to the clipboard instead of silently eating it.
