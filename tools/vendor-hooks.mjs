/**
 * Resolve hook: the bare specifiers the browser's importmap serves.
 *
 * The game names three.js and its addons the way the importmap in `index.html`
 * does, which is the right answer for a browser and no answer at all for Node.
 * Anything added to the importmap has to be mirrored here or headless tooling
 * stops being able to import the modules it is meant to check.
 */
const vendor = (file) => new URL(`../vendor/${file}`, import.meta.url).href;

const MAP = {
  three: vendor('three.module.js'),
  'three/addons/loaders/GLTFLoader.js': vendor('GLTFLoader.js'),
};

export function resolve(specifier, context, nextResolve) {
  const hit = MAP[specifier];
  if (hit) return { url: hit, shortCircuit: true };
  return nextResolve(specifier, context);
}
