/**
 * Makes `import ... from 'three'` work outside the browser.
 *
 * The game resolves that bare specifier through the importmap in `index.html`,
 * which is the right answer for the browser and no answer at all for Node. This
 * registers a resolve hook that points it at the vendored build, so headless
 * tools can import game modules without an `npm install` and without the game
 * having to know a second way to name three.js.
 *
 * Use it as `node --import ./tools/vendor-resolve.mjs <script>`.
 */
import { register } from 'node:module';

if (typeof register !== 'function') {
  console.error('This check needs Node 18.19+ or 20.6+ (module.register).');
  process.exit(1);
}

register(new URL('./vendor-hooks.mjs', import.meta.url));
