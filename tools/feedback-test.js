#!/usr/bin/env node
// Proves the feedback setup works, without deploying anything or opening the game.
//
//   node tools/feedback-test.js            what is configured, and why
//   node tools/feedback-test.js --send     actually send a test report through it
//
// The check reads the same environment variables the server does, so running it
// where the server runs answers the only question worth asking: if someone
// reported a bug right now, would it reach me?
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Feedback } from './feedback.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SEND = process.argv.includes('--send');

const feedback = new Feedback({
  root: ROOT,
  // Sink failures are logged rather than thrown, and the log line is where the
  // provider's own explanation lives — an unverified domain, a rejected key.
  // For a diagnostic tool that detail is the entire product.
  log: (line) => console.log(`  ${line}`),
});

console.log('\n  Feedback configuration\n  ----------------------');
for (const line of feedback.describe()) console.log(`  ${line}`);

if (!SEND) {
  console.log(feedback.forwards
    ? '\n  Run again with --send to put a test report through it.\n'
    : '\n  Set FEEDBACK_WEBHOOK_URL or the two email variables first — see FEEDBACK.md.\n');
  process.exit(0);
}

console.log('\n  Sending a test report…\n');
try {
  const { id, delivered } = await feedback.sendTest();
  const forwarded = delivered.filter((d) => d !== 'log');
  console.log(`\n  Report ${id} was accepted by: ${delivered.join(', ')}`);

  if (!feedback.forwards) {
    console.log('  Nothing is configured to forward it, so it only went to the log.');
  } else if (forwarded.length) {
    console.log(`  Go and look — it should be in your ${forwarded.join(' and ')} now.`);
  } else {
    // The log always succeeds, so "only the log" with a sink configured means
    // that sink refused it. The reason was printed above by the logger.
    console.log('  Everything you configured REFUSED it. The reason is printed above.');
    process.exitCode = 1;
  }
  console.log('');
} catch (err) {
  console.error(`\n  The test could not be sent: ${err.message}\n`);
  process.exitCode = 1;
}
