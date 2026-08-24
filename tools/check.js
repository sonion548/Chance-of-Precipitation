#!/usr/bin/env node
// Parses every source module so syntax errors surface without a browser.
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

const files = await walk(ROOT);
let failed = 0;
for (const f of files) {
  const src = await readFile(f, 'utf8');
  try {
    new vm.SourceTextModule(src, { identifier: f });
  } catch (err) {
    failed++;
    console.error(`✗ ${f.replace(ROOT + '/', '')}\n  ${err.message}`);
  }
}
console.log(failed ? `\n${failed} file(s) failed to parse.` : `✓ ${files.length} modules parsed cleanly.`);
process.exit(failed ? 1 : 0);
