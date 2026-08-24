import { Game } from './game.js';

/** Entry point: boots the engine, then hands control to the main menu. */
function boot() {
  const container = document.getElementById('viewport');
  const game = new Game(container);

  // Expose for debugging in the console; harmless in production.
  window.game = game;

  // Let the first frame render before dropping the loading screen.
  requestAnimationFrame(() => {
    game.start();
  });
}

try {
  boot();
} catch (err) {
  const box = document.getElementById('fatal');
  box.classList.remove('hidden');
  document.getElementById('fatal-msg').textContent = err.stack || String(err);
  console.error(err);
}
