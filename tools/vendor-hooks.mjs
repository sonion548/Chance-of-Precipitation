/** Resolve hook: the bare specifier `three` means the vendored build. */
const THREE = new URL('../vendor/three.module.js', import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'three') return { url: THREE, shortCircuit: true };
  return nextResolve(specifier, context);
}
