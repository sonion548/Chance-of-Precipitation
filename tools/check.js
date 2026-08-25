#!/usr/bin/env node
// Parses every source module so syntax errors surface without a browser, and
// checks the handful of patterns that are valid JavaScript and always a bug.
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'vendor') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (extname(p) === '.js') out.push(p);
  }
  return out;
}

/**
 * Patterns that parse fine and are never what anyone meant.
 *
 * `Object3D.add` returns the *parent*, not the child, so
 * `group.add(mesh).rotation.z = x` rotates the whole group. It is a one-line
 * idiom that reads exactly like the thing it is not, and it has now shipped
 * three separate times in this codebase: once it moved a character's head
 * inside its own torso, once it rolled every rifle-family weapon ninety
 * degrees onto its side, and once it displaced a chest lid. Each one took a
 * while to find because the code looks right.
 *
 * A parser cannot catch it and a type checker would not either. A grep can.
 */
const LINTS = [
  {
    // group.add(...).position / .rotation / .scale — on one line or two.
    re: /\.add\(([^;]*?)\)\s*\n?\s*\.(position|rotation|scale)\b/g,
    message: 'Object3D.add() returns the PARENT — this sets the transform on the '
      + 'container, not on the thing being added. Assign to a local first.',
  },
];

/** Replaces comment bodies with spaces, preserving length and line breaks. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

const files = await walk(ROOT);
let failed = 0;
let lintHits = 0;
for (const f of files) {
  const src = await readFile(f, 'utf8');
  const rel = f.replace(ROOT + '/', '').replace(ROOT + '\\', '');
  try {
    new vm.SourceTextModule(src, { identifier: f });
  } catch (err) {
    failed++;
    console.error(`✗ ${rel}\n  ${err.message}`);
    continue;
  }
  // Only game source. The rule's own definition lives in this file, and
  // vendored three.js is not ours to lint.
  if (!rel.startsWith('src')) continue;
  // Comments are blanked rather than removed, so byte offsets — and therefore
  // reported line numbers — still line up with the real file. This file and
  // models.js both *describe* the bug in prose, and a linter that flags its own
  // documentation is a linter people turn off.
  const code = stripComments(src);
  for (const lint of LINTS) {
    lint.re.lastIndex = 0;
    let m;
    while ((m = lint.re.exec(code)) !== null) {
      const line = code.slice(0, m.index).split('\n').length;
      lintHits++;
      console.error(`✗ ${rel}:${line}\n  ${lint.message}`);
    }
  }
}

if (failed) console.log(`\n${failed} file(s) failed to parse.`);
else if (lintHits) console.log(`\n${files.length} modules parsed cleanly, ${lintHits} lint problem(s).`);
else console.log(`✓ ${files.length} modules parsed cleanly, no lint problems.`);
process.exit(failed || lintHits ? 1 : 0);
