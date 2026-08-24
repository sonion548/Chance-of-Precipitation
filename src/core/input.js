/**
 * True when a key event belongs to something the player is typing into.
 *
 * The game listens on `window`, so every keystroke aimed at the lobby-code box
 * or the name field arrives here too. Swallowing gameplay keys there is how
 * "WASD does not type" happens: the movement keys register as movement, some of
 * the bound keys have their default prevented, and the character never reaches
 * the field. Text input wins, always — it is unambiguous about who the player
 * is talking to.
 */
export function isTextTarget(target) {
  const el = target;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag !== 'input') return false;
  // Checkboxes, radios and buttons are not typed into; everything else is.
  const type = (el.type || 'text').toLowerCase();
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
}

/** Keyboard + mouse with pointer lock. Exposes edge-triggered and held state. */
export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.pressed = new Set();     // consumed each frame
    this.released = new Set();
    this.mouse = { dx: 0, dy: 0, left: false, right: false, leftPressed: false, rightPressed: false, leftReleased: false, rightReleased: false, wheel: 0 };
    this.locked = false;
    this.everLocked = false;
    this.sensitivityScale = 1;
    this.enabled = true;
    this._bind();
  }

  _bind() {
    const kd = (e) => {
      if (!this.enabled) return;
      // Typing into a field is not input to the game — do not read it, and do
      // not preventDefault it, or the character never lands in the box.
      if (isTextTarget(e.target)) { this.keys.clear(); return; }
      if (e.repeat) return;
      const c = e.code;
      this.keys.add(c);
      this.pressed.add(c);
      // Stop the browser from scrolling / activating on gameplay keys.
      if (['Space', 'Tab', 'KeyE', 'KeyR', 'KeyQ', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(c)) e.preventDefault();
    };
    const ku = (e) => {
      if (isTextTarget(e.target)) return;
      this.keys.delete(e.code);
      this.released.add(e.code);
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.left = this.mouse.right = false; });
    // Clicking into a field mid-stride would otherwise leave that key held down
    // forever, because the keyup lands on the field and never reaches us.
    document.addEventListener('focusin', (e) => { if (isTextTarget(e.target)) this.keys.clear(); });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      if (this.locked) { this.everLocked = true; return; }
      this.mouse.left = this.mouse.right = false;
      this.onUnlock?.();
    });
    document.addEventListener('pointerlockerror', () => { this.locked = false; });

    this.dom.addEventListener('mousedown', (e) => {
      if (!this.locked || !this.enabled) return;
      if (e.button === 0) { this.mouse.left = true; this.mouse.leftPressed = true; }
      if (e.button === 2) { this.mouse.right = true; this.mouse.rightPressed = true; }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) { this.mouse.left = false; this.mouse.leftReleased = true; }
      if (e.button === 2) { this.mouse.right = false; this.mouse.rightReleased = true; }
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    });
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());
    this.dom.addEventListener('wheel', (e) => { if (this.locked) { this.mouse.wheel += Math.sign(e.deltaY); e.preventDefault(); } }, { passive: false });
  }

  requestLock() {
    if (this.locked) return;
    // Modern browsers return a promise here, and it rejects in contexts that
    // cannot take the lock at all — embedded frames, some kiosk shells. That is
    // already handled (the game keeps playing unlocked); swallow the rejection
    // so it does not fill the console with unhandled errors.
    const result = this.dom.requestPointerLock?.();
    if (result && typeof result.catch === 'function') result.catch(() => {});
  }
  exitLock() {
    if (this.locked) document.exitPointerLock?.();
  }

  down(code) { return this.keys.has(code); }
  anyDown(...codes) { return codes.some((c) => this.keys.has(c)); }
  justPressed(code) { return this.pressed.has(code); }
  justReleased(code) { return this.released.has(code); }

  /** Movement vector in local space: x = strafe, y = forward. */
  moveAxis() {
    let x = 0, y = 0;
    if (this.anyDown('KeyW', 'ArrowUp')) y += 1;
    if (this.anyDown('KeyS', 'ArrowDown')) y -= 1;
    if (this.anyDown('KeyD', 'ArrowRight')) x += 1;
    if (this.anyDown('KeyA', 'ArrowLeft')) x -= 1;
    const len = Math.hypot(x, y);
    return len > 1 ? { x: x / len, y: y / len } : { x, y };
  }

  /** Call once at the end of each frame. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.wheel = 0;
    this.mouse.leftPressed = this.mouse.rightPressed = false;
    this.mouse.leftReleased = this.mouse.rightReleased = false;
  }
}
