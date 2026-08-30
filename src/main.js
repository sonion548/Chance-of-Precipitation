import { Game } from './game.js';
import { preloadAuthoredModels } from './entities/authoredRig.js';

/** Entry point: boots the engine, then hands control to the main menu. */
function boot() {
  const container = document.getElementById('viewport');
  const game = new Game(container);

  // Expose for debugging in the console; harmless in production.
  window.game = game;

  /* Authored meshes are fetched before the menu opens.
   *
   * `buildPlayerModel` is called synchronously from three different places —
   * the player, a remote player joining, and a remote player switching
   * character — and making all of them async to accommodate a file load would
   * push promises through half the codebase. Loading up front instead keeps
   * every one of those call sites unchanged, and a file that fails to arrive
   * simply leaves that character on its procedural body. */
  preloadAuthoredModels()
    .catch((err) => console.warn('authored models unavailable', err))
    .finally(() => requestAnimationFrame(() => game.start()));
}

try {
  boot();
} catch (err) {
  const box = document.getElementById('fatal');
  box.classList.remove('hidden');
  document.getElementById('fatal-msg').textContent = err.stack || String(err);
  console.error(err);
}
